# P2-T6 · Executor 验收

状态：**完成（离线组件级验证）**；真实 CLI 与 runtime 恢复未验收。

## 实现

- ExecutorHost=logger/proc/driver/engine/store/effects/health/lifetime/settings/workRoot/closing/desk?；无 cordis/sessions/subprocess。
- launchNow=prepare→launch/resume；started→assignmentStarted+输入确认；report→engine.report；final completed→确认+turnEnded；failed/cancelled→可见失败；无 final=protocol_error。
- deliverInputs=feed；queued-for-next-turn 显式确认并记日志；cancel=RunningTurn.cancel+进程组。
- ExecutionSandbox/LocalHostSandbox、槽位、暂停、依赖、附件、环境、效果重试保留。

## 验收

- 子代理：executor 专项 44/44；全量 check 连续 3 次退出码 0；3 组变异均红并还原。
- 主代理基线快照 /tmp/ordin-gate-executor-20261115：npm run check 退出码 0；37 文件 / 788 测试通过（/tmp/ordin-executor-gate.log）。
- 交接哈希：executor.ts a4a6c758e7475fae9216792460d4a142a038760e8f27d5e8014567262bc54113。

## 未覆盖（如实）

1. DSH 特有 late-create/cleanupLateAgent/worker-preset 等用例作废。
2. BackendSession 当前只在内存；跨重启恢复归 runtime。
3. AccessMode 当前固定 edit，设置路由待接。
4. text/tool/usage 面板、work 分层正文、真实 CLI 未覆盖。
