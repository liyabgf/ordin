# 执行后端热切换与旧会话恢复

状态：运行时选择新后端和旧会话归属恢复均离线验证通过；真实后端仍待认证。

新任务：每次 prepare 读取当前设置；已准备执行固定到原驱动。
旧会话：Executor 将 BackendSession 传给 prepare；Router 优先选择 session.backend，并把准备票据固定到该驱动。resume 前核对票据驱动和会话后端一致。即使当前新选择的后端不可用，旧会话仍可在归属后端 prepare/resume。

验证：tests/router.spec.ts 覆盖设置切换、在途隔离、当前 Codex prepare 失败但旧 Claude 会话仍可准备并续接、错配拒绝；tests/executor.spec.ts 验证 Executor 传递 session。隔离全量闸门退出码 0，42 文件 / 803 测试。变异 Router.prepare 忽略 session 归属，router 测试退出 1；恢复 sha256 f49a15d7f90134093cbeefe02f92c485e228dec1f0721bbdcd933c64de0472b1，恢复闸门退出 0。日志 /tmp/ordin-resume-restored.log。

限制：这些是假驱动契约测试，不证明真实 Claude/Codex 凭据有效或 API 会记住上下文。Executor.resume 的前置 prepare 已传 session；当前选择为不可用 Codex 时，旧 Claude session 仍能走 Claude prepare/resume。跨后端恢复实现与离线合同通过；真实旧后端 API 恢复未验收。
