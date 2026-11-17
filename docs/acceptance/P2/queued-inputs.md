# CLI 排队输入的可靠交付

状态：离线 Executor/Driver 整机契约通过；真实模型是否采纳下一轮上下文未验收。

CLI 在当前回合不支持 feed 时返回 queued-for-next-turn。Executor 不再把输入确认 delivered，也不依赖 CLI 内部不存在的队列。输入继续保留在 SQLite；当前回合结束后创建下一轮，taskText 从 Ticket undelivered inputs 构造同一后端 resume 提示。Started 回执只确认该 launch prompt 快照中的 input IDs。已报告 ready/dropped 的当前回合若有未交付输入则不结案，避免先完成后丢掉后续输入。真正写进后端提示词后才设置 deliveredAt。

隔离快照 /tmp/ordin-inputs-path：全量 npm run check 退出码 0，42 文件 / 808 测试。Executor mutation 将 queued 分支立即 inputsDelivered，专项测试退出 1；还原 sha256 0619e2c0d416dff9d1323b58f6aa1e8b915820e9f3914e190ce0bbe1c0ec209a；恢复全量闸门退出 0。

未覆盖：另一个设备/进程并发写同一 stateDir（锁明确禁止）；真实后端实际遵循续接提示需要认证后另验。
