# M1-C 对话 API 与面板对话页验收

状态：完成(离线)。

## 实现

- Runtime.conversationTurn：把 CoordinatorHost 接到真实 deskLlmGenerate（baseUrl/model/apiKeyEnv 来自设置，key 只读环境变量）；conversationMessages 读历史。
- HTTP：GET /ordin/api/conversations/:id/messages、POST /ordin/api/conversations/:id/message（空文本 400、未接线 501、未配置模型 503 且带原因、跨源 403）。
- /ordin/chat：最小独立对话页（面板重建前的可用入口），Enter 发送、错误可见、历史加载。

## 验收

- tests/conversation-api.spec.ts 5 项：真 HTTP server + stub coordinator：往返、503 原因、501、400/403、chat 页可访问。
- 隔离闸门：46 文件 / 839 测试，退出码 0（/tmp/ordin-convapi-gate.log）。

## 未覆盖

- 真实模型调用（M1-H 用本地 stub server 验收；真实供应商 M3）。
- 面板对话页并入正式面板（M2-D）。
