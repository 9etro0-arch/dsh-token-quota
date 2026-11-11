/**
 * dsh-token-quota — Client half (web bundle).
 *
 * Two surfaces over one Host route:
 *
 *   - the budget chip under the composer (`conversation.composer.dock`):
 *     how much of the quota the current session has already spent, an
 *     input that sets or changes the budget, and — while the guard has
 *     paused the task — a "paused, handle it" affordance that brings the
 *     dialog back;
 *   - the warning dialog itself, registered in the frame-wide overlay
 *     (`shell.overlay`): "usage has reached your warn line, the task is
 *     paused" with the three choices — 继续 (spend the remaining budget),
 *     raise the quota and continue, or stop.
 *
 * Both read and write through the Host control route (`GET/POST
 * /token-quota`, same-origin fetch): the route keeps the settings RPC
 * surface out of the plugin.
 *
 * The `shell.overlay` seat is frame-wide, so it carries no session of its
 * own; the session-scoped chip publishes the session it renders for into
 * a small shared store the dialog reads, so the dialog always answers the
 * session the user is looking at.
 *
 * i18n: registers the "token-quota" dictionary (zh/en) with the DSH locale
 * service; slot owners inject the bound `t` via the `locale` registration
 * option, so all copy follows the DSH UI language automatically.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the
 * DSH web client module system (CJS-style factory; "react" resolves to
 * the platform seed module). No bundler is required to produce this file.
 */
window.__ModuleLoader__.load({
	id: "dsh-token-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;
		var useEffect = react.useEffect;
		var useState = react.useState;
		var useRef = react.useRef;
		var useCallback = react.useCallback;

		/** Locale dictionary namespace owned by this plugin. */
		var NS = "token-quota";
		/** Host control route (same origin as the served GUI). */
		var ROUTE_PATH = "/token-quota";
		/** Poll interval for settings and the pause state. */
		var POLL_MS = 1600;

		/* ── shared session + dismissal ──────────────────────────────
		 * The chip renders with the current session's id; the frame-wide
		 * dialog has none of its own. The chip publishes, the dialog
		 * reads — no DOM, no event on the host, just this module's state.
		 */
		var sharedSession = { id: null };
		var dismissed = { at: null, listeners: new Set() };
		/** Holds the plugin context after mount so the root-scoped dialog
		 *  can reach the locale service its registration does not bind. */
		var localeHolder = { ctx: null };

		function publishSession(id) {
			if (sharedSession.id !== id) sharedSession.id = id;
		}

		function setDismissed(at) {
			dismissed.at = at;
			for (const fn of dismissed.listeners) {
				try { fn(); } catch { /* a subscriber that throws never stops the others */ }
			}
		}

		function useDismissed() {
			var force = useState(0)[1];
			useEffect(function () {
				var fn = function () { force(function (x) { return x + 1; }); };
				dismissed.listeners.add(fn);
				return function () { dismissed.listeners.delete(fn); };
			}, []);
			return dismissed.at;
		}

		/** Chinese dictionary (also the no-locale-service fallback). */
		var zh = {
			"chip.label": "Token 限额",
			"chip.off": "未设置限额",
			"chip.usage": "{used} / {quota}",
			"chip.paused": "已暂停 · 点击处理",
			"chip.input.placeholder": "限额（token 数）",
			"chip.percent.placeholder": "警戒 %（1-100）",
			"chip.warnUnset": "未设",
			"chip.apply": "设置",
			"chip.disable": "停用",
			"chip.clear": "跟随插件配置",
			"notify.title": "Token 限额预警",
			"notify.body": "本会话上下文已用约 {used} token，达到你设置的限额 {quota} 的 {percent}%（警戒线 {threshold}）。当前任务已暂停，等待你的指示。",
			"notify.continue": "继续任务",
			"notify.continue.hint": "用完剩余额度，达到限额前不再提醒",
			"notify.raise": "提高限额并继续",
			"notify.stop": "停止任务",
			"notify.stop.hint": "结束本次任务，等你下一步指示",
			"notify.dismiss": "稍后再说",
			"notify.quota.label": "新限额"
		};

		/** English dictionary. */
		var en = {
			"chip.label": "Token quota",
			"chip.off": "no quota set",
			"chip.usage": "{used} / {quota}",
			"chip.paused": "paused · handle it",
			"chip.input.placeholder": "quota (tokens)",
			"chip.percent.placeholder": "warn % (1-100)",
			"chip.warnUnset": "unset",
			"chip.apply": "Set",
			"chip.disable": "Disable",
			"chip.clear": "Follow plugin config",
			"notify.title": "Token quota warning",
			"notify.body": "This session's context has used about {used} tokens — {percent}% of your {quota} quota (warn line {threshold}). The running task is paused, waiting for your decision.",
			"notify.continue": "Continue",
			"notify.continue.hint": "spend the remaining budget; no more warnings until the quota",
			"notify.raise": "Raise quota and continue",
			"notify.stop": "Stop the task",
			"notify.stop.hint": "ends this task and waits for your next instruction",
			"notify.dismiss": "Later",
			"notify.quota.label": "new quota"
		};

		function languageOf(t) {
			if (t && typeof t === "object" && typeof t.locale === "string") {
				var id = t.locale;
				return id === "en" || id.indexOf("en-") === 0 || id.indexOf("en_") === 0 ? "en" : "zh";
			}
			return "zh";
		}

		function fallbackT(key, params) {
			var text = zh[key] || key;
			if (params) {
				for (const name of Object.keys(params)) {
					text = text.split("{" + name + "}").join(String(params[name]));
				}
			}
			return text;
		}

		/** Format a token count the way the Host half does ("12.3k"). */
		function formatTokens(value) {
			var n = typeof value === "number" && Number.isFinite(value) ? value : 0;
			if (n < 1000) return String(Math.round(n));
			if (n < 10000) return (n / 1000).toFixed(1) + "k";
			return String(Math.round(n / 1000)) + "k";
		}

		/** Whether the Host answered a usable number (no preset values:
		 *  a plugin nobody configured answers `null`). */
		function hasValue(value) {
			return typeof value === "number" && Number.isFinite(value);
		}

		/**
		 * The Host state for one session: settings, live usage, and the
		 * pending pause (if any). Polled on an interval so the chip and
		 * the dialog follow the Host without the Host pushing.
		 */
		function useQuotaState(sessionId) {
			var state = useState({ data: null, loading: true, error: false });
			var data = state[0].data;
			var loading = state[0].loading;
			var failed = state[0].error;
			var setState = state[1];

			useEffect(function () {
				if (!sessionId) {
					setState({ data: null, loading: false, error: false });
					return undefined;
				}
				var disposed = false;
				function refresh() {
					fetch(ROUTE_PATH + "?session=" + encodeURIComponent(sessionId), {
						method: "GET",
						credentials: "same-origin",
						headers: { accept: "application/json" }
					}).then(function (res) {
						return res.ok ? res.json() : Promise.reject(new Error("http " + res.status));
					}).then(function (body) {
						if (disposed) return;
						setState({ data: body && body.ok ? body : null, loading: false, error: !(body && body.ok) });
					}).catch(function () {
						if (!disposed) setState({ data: data, loading: false, error: true });
					});
				}
				setState({ data: data, loading: true, error: false });
				refresh();
				var timer = setInterval(refresh, POLL_MS);
				return function () {
					disposed = true;
					clearInterval(timer);
				};
			}, [sessionId]);

			var post = useCallback(function (body) {
				if (!sessionId) return Promise.reject(new Error("no-session"));
				return fetch(ROUTE_PATH + "?session=" + encodeURIComponent(sessionId), {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body)
				}).then(function (res) {
					return res.ok ? res.json() : Promise.reject(new Error("http " + res.status));
				});
			}, [sessionId]);

			return { data: data, loading: loading, error: failed, post: post };
		}

		/** A gauge glyph: the "budget dial" metaphor. */
		function GaugeGlyph(props) {
			return h("svg", {
				viewBox: "0 0 24 24",
				width: props && props.size ? props.size : 14,
				height: props && props.size ? props.size : 14,
				fill: "none",
				stroke: "currentColor",
				"stroke-width": 2,
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				"aria-hidden": true,
				style: { flex: "0 0 auto", pointerEvents: "none" }
			},
				h("path", { d: "M4 18a8 8 0 1 1 16 0" }),
				h("path", { d: "M2.5 18h19" }),
				h("line", { x1: "12", y1: "18", x2: "16.2", y2: "10.6" }),
				h("circle", { cx: "12", cy: "18", r: "1.6", fill: "currentColor", stroke: "none" })
			);
		}

		/**
		 * The budget chip under the composer.
		 *
		 * Reads and writes the CURRENT SESSION's quota — setting it here
		 * never changes what the next session opens with; that is the
		 * plugin's configuration (Settings → Plugins → dsh-token-quota).
		 */
		function TokenQuotaChip(props) {
			var sessionId = props && props.sessionId ? props.sessionId : null;
			var t = props && typeof props.t === "function" ? props.t : fallbackT;
			publishSession(sessionId);

			var quotaState = useQuotaState(sessionId);
			var data = quotaState.data;
			var post = quotaState.post;

			var draft = useState("");
			var draftValue = draft[0];
			var setDraft = draft[1];
			var percentDraft = useState("");
			var percentValue = percentDraft[0];
			var setPercentValue = percentDraft[1];

			var enabled = !!(data && data.enabled);
			var usage = data && typeof data.usage === "number" ? data.usage : 0;
			var quota = data && typeof data.quota === "number" ? data.quota : 0;
			var warnPercent = data && typeof data.warnPercent === "number" ? data.warnPercent : null;
			var paused = !!(data && data.pending);
			var ratio = enabled && quota > 0 ? Math.min(1, usage / quota) : 0;

			var onApply = useCallback(function () {
				if (!sessionId || !draftValue) return;
				var value = Number(draftValue);
				if (!Number.isFinite(value) || value < 0) return;
				// Warn percent is sent only when the user typed one — no
				// preset default is ever written from this chip.
				var percent = percentValue === "" ? null : Number(percentValue);
				var body = percent === null ? { quota: value }
					: (!Number.isFinite(percent) || percent < 1 || percent > 100) ? null
					: { quota: value, warnPercent: Math.round(percent) };
				if (body === null) return;
				post(body).then(function () {
					setDraft("");
					setPercentValue("");
				}).catch(function () { /* the next poll shows the unchanged state */ });
			}, [sessionId, draftValue, percentValue, post]);

			var onDisable = useCallback(function () {
				if (!sessionId) return;
				post({ quota: 0 }).catch(function () {});
			}, [sessionId, post]);

			var onClear = useCallback(function () {
				if (!sessionId) return;
				post({ quota: null }).catch(function () {});
			}, [sessionId, post]);

			var onHandlePause = useCallback(function () {
				// The modal is dismissed per pause; reopening clears the
				// dismissal so the dialog shows again for THIS pause.
				setDismissed(null);
			}, []);

			var label = t("chip.label");
			var usedText = formatTokens(usage);
			var quotaText = formatTokens(quota);
			var summary = enabled ? t("chip.usage", { used: usedText, quota: quotaText }) : t("chip.off");
			var warnText = hasValue(warnPercent) ? warnPercent + "%" : t("chip.warnUnset");
			var title = enabled
				? languageOf(t) === "en"
					? `Token quota: ${quotaText} (warn at ${warnText}), used ${usedText}`
					: `Token 限额 ${quotaText}（警戒线 ${warnText}），已用 ${usedText}`
				: languageOf(t) === "en"
					? "Token quota: not set — set a budget and the guard pauses the task before it is reached"
					: "Token 限额未设置——设置预算后，任务在接近限额前会暂停等你处理";

			return h("div", {
				className: "dsh-token-quota-chip" + (paused ? " is-paused" : ""),
				"data-dsh-token-quota": "",
				title: title
			},
				h(GaugeGlyph, { size: 14 }),
				h("span", { className: "dsh-token-quota-chip-label" }, label),
				paused
					? h("button", {
						type: "button",
						className: "dsh-token-quota-chip-paused",
						onClick: onHandlePause,
						"aria-label": t("chip.paused")
					}, t("chip.paused"))
					: null,
				enabled && !paused
					? h("div", { className: "dsh-token-quota-chip-bar", role: "img", "aria-label": summary },
						h("div", {
							className: "dsh-token-quota-chip-bar-fill"
								+ (ratio >= 0.95 ? " is-critical" : ratio >= 0.8 ? " is-warn" : ""),
							style: { width: (Math.round(ratio * 100)).toString() + "%" }
						})
					)
					: null,
				h("span", { className: "dsh-token-quota-chip-summary" + (enabled ? "" : " is-off") }, summary),
				h("input", {
					type: "number",
					min: "0",
					step: "1000",
					placeholder: t("chip.input.placeholder"),
					value: draftValue,
					onChange: function (event) { setDraft(event.target.value); },
					onKeyDown: function (event) { if (event.key === "Enter") onApply(); },
					className: "dsh-token-quota-chip-input",
					"aria-label": t("chip.input.placeholder")
				}),
				h("input", {
					type: "number",
					min: "1",
					max: "100",
					step: "1",
					placeholder: t("chip.percent.placeholder"),
					value: percentValue,
					onChange: function (event) { setPercentValue(event.target.value); },
					onKeyDown: function (event) { if (event.key === "Enter") onApply(); },
					className: "dsh-token-quota-chip-input dsh-token-quota-chip-percent",
					"aria-label": t("chip.percent.placeholder")
				}),
				h("button", {
					type: "button",
					className: "dsh-token-quota-chip-apply",
					onClick: onApply,
					disabled: !sessionId || !draftValue
				}, t("chip.apply")),
				enabled
					? h("button", {
						type: "button",
						className: "dsh-token-quota-chip-quiet",
						onClick: onDisable,
						title: languageOf(t) === "en" ? "Disable the guard for this session" : "本会话停用警戒"
					}, t("chip.disable"))
					: null,
				enabled && data && data.overridden
					? h("button", {
						type: "button",
						className: "dsh-token-quota-chip-quiet",
						onClick: onClear,
						title: languageOf(t) === "en" ? "Follow the plugin's configured quota" : "改用插件配置的限额"
					}, t("chip.clear"))
					: null
			);
		}

		/**
		 * The warning dialog: frame-wide overlay, one card, three choices.
		 *
		 * While a pause is pending the loop is blocked on the Host side;
		 * the dialog is the ONLY thing that settles it. Dismissal (the
		 * "later" affordance, Escape, or a backdrop click) only hides the
		 * card — the task stays paused and the chip keeps saying so, and
		 * the card comes back from the chip or on its next poll.
		 */
		function TokenQuotaNotice() {
			var localeService = localeHolder.ctx ? localeHolder.ctx.locale : null;
			var sessionId = sharedSession.id;
			var quotaState = useQuotaState(sessionId);
			var data = quotaState.data;
			var post = quotaState.post;

			var dismissedAt = useDismissed();

			var raiseDraft = useState("");
			var raiseValue = raiseDraft[0];
			var setRaiseValue = raiseDraft[1];
			var busy = useState(false);
			var sending = busy[0];
			var setSending = busy[1];

			var pending = data && data.pending ? data.pending : null;
			var visible = !!(pending && dismissedAt !== pending.at);

			var onContinue = useCallback(function () {
				if (!sessionId || sending) return;
				setSending(true);
				post({ action: "continue" }).catch(function () {}).finally(function () { setSending(false); });
			}, [sessionId, post, sending]);

			var onRaise = useCallback(function () {
				if (!sessionId || sending) return;
				var value = Number(raiseValue);
				if (!Number.isFinite(value) || value <= 0) return;
				setSending(true);
				post({ action: "set", quota: value }).catch(function () {}).finally(function () { setSending(false); });
			}, [sessionId, post, sending, raiseValue]);

			var onStop = useCallback(function () {
				if (!sessionId || sending) return;
				setSending(true);
				post({ action: "stop" }).catch(function () {}).finally(function () { setSending(false); });
			}, [sessionId, post, sending]);

			// Escape dismisses the card (the pause itself stays); focus
			// returns to the document body like any DSH modal.
			useEffect(function () {
				if (!visible) return undefined;
				function onKey(event) {
					if (event.key === "Escape") setDismissed(pending.at);
				}
				window.addEventListener("keydown", onKey);
				return function () { window.removeEventListener("keydown", onKey); };
			}, [visible, pending && pending.at]);

			if (!visible || !pending) return null;

			// No bound translate (this seat renders root-scoped): use the
			// locale service directly when it is reachable.
			var dict = null;
			try {
				if (localeService && typeof localeService.getLocale === "function") {
					var snap = localeService.getLocale();
					dict = snap && snap.id === "en" ? en : zh;
				}
			} catch { /* fall back below */ }
			if (dict === null) dict = zh;
			var tt = function (key, params) {
				var text = dict[key] || key;
				if (params) {
					for (const name of Object.keys(params)) {
						text = text.split("{" + name + "}").join(String(params[name]));
					}
				}
				return text;
			};

			// The raise input starts EMPTY — no preset default value; the
			// user types the new quota they actually want.
			var effectiveRaise = raiseValue;

			return h("div", {
				className: "dsh-token-quota-notice",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": "dsh-token-quota-notice-title",
				"data-dsh-token-quota": ""
			},
				h("div", {
					className: "dsh-token-quota-notice-backdrop",
					onClick: function () { setDismissed(pending.at); }
				}),
				h("div", { className: "dsh-token-quota-notice-card" },
					h("div", { className: "dsh-token-quota-notice-head" },
						h(GaugeGlyph, { size: 20 }),
						h("h2", { id: "dsh-token-quota-notice-title", className: "dsh-token-quota-notice-title" },
							tt("notify.title"))
					),
					h("p", { className: "dsh-token-quota-notice-body" },
						tt("notify.body", {
							used: formatTokens(pending.usage),
							quota: formatTokens(pending.quota),
							percent: pending.percent,
							threshold: formatTokens(pending.threshold)
						})),
					h("div", { className: "dsh-token-quota-notice-actions" },
						h("button", {
							type: "button",
							className: "dsh-token-quota-notice-primary",
							onClick: onContinue,
							disabled: sending,
							ref: function (node) { if (node && visible) try { node.focus(); } catch { /* focus is best-effort */ } }
						},
							tt("notify.continue")),
						h("div", { className: "dsh-token-quota-notice-raise" },
							h("label", { className: "dsh-token-quota-notice-raise-label", htmlFor: "dsh-token-quota-notice-raise-input" },
								tt("notify.quota.label")),
							h("input", {
								id: "dsh-token-quota-notice-raise-input",
								type: "number",
								min: "1",
								step: "1000",
								value: effectiveRaise,
								onChange: function (event) { setRaiseValue(event.target.value); },
								onKeyDown: function (event) { if (event.key === "Enter") onRaise(); },
								className: "dsh-token-quota-notice-raise-input"
							}),
							h("button", {
								type: "button",
								className: "dsh-token-quota-notice-secondary",
								onClick: onRaise,
								disabled: sending || !(Number(effectiveRaise) > 0)
							}, tt("notify.raise"))
						),
						h("button", {
							type: "button",
							className: "dsh-token-quota-notice-danger",
							onClick: onStop,
							disabled: sending,
							title: tt("notify.stop.hint")
						}, tt("notify.stop")),
						h("button", {
							type: "button",
							className: "dsh-token-quota-notice-quiet",
							onClick: function () { setDismissed(pending.at); },
							disabled: sending
						}, tt("notify.dismiss"))
					),
					h("p", { className: "dsh-token-quota-notice-hint" }, tt("notify.continue.hint"))
				)
			);
		}

		/* ── styles ────────────────────────────────────────────────────
		 * The chip mirrors the composer's compact pill rows and the card
		 * mirrors DSH's own modal posture (dimmed frame, centered card,
		 * focus on the primary action). Every color is one of the
		 * official DSH theme tokens (`--dsw-alias-*`, the names the Host
		 * theme publishes), so the whole display follows DSH's light and
		 * dark themes — and any other theme the user installs — without
		 * a media query in sight; `apply()` also registers the plugin as
		 * a theme participant with both light and dark values. The
		 * classes are prefixed so they never collide with the host.
		 */
		var TOKEN_QUOTA_CSS = [
			".dsh-token-quota-chip {",
			"  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;",
			"  padding: 6px 10px; margin: 0;",
			"  border-radius: 10px;",
			"  border: 1px solid var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-bg-layer-2, transparent);",
			"  color: var(--dsw-alias-label-secondary, inherit);",
			"  font-size: 12px; line-height: 1.4;",
			"}",
			".dsh-token-quota-chip.is-paused {",
			"  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 55%, transparent);",
			"  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 10%, transparent);",
			"}",
			".dsh-token-quota-chip-label { font-weight: 600; white-space: nowrap; }",
			".dsh-token-quota-chip-summary { white-space: nowrap; font-variant-numeric: tabular-nums; }",
			".dsh-token-quota-chip-summary.is-off { opacity: 0.7; }",
			".dsh-token-quota-chip-paused {",
			"  height: 24px; padding: 0 10px; border-radius: 9999px; cursor: pointer;",
			"  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 55%, transparent);",
			"  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 16%, transparent);",
			"  color: var(--dsw-alias-state-warn-primary, #b45309);",
			"  font-size: 12px; font-weight: 600;",
			"}",
			".dsh-token-quota-chip-bar {",
			"  position: relative; width: 120px; height: 6px; border-radius: 9999px;",
			"  background: var(--dsw-alias-bg-layer-2, rgba(120,120,130,0.16));",
			"  overflow: hidden;",
			"}",
			".dsh-token-quota-chip-bar-fill {",
			"  position: absolute; left: 0; top: 0; bottom: 0; border-radius: 9999px;",
			"  background: var(--dsw-alias-state-success-primary, #16a34a);",
			"  transition: width 300ms ease;",
			"}",
			".dsh-token-quota-chip-bar-fill.is-warn {",
			"  background: var(--dsw-alias-state-warn-primary, #d97706);",
			"}",
			".dsh-token-quota-chip-bar-fill.is-critical {",
			"  background: var(--dsw-alias-state-error-primary, #dc2626);",
			"}",
			".dsh-token-quota-chip-input {",
			"  width: 130px; height: 26px; padding: 0 8px; margin: 0;",
			"  border-radius: 8px;",
			"  border: 1px solid var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-bg-base, transparent);",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"  font-size: 12px;",
			"}",
			".dsh-token-quota-chip-percent { width: 96px; }",
			".dsh-token-quota-chip-apply, .dsh-token-quota-chip-quiet {",
			"  height: 26px; padding: 0 10px; border-radius: 8px; cursor: pointer;",
			"  border: 1px solid var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-bg-layer-2, rgba(120,120,130,0.12));",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"  font-size: 12px;",
			"}",
			".dsh-token-quota-chip-apply:disabled { cursor: default; opacity: 0.5; }",
			".dsh-token-quota-chip { color: var(--dsw-alias-label-secondary, inherit); }",
			".dsh-token-quota-notice {",
			"  position: fixed; inset: 0; z-index: 2147483000;",
			"  display: flex; align-items: center; justify-content: center;",
			"  pointer-events: auto;",
			"}",
			".dsh-token-quota-notice-backdrop {",
			"  position: absolute; inset: 0;",
			"  background: rgba(0,0,0,0.45);",
			"}",
			".dsh-token-quota-notice-card {",
			"  position: relative; width: min(520px, calc(100vw - 48px));",
			"  padding: 22px 24px 18px; border-radius: 14px;",
			"  border: 1px solid var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-bg-overlay, #ffffff);",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"  box-shadow: var(--dsw-alias-shadow-lg, 0 18px 48px rgba(0,0,0,0.28));",
			"}",
			".dsh-token-quota-notice-head {",
			"  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;",
			"  color: var(--dsw-alias-state-warn-primary, #b45309);",
			"}",
			".dsh-token-quota-notice-title {",
			"  margin: 0; font-size: 16px; font-weight: 700; line-height: 1.3;",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"}",
			".dsh-token-quota-notice-body {",
			"  margin: 0 0 16px; font-size: 13px; line-height: 1.6;",
			"  color: var(--dsw-alias-label-secondary, inherit);",
			"}",
			".dsh-token-quota-notice-actions {",
			"  display: flex; flex-wrap: wrap; gap: 10px; align-items: center;",
			"}",
			".dsh-token-quota-notice-primary,",
			".dsh-token-quota-notice-secondary,",
			".dsh-token-quota-notice-danger,",
			".dsh-token-quota-notice-quiet {",
			"  height: 32px; padding: 0 14px; border-radius: 9px; cursor: pointer;",
			"  font-size: 13px; font-weight: 600;",
			"  border: 1px solid transparent;",
			"}",
			".dsh-token-quota-notice-primary {",
			"  background: var(--dsw-alias-brand-primary, #1f6feb);",
			"  color: var(--dsw-alias-text-on-brand, #ffffff);",
			"}",
			".dsh-token-quota-notice-primary:hover:not(:disabled) { filter: brightness(1.08); }",
			".dsh-token-quota-notice-danger {",
			"  background: transparent;",
			"  border-color: var(--dsw-alias-state-error-primary, #dc2626);",
			"  color: var(--dsw-alias-state-error-primary, #dc2626);",
			"}",
			".dsh-token-quota-notice-secondary {",
			"  background: var(--dsw-alias-bg-layer-2, rgba(120,120,130,0.12));",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"  border-color: var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"}",
			".dsh-token-quota-notice-quiet {",
			"  background: transparent; color: var(--dsw-alias-label-secondary, inherit);",
			"  font-weight: 400;",
			"}",
			".dsh-token-quota-notice-primary:disabled,",
			".dsh-token-quota-notice-secondary:disabled,",
			".dsh-token-quota-notice-danger:disabled,",
			".dsh-token-quota-notice-quiet:disabled { cursor: default; opacity: 0.5; }",
			".dsh-token-quota-notice-raise {",
			"  display: inline-flex; align-items: center; gap: 8px; flex: 1 1 260px;",
			"}",
			".dsh-token-quota-notice-raise-label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }",
			".dsh-token-quota-notice-raise-input {",
			"  width: 120px; height: 32px; padding: 0 8px; border-radius: 8px;",
			"  border: 1px solid var(--dsw-alias-border-l1, rgba(120,120,130,0.32));",
			"  background: var(--dsw-alias-bg-base, transparent);",
			"  color: var(--dsw-alias-label-primary, inherit);",
			"  font-size: 13px;",
			"}",
			".dsh-token-quota-notice-hint {",
			"  margin: 12px 0 0; font-size: 12px; line-height: 1.5;",
			"  color: var(--dsw-alias-label-secondary, inherit);",
			"}"
		].join("\n");

		var name = "dsh-token-quota";
		var inject = ["slots", "locale", "theme"];

		function apply(ctx) {
			localeHolder.ctx = ctx;
			// The dictionary the chip's bound `t` resolves; the dialog
			// reads the locale service directly (its seat renders
			// root-scoped, where the owner injects nothing).
			ctx.locale.register(NS, { zh: zh, en: en });

			/* ── theme: follow DSH light/dark ────────────────────────────
			 * DSH's theme service swaps CSS custom properties on the root
			 * for each theme. The surfaces above read those official
			 * `--dsw-alias-*` tokens, so they follow the active theme with
			 * no JavaScript at all. `overrideTokens` declares this plugin
			 * as a theme participant with BOTH light and dark values for
			 * the tokens whose names it owns, which is what the DSH theme
			 * contract requires (the inspect provider marks those tokens
			 * `requiresLightAndDark`). Everything else inherits.
			 */
			try {
				if (ctx.theme && typeof ctx.theme.overrideTokens === "function") {
					ctx.theme.overrideTokens("dsh-token-quota", {
						light: {
							"--dsw-alias-state-warn-primary": "#b45309",
							"--dsw-alias-state-error-primary": "#dc2626",
							"--dsw-alias-state-success-primary": "#16a34a"
						},
						dark: {
							"--dsw-alias-state-warn-primary": "#f59e0b",
							"--dsw-alias-state-error-primary": "#f87171",
							"--dsw-alias-state-success-primary": "#4ade80"
						}
					});
				}
			} catch (errTheme) {
				// A theme service that will not register overrides must not
				// break the chip and dialog: the token fallbacks above
				// already render them legibly in either theme.
				console.error("[dsh-token-quota] theme override registration failed:", errTheme);
			}

			var style = document.createElement("style");
			style.setAttribute("data-dsh-token-quota", "");
			style.textContent = TOKEN_QUOTA_CSS;
			document.head.appendChild(style);
			ctx.effect(function () {
				return function () {
					style.remove();
				};
			}, "dsh-token-quota: styles");

			// The budget chip under the composer.
			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "token-quota-chip",
					order: 30,
					label: "Token 限额",
					locale: NS
				}, TokenQuotaChip);
			});

			// The frame-wide warning dialog.
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({
					name: "shell.overlay",
					id: "token-quota-notice",
					order: 500,
					label: "Token 限额警戒"
				}, TokenQuotaNotice);
			});
		}

		module.exports = { name: name, inject: inject, apply: apply };
		return module.exports;
	}
});
