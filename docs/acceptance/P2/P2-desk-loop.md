# P2 DeskLoop 独立化验收

状态：**完成（离线验证）**；真实 provider 未验收，boot 装配未覆盖。

## 实现

- src/app/desk-loop.ts：logger/Store/Prompts/ToolsHost/Engine/Settings 窄依赖；relay/notify 队列、requestId 幂等、工具循环、超时与 stop 语义。
- src/app/desk-tools.ts：ToolSchema 改为 Ordin 自带 LlmToolSchema；工具执行失败可见。
- src/core/policy.ts：deskLlm 增加 baseUrl 与 apiKeyEnv；apiKeyEnv 只引用环境变量，key 不入设置、不打印；provider 只作显示名。

## 验收

- 子代理：43 项 desk 测试；两组变异（configured 写死 true、拆 P1-3 护栏）均红并还原。
- 主代理 git 基线快照 /tmp/ordin-gate-deskloop-20261115：npm run check 退出码 0；32 文件 / 669 测试通过（/tmp/ordin-deskloop-gate.log）。

## 未覆盖

- 真实 OpenAI 兼容 provider、真实凭据、DeskLoop 在 boot 中的装配与端到端。
