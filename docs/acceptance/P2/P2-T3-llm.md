# P2-T3 · 自带 LLM client 验收

状态：**完成（离线验证）**；真实 provider 实测未完成，属 P0/P4 认证补测。

## 接口

- `deskLlmGenerate(config, history, tools, signal?) → { text, toolCalls, finishReason }`
- 四种 DeskMessage role 映射；工具分片聚合；finishReason 原样透传，截断为 incomplete，不谎报 stop。
- DeskLlmError kind：config/auth/rate_limit/server/http/timeout/aborted/network/protocol；retryable 与 Retry-After 透出。

## 验收

- 子代理：19 项本地 HTTP/stub 测试；两组变异（拆 HTTP 闸门、拆取消分类）均变红并按 A5 补覆盖。
- 主代理复核 src/desk/llm.ts 全文与请求/SSE/错误分类实现。
- 主代理隔离快照 /tmp/ordin-gate-p2t3b-20261115：npm run check 退出码 0，24 文件 / 586 测试通过；报告协议自检退出码 0。
- 附带修复 O-4：.gitignore 根锚定，桥协议库纳入版本库，并加回归断言。

## 未覆盖

- 真实 DeepSeek/OpenAI/网关调用与凭据链：待 P0/P4。
- DeskLoop 本体迁入：另一张卡。
