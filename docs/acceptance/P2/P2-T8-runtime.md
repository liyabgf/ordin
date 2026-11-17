# P2-T8 · 一体化 Runtime 验收

状态：**完成（离线一体化验证）**；真实 DSH/Codex/Claude 成功任务仍受 P0 认证阻塞。

## 实现

- src/app/runtime.ts：boot/HTTP/Engine/WorkerExecutor/OutcomeDelivery/SourceRegistry/Watchdog/DeskLoop 组合根；恢复、预算、面板、设置、回收。
- src/app/boot.ts 保持底层生命周期；src/index.ts 选择 backend 并先 probe，probe 不健康拒绝启动。
- 设置 executor.backend/access；started/HTTP close 生命周期修正。
- DeskLoop 与 DeskRelay 接入；main DSH Session 明确不可用，不伪装。

## 验收

- 完整隔离快照 /tmp/ordin-gate-full-runtime-20261115：npm run check 退出码 0；38 文件 / 790 测试通过（/tmp/ordin-full-runtime-gate.log）。
- 一体化用例：真实临时 stateDir + 动态端口面板；inbox 文件 → Gate → Ticket → fake WorkerDriver ready → RESULT.md → 面板 API。
- 变异：startNow 不置 started，runtime.spec 退出码 1（预期红，/tmp/ordin-runtime-mutation.log）；还原哈希一致，最终闸门退出码 0。
- 中间过程事实：类型错误从 14 个收敛到 0；RESULT.md 写入竞态被测试暴露并修正；smoke 断言随真实状态更新。

## 未覆盖（如实）

1. 真实后端成功事件流、续接、报告遵守率：待 P0/P3。
2. Codex/Claude 的生产 driver 选择已实现，但真实连接未测。
3. 浏览器视觉验收、真实平台收发、多桥验收属 P4。
4. worker 事件面板 detail（text/tool/usage）未覆盖。
