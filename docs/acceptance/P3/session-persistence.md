# 执行会话持久化

状态：实现与 SQLite 组件级恢复通过；真实 CLI 跨进程恢复未验收。

Executor 收到 started/final 中的 BackendSession 后写入现有 SQLite KV，键为 ordin:backend-session:<ticketId>。再次执行/投递时先查内存，缺失则读取 KV 并校验后端枚举、非空 id、有效时间、cwd 与 Ticket 工作目录一致。不改变 schema；旧库没有记录时仍视为没有保存会话。

测试：同一真实 SQLite Store，首轮结束后重建 WorkerExecutor（丢弃 Map），追加消息时 prepare/resume 收到原 session。另测篡改 cwd 到任务外目录，恢复被拒绝、deliveryError 可见。该测试没有关闭重开整个 Ordin 进程，不宣称真实 CLI 跨进程端到端通过。

隔离全量闸门：42 文件 / 805 测试，退出码 0（/tmp/ordin-persist-session-final.log）。变异去掉 Store.set 持久化，Executor 测试退出码 1；还原哈希 15b524c467f2a55b03aa398b48fea534692ef06afa523763b204f0125483debf，全量闸门恢复退出 0。

回滚：本改动只增加 KV 记录，旧实现忽略它；源码可回滚，既有 Ticket 与 schema 不变。实际用户数据库与运行服务未修改。
