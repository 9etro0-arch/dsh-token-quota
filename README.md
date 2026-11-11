# dsh-token-quota — Token 限额警戒

> 给当前会话设一个 token 预算：用量**接近限额之前**弹出弹窗，**暂停正在跑的任务**，等你决定——继续、提高限额、或停止。

DSH（DeepSeek Harness）插件。npm：[`dsh-token-quota`](https://www.npmjs.com/package/dsh-token-quota) · GitHub：[9etro0-arch/dsh-token-quota](https://github.com/9etro0-arch/dsh-token-quota)

## 安装

```
dsh plugin --profile desktop add dsh-token-quota
```

或者从 Git 仓库：

```
dsh plugin --profile desktop add github:9etro0-arch/dsh-token-quota
```

## 用法

1. 在输入框下方出现「Token 限额」条：输入预算（token 数，如 `100000`）和警戒比例（1–100），点「设置」。两项都是**必填**——本插件没有预设默认值。
2. 任务跑起来后，插件用 DSH 自己的 token 度量（就是界面显示「剩余上下文」的那个数）盯着当前会话的上下文用量。
3. 用量达到 `限额 × 警戒比例` 时：
   - 全屏弹出**警告弹窗**，任务在 `agent/pre-step` 处被真正挂起（下一个模型步骤不会发出）；
   - 三个选择：
     - **继续任务** —— 把剩余额度花完，达到限额前不再提醒；
     - **提高限额并继续** —— 自己填新限额（不预填），立即生效并继续；
     - **停止任务** —— 结束本次任务（会话记录里会留一条说明），等你下一步指示。
   - 「稍后再说」/ Esc / 点遮罩 只是暂时关掉弹窗——任务仍然挂着，输入框下面的条会一直显示「已暂停 · 点击处理」，点它重开弹窗。
4. 限额是**当前会话**自己的设置，不改变新会话的默认。

## 配置

设置 → 插件 → dsh-token-quota（或 profile patch）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `quota` | **无（必须自己设）** | 限额（token 数）。不设就是不起作用 |
| `warnPercent` | **无（必须自己设）** | 警戒比例（1–100），达到 `quota × warnPercent%` 时弹窗 |

> 本插件**没有任何预设默认值**：两个字段都得你亲自填（或在输入框下方的条里填），填了才生效。

也可以在输入框下方的「Token 限额」条里直接为**当前会话**设置（可选填警戒 %）。会话级设置存在 `$DSH_HOME/token-quota/sessions.json`，不进 profile patch。

## 明暗主题

界面全部使用 DSH 官方主题 token（`--dsw-alias-*`），并已注册为双主题参与者（light + dark 两套值），**自动跟随 DSH 的白天/黑夜模式**，无需任何额外设置。

## 实现要点

- **暂停点**是 `agent/pre-step` 瀑布：先 `await next()` 保持瀑布完整，再决定是否把决定权挂在 deferred 上，因此弹窗等待期间不会发出任何模型请求；用户点「停止」时返回 `{kind:"reject"}` 结束本次 turn，并 `agent.inject()` 一条说明写入会话记录。
- 用量来自 host 的 `tokenMeter.measure(session)`（`totalTokens`），与界面「剩余上下文」同源。
- host/client 之间只走一个 loopback 控制路由 `GET/POST /token-quota`（读取/写入限额与警戒比例、读取实时用量、结算挂起的暂停）。
- 客户端注册两个位面：`conversation.composer.dock`（额度条）与 `shell.overlay`（警告弹窗）；弹窗是 root 作用域，会话 id 由会话作用域的额度条通过模块内共享状态提供。
- 一切降级：度量失败、服务缺失、存储写失败都不会打断 agent 循环，只记日志。

## 卸载

```
dsh plugin --profile desktop remove dsh-token-quota
```

License: MIT
