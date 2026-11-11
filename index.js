/**
 * dsh-token-quota — Host half.
 *
 * One user-set token budget, one pause point.
 *
 * The user states a quota — "this task is allowed N tokens". The guard
 * watches the session's live context usage through the harness's own
 * `tokenMeter` service (the same measurement the "context remaining"
 * indicator uses) and, BEFORE usage reaches the quota, stops the agent:
 * from `agent/pre-step` the guard no longer returns; it parks the step
 * behind a deferred and holds the loop there until the user answers the
 * dialog the client half shows:
 *
 *   - continue  — the guard stays quiet until usage reaches the quota
 *     itself, so letting the task go spends the remaining budget without
 *     re-asking on every step;
 *   - set quota — the quota moves (per-session override, or the plugin's
 *     default when the request addresses the default) and the step goes on;
 *   - stop      — an explanatory user-role message is spliced into the
 *     session log so the record says why, and the pending step is
 *     rejected, which ends the turn. The user's next input is the "further
 *     instruction" the stop waits for.
 *
 * Two thresholds live in the configuration, and BOTH are required — the
 * plugin presets no default values, so until they are written (Settings,
 * profile patch, or the composer chip) the guard is completely inert:
 *
 *   - `quota`       — the budget itself, in tokens;
 *   - `warnPercent` — how close usage must be to the quota before the
 *                     dialog appears, 1–100.
 *
 * Both are read live: they are `.volatile()` Config fields, so Settings →
 * Plugins → dsh-token-quota edits the same values this half enforces, and
 * a per-session override (written from the composer chip) lives in
 * `$DSH_HOME/token-quota/sessions.json` — per-session runtime state keyed
 * by an open-ended id set does not belong in the profile patch.
 *
 * Everything degrades: a measurement that throws, a missing service, or a
 * store that cannot be written never breaks the agent loop — the guard
 * logs and stands down for that step.
 *
 * The client half (lib/client.js) renders the budget chip under the
 * composer (`conversation.composer.dock`) and the warning dialog in the
 * frame-wide overlay (`shell.overlay`); both read and write through the
 * same small HTTP route (`GET/POST /token-quota`), which keeps the
 * settings RPC surface out of the plugin.
 *
 * Dependencies: no versioned `@deepseek-ai/dsh-*` package is imported, so
 * the manifest carries no host-version range a newer DSH can fall outside
 * of. Only the public `webServer` (the control route) and `tokenMeter`
 * (the measurement) are required services.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name (also the bundle row id and the entry id). */
export const name = "dsh-token-quota";

/**
 * Required services: the public `webServer` the control route is registered
 * on, and the harness `tokenMeter` the measurement goes through. Without
 * either the guard cannot do its job, so the plugin stays unmounted rather
 * than half-active.
 */
export const inject = ["webServer", "tokenMeter"];

/** Field name of the quota inside the plugin's own configuration. */
export const QUOTA_FIELD = "quota";
/** Field name of the warn percentage inside the plugin's own configuration. */
export const WARN_PERCENT_FIELD = "warnPercent";

/**
 * No shipped defaults: the guard is inert until the user sets values.
 * (DEFAULT_* constants were removed on the user's request — nothing is
 * preset; see the Config block below.)
 */
/** Warn-percent window, enforced wherever a value enters the system. */
export const MIN_WARN_PERCENT = 1;
export const MAX_WARN_PERCENT = 100;

/**
 * The plugin's own configuration.
 *
 * Neither field carries a default. The user asked for no preset values:
 * the guard stays inert (nothing is watched, nothing is enforced) until
 * a quota and a warn percent are explicitly written — from Settings, the
 * profile patch, or the composer chip.
 *
 * Schemastery's number has no range modifiers; the service-level clamps
 * (rounding and the warnPercent 1–100 window) are applied where the
 * values are read or written, so a hand-edited 137% degrades to 100%
 * instead of breaking the guard.
 *
 * Both fields are marked `.volatile()` wherever schemastery supports it:
 * the loader then keeps this plugin mounted and updates the reference in
 * place when the profile patch changes, which is what lets the settings
 * page write the values and this half observe them live.
 */
const quotaField = z.number().description("本会话的 token 预算（必填，无默认值）。Token budget for the session; no default — set it to arm the guard.");
const warnPercentField = z.number().description("达到限额的百分之几时弹窗暂停（1–100，必填，无默认值）。Percent of the quota that trips the pause (1–100); no default.");
export const Config = z.object({
	[QUOTA_FIELD]: typeof quotaField.volatile === "function" ? quotaField.volatile() : quotaField,
	[WARN_PERCENT_FIELD]: typeof warnPercentField.volatile === "function" ? warnPercentField.volatile() : warnPercentField
});

/** Control route path served by this plugin. */
export const ROUTE_PATH = "/token-quota";

/** Directory under the DSH home that holds this plugin's own state. */
export const SESSION_STORE_DIR = "token-quota";
/** File inside {@link SESSION_STORE_DIR} holding the per-session overrides. */
export const SESSION_STORE_FILE = "sessions.json";
/** Format version of the session store document. */
export const SESSION_STORE_VERSION = 1;

/**
 * Session addresses this route and the store refuse. A session id becomes
 * the KEY of an entry in the override map, and these three are the keys
 * whose assignment rewrites a prototype instead of creating an entry.
 */
export const RESERVED_SESSION_KEYS = ["__proto__", "constructor", "prototype"];

/** Actions a pending pause can be settled with. */
export const ACTION_CONTINUE = "continue";
export const ACTION_STOP = "stop";
const ACTION_SET = "set";
const ACTIONS = [ACTION_CONTINUE, ACTION_STOP, ACTION_SET];

/**
 * Producer kind this plugin stamps on the messages it injects: DSH's
 * session format admits a producer-owned source kind, which is the same
 * convention first-party producers use, and it reads the exported plugin
 * name so the two cannot drift apart.
 */
export const MESSAGE_SOURCE = Object.freeze({ kind: name });

/**
 * Deep-freeze an object graph in place, cycle-safe: a message handed to
 * `agent.inject()` is committed to the session log as an immutable
 * snapshot.
 * @param value - the value to freeze.
 * @returns the same value.
 */
export function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	const seen = new WeakSet();
	const pending = [value];
	while (pending.length > 0) {
		const node = pending.pop();
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		for (const key of Object.keys(node)) pending.push(node[key]);
	}
	return value;
}

/**
 * Build one identified, immutable user-role message: reproduced here so
 * the plugin declares and resolves no versioned harness package.
 * @param input - the message content and its producer-owned source tag.
 * @returns a frozen user message with a fresh identity.
 */
export function createUserMessage(input) {
	return deepFreeze({
		...structuredClone(input),
		id: randomUUID(),
		role: "user"
	});
}

/** Format a token count for a human ("12.3k"). */
export function formatTokens(value) {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
	if (n < 1000) return String(Math.round(n));
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

/**
 * The session an agent belongs to.
 * @param agent - an Agent, or anything carrying one.
 * @returns the session id, or undefined when it cannot be read.
 */
export function sessionIdOf(agent) {
	if (agent === null || typeof agent !== "object") return undefined;
	const session = agent.session;
	if (session !== null && typeof session === "object" && typeof session.id === "string" && session.id.length > 0) return session.id;
	if (typeof agent.id === "string" && agent.id.length > 0) return agent.id;
	return undefined;
}

/**
 * Whether an address names a session this route may write.
 * @param value - the raw `session` query parameter.
 * @returns true when the value can key an override entry.
 */
export function isSessionAddress(value) {
	return typeof value === "string" && value.length > 0 && !RESERVED_SESSION_KEYS.includes(value);
}

/**
 * Keep only the entries of an override map this plugin can store and use.
 * @param value - any parsed `sessions` value.
 * @returns a fresh map with reserved keys and invalid values dropped.
 */
export function sanitizeSessions(value) {
	const out = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, entry] of Object.entries(value)) {
		if (!isSessionAddress(key)) continue;
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const clean = {};
		if (typeof entry.quota === "number" && Number.isFinite(entry.quota) && entry.quota >= 0) clean.quota = entry.quota;
		if (typeof entry.warnPercent === "number"
			&& Number.isFinite(entry.warnPercent)
			&& entry.warnPercent >= MIN_WARN_PERCENT && entry.warnPercent <= MAX_WARN_PERCENT) {
			clean.warnPercent = entry.warnPercent;
		}
		if (Object.keys(clean).length > 0) out[key] = clean;
	}
	return out;
}

/**
 * Parse a {@link SESSION_STORE_FILE} document.
 * @param text - raw file contents.
 * @returns the override map, or null when the document is not a JSON object.
 */
export function parseSessionStore(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const sessions = parsed.sessions !== null && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)
		? parsed.sessions
		: parsed;
	return sanitizeSessions(sessions);
}

/**
 * Absolute path of this plugin's session store.
 *
 * The app-boot `dshHomePath` service is the harness's own resolver and is
 * used when composed; otherwise the documented precedence is repeated here
 * (`$DSH_HOME`, then `~/.dsh`).
 * @param ctx - plugin context.
 * @returns the absolute path of the store file.
 */
export function sessionStorePath(ctx) {
	const homePath = ctx !== undefined && ctx !== null && typeof ctx.get === "function" ? ctx.get("dshHomePath") : undefined;
	if (typeof homePath === "function") {
		try {
			return homePath(SESSION_STORE_DIR, SESSION_STORE_FILE);
		} catch {
			// fall through to the documented default
		}
	}
	const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
	const home = configured.length > 0 ? configured : join(homedir(), ".dsh");
	return join(home, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

/** Whether an HTTP request arrives from a loopback authority. */
function isLoopbackRequest(req) {
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	try {
		const hostname = new URL(`http://${host}`).hostname;
		if (hostname === "localhost" || hostname === "[::1]") return true;
		const parts = hostname.split(".");
		return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
	} catch {
		return false;
	}
}

/** Read the full request body (bounded). */
function readBody(req, maxBytes = 65536) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > maxBytes) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * The per-session override map, backed by {@link sessionStorePath}.
 *
 * Reads are synchronous and lazily load the file once, because the
 * pre-step gate resolves its values inside a waterfall and must never
 * await I/O there. Writes are atomic — temporary file plus rename.
 * @param ctx - plugin context, for the home path.
 * @returns the store's read/write face.
 */
function createSessionOverrides(ctx) {
	let path = null;
	let loaded = false;
	let overrides = {};
	function storePath() {
		if (path === null) path = sessionStorePath(ctx);
		return path;
	}
	function persist() {
		const target = storePath();
		const temporary = `${target}.${process.pid}.tmp`;
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(temporary, `${JSON.stringify({ version: SESSION_STORE_VERSION, sessions: overrides }, null, 2)}\n`, "utf8");
			renameSync(temporary, target);
			return true;
		} catch (err) {
			console.error("[dsh-token-quota] writing the session store failed:", err);
			try {
				unlinkSync(temporary);
			} catch {
				// the temporary file may never have been created
			}
			return false;
		}
	}
	return {
		entries() {
			if (!loaded) {
				loaded = true;
				try {
					const parsed = parseSessionStore(readFileSync(storePath(), "utf8"));
					if (parsed !== null) overrides = parsed;
				} catch (err) {
					// An unreadable or absent store starts empty; the first
					// override write recreates the file.
					if (err?.code !== "ENOENT") console.error("[dsh-token-quota] reading the session store failed:", err);
				}
			}
			return overrides;
		},
		set(sessionId, entry) {
			if (!isSessionAddress(sessionId)) return false;
			const map = this.entries();
			map[sessionId] = entry;
			return persist();
		},
		clear(sessionId) {
			if (!isSessionAddress(sessionId)) return false;
			const map = this.entries();
			if (!(sessionId in map)) return true;
			delete map[sessionId];
			return persist();
		}
	};
}

/** One pending pause: what the dialog needs to show, and how it resolves. */
class PendingPause {
	constructor({ sessionId, usage, quota, warnPercent }) {
		this.sessionId = sessionId;
		this.usage = usage;
		this.quota = quota;
		this.warnPercent = warnPercent;
		/** The threshold that tripped the guard, for the dialog's copy. */
		this.threshold = Math.min(quota, Math.max(1, Math.round(quota * warnPercent / 100)));
		this.percent = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
		this.at = Date.now();
		this.done = false;
		/** Settled with an action: { kind, quota? }. */
		this.promise = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}
	settle(action) {
		if (this.done) return false;
		this.done = true;
		this.resolve(action);
		return true;
	}
}

export function apply(ctx, config) {
	const initial = config !== null && typeof config === "object" ? config : {};

	/**
	 * Live config references (DSH 0.1.7+): a `.volatile()` field arrives as
	 * a reference with `get()`; an ordinary value means the harness has no
	 * such projection and the plain config value is the source instead.
	 */
	const liveQuota = initial[QUOTA_FIELD] !== null && typeof initial[QUOTA_FIELD] === "object" && typeof initial[QUOTA_FIELD].get === "function"
		? initial[QUOTA_FIELD]
		: null;
	const liveWarnPercent = initial[WARN_PERCENT_FIELD] !== null && typeof initial[WARN_PERCENT_FIELD] === "object" && typeof initial[WARN_PERCENT_FIELD].get === "function"
		? initial[WARN_PERCENT_FIELD]
		: null;
	const declaredQuota = typeof initial[QUOTA_FIELD] === "number" && Number.isFinite(initial[QUOTA_FIELD]) ? initial[QUOTA_FIELD] : undefined;
	const declaredWarnPercent = typeof initial[WARN_PERCENT_FIELD] === "number" && Number.isFinite(initial[WARN_PERCENT_FIELD]) ? initial[WARN_PERCENT_FIELD] : undefined;

	/** Per-session overrides: { sessionId: { quota?, warnPercent? } }. */
	const overrides = createSessionOverrides(ctx);
	/** One pending pause per session, keyed by session id. */
	const pendings = new Map();
	/**
	 * The usage level below which a session's crossing is already settled:
	 *
	 *   - after "continue" the quota itself — the user told the guard to
	 *     let the turn spend the remaining budget, so the dialog reappears
	 *     only at the limit, not on every following step;
	 *   - after "stop" or a quota raise, the current usage — a fresh budget
	 *     state, so the next crossing is the next time usage actually
	 *     grows past the effective threshold.
	 */
	const suppressedUntil = new Map();
	/** Latest measured usage per session, for the control route's GET. */
	const lastUsage = new Map();

	/**
	 * The plugin's default quota in force, or `undefined` when nobody has
	 * ever set one (no preset default exists).
	 */
	function readDefaultQuota() {
		if (liveQuota !== null) {
			const value = liveQuota.get();
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
		}
		return declaredQuota;
	}

	/**
	 * The plugin's default warn percentage in force, or `undefined` when
	 * nobody has ever set one (no preset default exists).
	 */
	function readDefaultWarnPercent() {
		if (liveWarnPercent !== null) {
			const value = liveWarnPercent.get();
			return typeof value === "number" && Number.isFinite(value) && value >= MIN_WARN_PERCENT && value <= MAX_WARN_PERCENT
				? value
				: undefined;
		}
		return declaredWarnPercent;
	}

	/**
	 * One session's effective settings: its own override first, then the
	 * configured defaults. The guard is enabled only when BOTH a positive
	 * quota and a warn percent are in force — with no preset defaults,
	 * an unconfigured plugin (or an unconfigured session) is inert.
	 * @param sessionId - the session id, when known.
	 * @returns `{ quota, warnPercent, enabled, overridden }` where quota
	 * and warnPercent may be `undefined`.
	 */
	function effective(sessionId) {
		const entry = typeof sessionId === "string" && sessionId.length > 0 ? overrides.entries()[sessionId] : undefined;
		const defaultQuota = readDefaultQuota();
		const defaultWarnPercent = readDefaultWarnPercent();
		const quota = typeof entry?.quota === "number" && entry.quota >= 0 ? entry.quota : defaultQuota;
		const warnPercent = typeof entry?.warnPercent === "number"
			&& entry.warnPercent >= MIN_WARN_PERCENT && entry.warnPercent <= MAX_WARN_PERCENT
			? entry.warnPercent
			: defaultWarnPercent;
		return {
			quota,
			warnPercent,
			enabled: typeof quota === "number" && quota > 0 && typeof warnPercent === "number",
			overridden: entry !== undefined
		};
	}

	/** Persist a quota write the way the request addressed it. */
	function persistQuota(sessionId, quota) {
		if (sessionId === null) {
			return writeDefault(ctx, QUOTA_FIELD, Math.max(0, Math.round(quota)));
		}
		if (quota === null) return overrides.clear(sessionId);
		const map = overrides.entries();
		const previous = map[sessionId] ?? {};
		return overrides.set(sessionId, { ...previous, quota: Math.max(0, Math.round(quota)) });
	}

	/** Persist a warnPercent write the way the request addressed it. */
	function persistWarnPercent(sessionId, warnPercent) {
		const clamped = Math.min(MAX_WARN_PERCENT, Math.max(MIN_WARN_PERCENT, Math.round(warnPercent)));
		if (sessionId === null) {
			return writeDefault(ctx, WARN_PERCENT_FIELD, clamped);
		}
		if (warnPercent === null) return overrides.clear(sessionId);
		const map = overrides.entries();
		const previous = map[sessionId] ?? {};
		return overrides.set(sessionId, { ...previous, warnPercent: clamped });
	}

	/**
	 * Measure one session's current context usage, never throwing: the
	 * guard degrades to "unknown" rather than breaking the step.
	 * @param session - a live Session.
	 * @returns the token count, or null when it cannot be measured.
	 */
	function usageOf(session) {
		const meter = ctx.tokenMeter;
		if (meter === null || meter === undefined || typeof meter.measure !== "function") return null;
		try {
			const measurement = meter.measure(session);
			const total = measurement?.totalTokens;
			return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : 0;
		} catch (err) {
			console.error("[dsh-token-quota] measuring the session failed:", err);
			return null;
		}
	}

	/** A live Session by id, when the sessions service is composed. */
	function sessionOf(sessionId) {
		if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
		const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
		if (sessions === undefined || sessions === null) return undefined;
		try {
			if (typeof sessions.get === "function") return sessions.get(sessionId) ?? undefined;
			if (typeof sessions.list === "function") {
				for (const session of sessions.list()) {
					if (session !== null && typeof session === "object" && session.id === sessionId) return session;
				}
			}
		} catch {
			// an unreadable store degrades to "unknown"
		}
		return undefined;
	}

	/** Serialize one pending pause for the client half. */
	function pendingRecord(pending) {
		return {
			session: pending.sessionId,
			usage: pending.usage,
			quota: pending.quota,
			warnPercent: pending.warnPercent,
			threshold: pending.threshold,
			percent: pending.percent,
			at: pending.at
		};
	}

	/** What the control route answers for one session (or the defaults). */
	function answer(sessionId) {
		const settings = effective(sessionId);
		let usage = null;
		if (sessionId !== null) {
			const session = sessionOf(sessionId);
			if (session !== undefined) usage = usageOf(session);
			if (usage === null) usage = lastUsage.get(sessionId) ?? null;
		}
		const pending = sessionId !== null ? pendings.get(sessionId) : undefined;
		const quota = typeof settings.quota === "number" ? settings.quota : null;
		const warnPercent = typeof settings.warnPercent === "number" ? settings.warnPercent : null;
		return {
			ok: true,
			enabled: settings.enabled,
			quota,
			warnPercent,
			overridden: settings.overridden,
			usage,
			usageText: usage === null ? null : formatTokens(usage),
			quotaText: quota === null ? null : formatTokens(quota),
			pending: pending ? pendingRecord(pending) : null,
			...(sessionId !== null ? { session: sessionId } : {})
		};
	}

	/**
	 * Settle one session's pending pause, if any, with an action.
	 * @returns the settled record, or null when nothing was pending.
	 */
	function settle(sessionId, action) {
		const pending = sessionId !== null ? pendings.get(sessionId) : undefined;
		if (pending === undefined) return null;
		if (!pending.settle(action)) return null;
		pendings.delete(sessionId);
		return pendingRecord(pending);
	}

	/** Every live agent whose session matches an id, for stop notices. */
	function agentsOf(sessionId) {
		const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
		if (!agents || typeof agents.list !== "function") return [];
		try {
			return agents.list().filter((agent) => agent && sessionIdOf(agent) === sessionId);
		} catch {
			return [];
		}
	}

	/**
	 * The pause point. Registered on the plugin's own context so it holds
	 * for every session; the decisions it makes are per-session through
	 * `pending.sessionId`.
	 *
	 * The base decision is awaited first so the waterfall stays intact
	 * (downstream listeners already ran); the guard then either returns it
	 * unchanged, or holds it while the user answers the dialog, or rejects
	 * the step when the user chose to stop.
	 */
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		try {
			const agent = payload?.agent;
			const sessionId = sessionIdOf(agent);
			if (sessionId === undefined) return decision;
			const settings = effective(sessionId);
			if (!settings.enabled) return decision;
			const session = agent?.session ?? sessionOf(sessionId);
			if (session === undefined || session === null) return decision;
			const usage = usageOf(session);
			if (usage === null) return decision;
			lastUsage.set(sessionId, usage);

			const threshold = Math.min(settings.quota, Math.max(1, Math.round(settings.quota * settings.warnPercent / 100)));
			if (usage < threshold) return decision;
			// One crossing, one dialog: a pause the user settled does not
			// re-arm below the suppressed level their choice established.
			const suppressed = suppressedUntil.get(sessionId) ?? 0;
			if (usage <= suppressed) return decision;

			// A pause already parked for this session — the loop is blocked
			// on this very promise, so this branch is only reachable from
			// a follow-up step racing the first; settle on the same wait.
			let pending = pendings.get(sessionId);
			if (pending === undefined) {
				pending = new PendingPause({ sessionId, usage, quota: settings.quota, warnPercent: settings.warnPercent });
				pendings.set(sessionId, pending);
				console.log(`[dsh-token-quota] pausing ${sessionId}: ${formatTokens(usage)} / ${formatTokens(settings.quota)} tokens (${pending.percent}%)`);
			}

			// The user's stop button (or a session archive) aborts the
			// step: the wait ends the same way a stop would, without
			// settling the dialog twice. The listener is removed when the
			// wait ends so a signal that never aborts keeps nothing alive.
			const signal = payload?.signal;
			let onAbort = null;
			const aborted = new Promise((resolve) => {
				if (!signal) return;
				if (signal.aborted) {
					resolve({ kind: ACTION_STOP, reason: "aborted" });
					return;
				}
				onAbort = () => resolve({ kind: ACTION_STOP, reason: "aborted" });
				signal.addEventListener("abort", onAbort, { once: true });
			});
			let action = null;
			try {
				action = await Promise.race([pending.promise, aborted]);
			} finally {
				if (onAbort !== null && signal && !signal.aborted) {
					try {
						signal.removeEventListener("abort", onAbort);
					} catch {
						// removal is best-effort
					}
				}
				// The wait is over one way or another: never leave a
				// resolved pause in the map, or the UI would keep showing
				// a dialog whose step has already settled.
				pendings.delete(sessionId);
			}
			if (action?.kind === ACTION_CONTINUE) {
				// Let the turn spend the remaining budget: the dialog
				// returns at the limit, not at every following step.
				suppressedUntil.set(sessionId, settings.quota);
				return decision;
			}
			if (action?.kind === ACTION_SET) {
				const nextQuota = typeof action.quota === "number" && Number.isFinite(action.quota) && action.quota > 0
					? action.quota
					: settings.quota;
				persistQuota(sessionId, nextQuota);
				suppressedUntil.set(sessionId, usage);
				console.log(`[dsh-token-quota] quota raised for ${sessionId}: ${formatTokens(nextQuota)}`);
				return decision;
			}
			// stop: say why in the durable log, then end the turn.
			suppressedUntil.set(sessionId, usage);
			const text = `Token 限额警戒：本会话上下文已用约 ${formatTokens(usage)} token，达到你设置的限额 ${formatTokens(settings.quota)}（${pending.percent}%），用户选择停止当前任务。等待用户的下一步指示。`;
			for (const agentOfSession of agentsOf(sessionId)) {
				try {
					agentOfSession.inject(createUserMessage({
						content: [{ type: "text", text }],
						source: MESSAGE_SOURCE
					}));
				} catch (err) {
					console.error("[dsh-token-quota] injecting the stop notice failed:", err);
				}
			}
			console.log(`[dsh-token-quota] stopped ${sessionId} at the quota`);
			return { kind: "reject" };
		} catch (err) {
			console.error("[dsh-token-quota] pre-step gate error:", err);
		}
		return decision;
	});

	/**
	 * A session whose agent leaves the registry settles any pending pause
	 * as a stop: nothing is left hanging on an agent that cannot run.
	 */
	ctx.on("agent/disposed", (payload) => {
		try {
			const sessionId = sessionIdOf(payload?.agent ?? payload);
			if (sessionId !== undefined) settle(sessionId, { kind: ACTION_STOP, reason: "agent-disposed" });
		} catch (err) {
			console.error("[dsh-token-quota] agent/disposed error:", err);
		}
	});

	/**
	 * The control route. The ADDRESS says what is read or written — the
	 * defaults, or one session's own values — and the body carries only the
	 * change:
	 *
	 * GET  /token-quota            -> the defaults and no pending pause
	 * GET  /token-quota?session=   -> that session's effective settings, live usage, pending pause
	 * POST /token-quota            -> change a default (quota / warnPercent)
	 * POST /token-quota?session=   -> change that session's override, or
	 *                                 settle its pending pause with an action
	 *
	 * Loopback-only (same trust posture as the /api fence).
	 */
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const writeJson = (status, body) => {
				const text = JSON.stringify(body);
				res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				res.end(text);
			};
			if (!isLoopbackRequest(req)) {
				writeJson(403, { ok: false, error: "forbidden" });
				return;
			}
			let session = null;
			try {
				const addressed = new URL(req.url ?? ROUTE_PATH, "http://localhost").searchParams.get("session");
				if (addressed !== null && addressed.length > 0) {
					if (!isSessionAddress(addressed)) {
						writeJson(400, { ok: false, error: "invalid-session" });
						return;
					}
					session = addressed;
				}
			} catch {
				session = null;
			}

			if (req.method === "GET") {
				writeJson(200, answer(session));
				return;
			}
			if (req.method !== "POST") {
				writeJson(405, { ok: false, error: "method-not-allowed" });
				return;
			}
			let parsed;
			try {
				const body = await readBody(req);
				parsed = body.length === 0 ? {} : JSON.parse(body);
			} catch {
				writeJson(400, { ok: false, error: "bad-json" });
				return;
			}
			const fields = parsed !== null && typeof parsed === "object" ? parsed : {};

			// Settling a pending pause: the action resolves the held step.
			const action = typeof fields.action === "string" && ACTIONS.includes(fields.action) ? fields.action : undefined;
			if (action === ACTION_CONTINUE || action === ACTION_STOP) {
				const settled = settle(session, action === ACTION_CONTINUE ? { kind: ACTION_CONTINUE } : { kind: ACTION_STOP, reason: "user" });
				if (settled === null) {
					writeJson(404, { ok: false, error: "no-pending-pause", ...(session === null ? {} : { session }) });
					return;
				}
				writeJson(200, { ok: true, action, pending: settled, ...(session === null ? {} : { session }) });
				return;
			}
			if (action === ACTION_SET) {
				const quota = Number(fields.quota);
				if (!Number.isFinite(quota) || quota <= 0) {
					writeJson(400, { ok: false, error: "invalid-quota", quota: fields.quota });
					return;
				}
				// A pending pause settled by raising its quota: the held
				// step continues under the new budget.
				const settled = settle(session, { kind: ACTION_SET, quota });
				persistQuota(session, quota);
				writeJson(200, {
					ok: true,
					action: ACTION_SET,
					quota,
					pending: settled,
					...(session === null ? {} : { session })
				});
				return;
			}

			// Plain settings writes (no action): quota and warnPercent.
			let wrote = null;
			if (fields.quota !== undefined) {
				if (fields.quota === null) {
					wrote = persistQuota(session, null);
				} else {
					const quota = Number(fields.quota);
					if (!Number.isFinite(quota) || quota < 0) {
						writeJson(400, { ok: false, error: "invalid-quota", quota: fields.quota });
						return;
					}
					wrote = persistQuota(session, quota);
				}
			}
			if (fields.warnPercent !== undefined) {
				if (fields.warnPercent === null) {
					wrote = persistWarnPercent(session, null) && (wrote ?? true);
				} else {
					const warnPercent = Number(fields.warnPercent);
					if (!Number.isFinite(warnPercent) || warnPercent < MIN_WARN_PERCENT || warnPercent > MAX_WARN_PERCENT) {
						writeJson(400, { ok: false, error: "invalid-warn-percent", warnPercent: fields.warnPercent });
						return;
					}
					wrote = persistWarnPercent(session, warnPercent) && (wrote ?? true);
				}
			}
			if (wrote === null) {
				writeJson(400, { ok: false, error: "no-fields" });
				return;
			}
			if (wrote === false) {
				writeJson(409, {
					ok: false,
					error: "not-writable",
					hint: session === null
						? "Set the defaults in Settings → Plugins → dsh-token-quota."
						: "The per-session override could not be persisted; the live value stands."
				});
				return;
			}
			// Clearing an off override re-reads the store so `answer` reflects it.
			writeJson(200, { ok: true, ...answer(session) });
		}
	}), "dsh-token-quota: control route");

	// One line at mount: it is what tells a user (and a bug report) that
	// the plugin composed on their DSH build at all, and that nothing is
	// preset — the guard is inert until values are set.
	const quotaDesc = readDefaultQuota() === undefined ? "(unset)" : formatTokens(readDefaultQuota());
	const warnDesc = readDefaultWarnPercent() === undefined ? "(unset)" : `${readDefaultWarnPercent()}%`;
	console.log(`[dsh-token-quota] loaded: quota = ${quotaDesc}, warn at ${warnDesc} — no defaults are preset`);
}

/**
 * Persist a default value into the profile patch through the config
 * editor, so the settings form and this route edit the SAME value.
 * @param ctx - plugin context.
 * @param field - one of the plugin's Config field names.
 * @param value - the new default value.
 * @returns true when the write was persisted.
 */
async function writeDefault(ctx, field, value) {
	const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
	if (editor === undefined || editor === null || typeof editor.edit !== "function" || typeof editor.entries !== "function") return false;
	let entry = null;
	try {
		for (const candidate of editor.entries()) {
			if (candidate !== null && typeof candidate === "object" && candidate.options?.id === name) {
				entry = candidate;
				break;
			}
		}
	} catch {
		return false;
	}
	if (entry === null) return false;
	try {
		await editor.edit(entry, (current) => ({ ...(current ?? {}), [field]: value }));
		return true;
	} catch (err) {
		console.error("[dsh-token-quota] writing the default failed:", err);
		return false;
	}
}
