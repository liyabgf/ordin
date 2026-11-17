# P2-T5 · DshDriver 验收

状态：**完成（离线验证）**；真实 DSH headless 成功任务仍受 P0 认证阻塞。

## 实现

- src/drivers/dsh.ts：probe/prepare/launch/resume/feed/cancel；session、status step_end、final/error 增量解析。
- 完成条件：进程 exited + exit 0 + final.reason.kind=completed + 非空文本；缺 final、空文本、错误终局均失败。
- 错误分类：missing_credential/auth_expired/timeout/backend_error/protocol_error/cancelled。
- feed 明确 queued-for-next-turn；cancel 按 assignment 进程组。
- src/app/process.ts 增加增量 stdout/stderr 回调；回调异常记录到 ProcessRecord，不破坏子进程 I/O。

## 验收

- fake DSH 可执行文件覆盖 probe、launch、resume、usage、失败终局、无 final、空文本、取消。
- ProcessRegistry 新增回调测试：增量文本、stderr listener 异常可见。
- 隔离快照 /tmp/ordin-gate-p2dshb-20261115：npm run check 退出码 0；25 文件 / 594 测试通过（/tmp/ordin-p2dsh-gate2.log）。
- 变异：完成判断去掉 kind=completed 与 exit=0，dsh-driver.spec 退出码 1（预期红，/tmp/ordin-p2dsh-mutation.log）。
- 还原哈希一致；最终闸门退出码 0（/tmp/ordin-p2dsh-final-gate.log）。

## 未覆盖

- 真实模型成功流、续接上下文记忆、真实 ordin_report/MCP 通道：待认证恢复与 P3。
