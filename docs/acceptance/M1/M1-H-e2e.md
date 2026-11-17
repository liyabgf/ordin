# M1-H 端到端验收（M1 出口）

状态：**完成(离线)**。CP-2 待用户试用。

## 验收链路

真实 HTTP（/ordin/api/conversations/:id/message）→ Coordinator → 模型(stub SSE) → create_task 工具 → Engine 门禁 → Ticket → Executor → WorkerDriver(假驱动产出真实文件) → Report → 独立验收(4 检查器) → Delivery/资产注册 → 原对话历史。

## 测试内容（tests/m1-e2e.spec.ts）

- stub OpenAI 兼容模型：第 1 次调用返回 create_task 工具调用（标题 整理周报），第 2 次返回文本回复。
- ProductiveDriver：把 周报.md 写入任务目录并在报告中声明。
- 断言：HTTP 200 且 reply 含“安排”；模型调用 ≥2 次；Ticket 创建且 conversationId=e2e-1；Ticket done；acceptance accepted；result.files 含 周报.md；对话历史同时含 user 与 ordin；资产注册且 source.ticketId 匹配。

## 红测（证明非空转）

- 让假 worker 声称产出但不写文件：e2e 退出 1（验收拦下，Ticket 不进 done），还原 sha256 50829a69da2ac4382caea260f1101aaad5519a7f3f071cf6ed6ed2a98c1b8c49。

## 全量闸门

- 48 文件 / 856 测试，退出码 0（/tmp/ordin-m1h-final.log）。

## M1 出口对照（docs/30 里程碑）

| 故事 | 状态 |
| --- | --- |
| 1 闲聊直接回答，不建票 | ✅ 离线（coordinator 测试 + e2e 模型第二轮文本路径） |
| 2 交代任务→说明→执行→验收→回报 | ✅ 离线（e2e） |
| 4 临时工具先验证再晋升 | ⏳ M2（promote 通道未接） |
| 5 纠正偏好后可查看 | ⏳ M2（记忆管理页） |

## 未覆盖（进入 M2/M3 的明确缺口）

- 真实 DSH/Codex/Claude 后端与真实模型供应商（M3，需用户凭据）。
- 面板七区重建与对话页并入正式面板（M2-D）。
- 资产按需投射与使用回执（M2-B）、记忆管理页（M2-C）、通道身份统一（M2-E）。
- 崩溃恢复/会话落库等其余可靠性项（M2-F）。
