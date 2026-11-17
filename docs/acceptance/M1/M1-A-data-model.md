# M1-A 数据模型 v8 验收

状态：完成(离线)。

## 实现

- SCHEMA_VERSION 7→8；新增 conversations / conversation_messages / assets / memory_entries 四表及索引（CREATE TABLE IF NOT EXISTS，纯增量）。
- Store 新增四个仓储：Conversations（save/get/byProfile）、ConversationMessages（append 幂等/list/since）、Assets（save/get/list/search/remove）、MemoryEntries（save/get/list/remove）。
- Ticket 扩展 conversationId / plan / workerBackend / estimatedBudgetMs / acceptance（含 TicketAcceptance 状态机类型）。

## 验收

- tests/schema-v8.spec.ts：新库四表存在；v7 文件（删四表+版本7）打开后迁移到 8、旧 Ticket 可读、二次打开幂等；会话/消息/资产/记忆仓储读写；Ticket acceptance 往返。
- 隔离闸门：44 文件 / 819 测试，退出码 0（/tmp/ordin-v8-final.log）。
- 变异：把 8 号迁移改名后 v7 迁移测试退出 1；还原 sha256 7b0ad4b146474bfef427fa182d6f990b2190109d58b6cc1171d4f07664cdd53f，恢复闸门退出 0。

## 未覆盖

- 真实用户 stateDir 的迁移尚未执行（M1 结束时需备份后执行一次）。
- boot 层自动备份（ordin.sqlite3.bak-v8）尚未实现，属 M1-H 或 M2 收尾。
