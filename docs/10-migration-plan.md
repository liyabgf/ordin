# 从 ordin 迁入的计划

> 施工分解（任务卡、验收命令、证据目录）见 [20-execution-engineering.md](20-execution-engineering.md)。本文件只管策略。

> 依据[可行性评估](background/multiharness-feasibility-20261114.md)：ordin 全部 16,027 行 TS 中
> **9,031 行（56%）无 DSH 依赖**，可整体迁入；6,996 行 DSH 绑定需改造。
> 本计划的每批都以"闸门全绿 + 文档落盘"为终点（纪律 1.1、1.5）。

## 批次

### P0 尖兵（3–5 天，先做）
本机实测三家 CLI 的无人值守往返：`dsh@next headless --json`、`codex exec --json` 及 resume、
`claude -p --output-format stream-json`。两种报告通道（回复代码块 / MCP）各跑一个真任务。
产出：实测记录（事件样例、坑、版本号）+ 每家 probe 脚本，落盘 docs/。

### P1 纯代码迁入（第一批）
原样迁入并跑通测试：
- `src/core/`（engine 1,950 / model 531 / policy 614 / timing / memory / ids / errors）
- `src/sources/`（chat 760 / inbox 318 / cron 275 / kind / registry / rule）
- `src/app/` 中的纯部分（store 857 / effects 222 / prompts 288 / skills 510 / files / lock / health / views / watchdog / uploads）
- `src/app/tools.ts`（570，9 个 ordin_* 工具的域逻辑）
- `bridges/`（五个聊天桥 + lib，独立进程，零改动）
- `prompts/`、`panel/`
约束：import 路径与包名改 ordin，**不改任何语义**；ordin 对应测试一并迁入并全绿。

### P2 独立宿主（第二批）
- 新 `src/index.ts` bootstrap：stateDir / 锁 / SQLite / 自带 HTTP server（挂 panel + API）
- `ctx.subprocess` → `node:child_process`（含进程组管理，纪律 1.4）
- DeskLoop 换自带 LLM client（OpenAI 兼容接口；凭据进 Ordin 设置，0600，面板不回显）
- WorkerDriver SPI 落地 + **DshDriver**（headless 为主，ACP 备选）
- 验收 = [当下目标完成定义](01-current-goal.md) 全六条

### P3 其余执行后端（独立验收之后）
CodexDriver、ClaudeDriver：事件归一化、usage 口径、resume/续聊投递、技能物化、MCP 报告通道（L2）。
同一 Ticket 可指定任一后端完成并回程；每家契约测试进闸门。

### P4 加固与预览
版本 pin 核查、认证健康监测（login status 探针 + auth_expired 失败分类）、超时/预算熔断、
SECURITY.md（worker=外部进程的权限面）、真实多桥验收、文档齐套。

## 明确的禁止事项

- 禁止整包复制 ordin 后一次性改到能跑（大爆炸）。
- 禁止在迁移批次里夹带语义变更。
- 禁止在 P2 验收前动 ordin 现役部署。
