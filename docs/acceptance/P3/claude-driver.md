# ClaudeDriver 验收

状态：**完成（离线验证）**；真实 Claude 成功任务受 P0 未登录阻塞。

## 实现

- claude -p stream-json、resume、权限模式、usage/cost、报告解析、进程组取消。
- 成功必须 subtype=success + !is_error + 非空 result + exit 0；空结果为 protocol_error。
- probe 使用 --version 与 auth status；登录态只报 ok/unknown，不读凭据内容。

## 验收

- fake Claude 8 用例：probe、launch、resume、is_error=true、无 result、空 result、取消，以及“exit 0 但 is_error=true”强化用例。
- 初始变异忽略 is_error 不变红，按 A5 补 silent-error 用例后变异退出码 1（/tmp/ordin-claude-mutation2.log）。
- git 基线快照 /tmp/ordin-gate-claudec-20261115：npm run check 退出码 0；29 文件 / 626 测试通过（/tmp/ordin-claude-gate3.log）。
- 还原哈希一致，最终闸门退出码 0。

## 未覆盖

真实 Claude 模型流、上下文续接、L1/MCP 报告通道。
