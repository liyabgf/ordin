# 实际 Worker 提示词接入 L1 报告协议

状态：提示词发送路径离线验收通过；真实模型遵循率未验收。

WorkerExecutor.taskText 现在给每个初始/续接任务附明确 ordin-report fenced JSON 示例、六种 state、ready 的完成含义、waiting/blocked/failed 必填 question、files 为任务目录内实际产物相对路径。外部 CLI 没有自动注入 ordin_report 工具，不再要求必须调用一个不存在的工具。

Executor 测试核验初始 taskText 和恢复会话 launch spec 中都包含报告指令，示例 JSON 可解析且包含 ready/summary/files 字段。现有 driver/parser 状态分类未改，缺报告不会推断为 ready。

隔离全量闸门退出 0，42 文件 / 808 测试。变异删掉“exactly one ordin-report fenced JSON block”指令，Executor 测试退出 1；还原 sha256 344c2686ee6648854332890107bb9f8041b34d9ef3e213692189f8308dfcb427，恢复后闸门退出 0。日志 /tmp/ordin-report-prompt-final.log。
