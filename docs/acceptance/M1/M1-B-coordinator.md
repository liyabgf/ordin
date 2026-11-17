# M1-B Coordinator 工具与循环验收

状态：完成(离线)。

## 实现

- src/app/coordinator.ts：9 个工具 schema（reply/search_assets/get_task_status/list_my_tasks/create_task/add_task_input/cancel_or_pause_task/propose_memory/clarify）+ executeCoordinatorTool + runCoordinatorTurn 单模型多轮循环。
- Engine.annotate：记录 conversationId/plan/workerBackend/estimatedBudgetMs，与 note/answer 分离（不产生 Input）。
- create_task 走 engine.createTicket（门禁照常）；未知 backend/未知工具/坏参数大声失败。
- propose_memory 默认 inferred，用户明确确认才 confirmed。
- 循环：用户消息持久化 → 模型选择工具 → 程序执行 → 结果回传 → 直到纯文本；回复持久化并发送。

## 验收

- tests/coordinator.spec.ts 15 项：9 工具正负例、未知工具、坏 JSON、缺参数、循环直答/建任务/历史保留。
- 隔离闸门：45 文件 / 834 测试，退出码 0（/tmp/ordin-coord-final.log）。
- 变异：未知工具改为静默成功，coordinator 测试退出 1；还原 sha256 af8efdf9026304c830fb9dec9b6ef67b7e6fb836869ce6b28c79dfe22236046a，恢复闸门退出 0。

## 未覆盖

- 真实 LLM 调用（M1-C 用 stub；真实模型在 M3 验收）。
- 面板对话界面（M1-C）。
- 资产按需投射到 worker 目录（M1-F）。
