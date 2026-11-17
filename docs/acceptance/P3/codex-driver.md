# CodexDriver 验收

状态：**完成（离线验证）**；真实 Codex 成功任务受 P0 401 token_expired 阻塞。

## 实现与验收

- src/drivers/codex.ts：exec/resume、thread/turn/item 事件、严格 completed、feed queued、进程组取消、错误分类。
- src/drivers/channel.ts：DSH/Codex 共用实时事件队列。
- fake Codex 7 用例：probe、launch、resume、turn.failed、无 completed、空消息、取消。
- git 基线隔离快照 /tmp/ordin-gate-codexb-20261115：npm run check 退出码 0；28 文件 / 618 测试通过（/tmp/ordin-codex-gate2.log）。
- 变异：强制 !completed 分支，codex-driver.spec 退出码 1（预期红，/tmp/ordin-codex-mutation.log）；还原哈希一致，最终闸门退出码 0。

## 未覆盖

- 真实 Codex 模型流、上下文续接、L1 报告遵守率、MCP。
