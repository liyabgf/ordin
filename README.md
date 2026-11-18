# Ordin

你自己的任务调度中台：你在聊天里说一句话，Ordin 决定派给谁干（DSH / Codex / Claude Code 等执行单元），
盯着干完，把结果送回你说话的地方。

> 当前状态：**独立宿主与三后端驱动已实现并通过离线一体化验收；真实后端因凭据未通过 P0，还不能宣称可生产执行。**
> 现役系统仍是 [Ordin](https://github.com/liyabgf/dsh-Ordin)（DSH 插件）。本仓库是它的独立化后续工程。

## 先读哪份

| 文档 | 内容 |
| --- | --- |
| [docs/33-functional-execution-plan.md](docs/33-functional-execution-plan.md) | **当前执行目标：功能优先，逐步完成真实任务闭环与交付验收。** |
| [docs/01-current-goal.md](docs/01-current-goal.md) | 独立宿主阶段的目标与完成定义；作为当前产品工程的基础阶段验收 |
| [AGENTS.md](AGENTS.md) | **执行纪律正典：约束干活的 agent。** 动手前必读；开工先登记 docs/ledger.md |
| [docs/02-execution-discipline.md](docs/02-execution-discipline.md) | 纪律索引（正典在 AGENTS.md；事故登记 docs/incidents.md） |
| [docs/03-architecture.md](docs/03-architecture.md) | 目标架构：WorkerDriver 抽象 + 三个执行后端 |
| [docs/10-migration-plan.md](docs/10-migration-plan.md) | 迁移策略：为什么分这几批 |
| [docs/20-execution-engineering.md](docs/20-execution-engineering.md) | **执行工程方案：任务卡级分解，派单按这里**（含验收命令与证据目录） |
| [docs/00-vision.md](docs/00-vision.md) | 长期方向（个人数字人格 / 手机操作端）。**参考，不是当下目标** |

背景调研：[Ordin 多后端可行性评估](docs/background/multiharness-feasibility-20261114.md)。

## 独立启动

只需 Node ≥24.9 和项目依赖。无需先安装或启动 DSH、Codex、Claude Code，也无需先设置 API key。

```bash
cd ordin

# 任选 npm 或 pnpm 安装依赖
npm install
# pnpm install

npm start
# pnpm start
```

pnpm 路径已用 11.28.5 验证；`pnpm-workspace.yaml` 的 `allowBuilds` 只批准 `esbuild` 安装脚本，保留其余依赖脚本的默认限制。CI 可用 `pnpm install --frozen-lockfile`。

打开 http://127.0.0.1:7471/ordin/（以终端打印地址为准）。Ctrl-C 停止。
面板、设置和任务账本独立运行；执行工具未配置时健康状态会提示原因，调用任务执行时会明确拒绝，不会伪装完成。配置好工具后重试任务会重新检查可用性。

## 第三方模型设置

在「设置 → Ordin 模型」选择 OpenAI、DeepSeek 或自定义 OpenAI 兼容接口，填写服务地址、模型和 API key。密钥保存到独立凭据文件（0600），界面不回显。支持测试连接和获取模型列表。也可使用环境变量认证，在启动前导出：

```bash
export OPENAI_API_KEY="your-key"
npm start
# 或：pnpm start
```

本地保存的密钥优先，清除后恢复环境变量认证。密钥不进入设置 JSON、数据库或日志。当前支持 OpenAI Chat Completions 兼容协议，尚未支持 Anthropic 原生协议。

## 离线数据库备份与恢复

在需要切版本或迁移前，先停止 Ordin，然后显式指定 state 目录与备份文件：

```bash
node --experimental-transform-types src/index.ts storage backup --state-dir /absolute/path/to/state --output /absolute/path/to/ordin.sqlite3
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/path/to/state --input /absolute/path/to/ordin.sqlite3
```

恢复会保留当前数据库 rollback 文件；若该目录仍被服务锁定、输入不完整或 SQLite sidecar 状态无法安全整理，命令会拒绝。维护命令只处理 SQLite 主库，不包含模型 API key、工作目录、上传文件或渠道凭据。密钥必须按独立凭据策略另行保存。不要手改 schema version 来回滚。

## 工程基线

- Node ≥ 24.9（与 DSH 一致；直接用 Node 跑 .ts，无构建步骤也能启动）
- `npm run check`：typecheck + 测试。**绿灯的定义是退出码**（见纪律 0.1）
- `npm start`：启动 Ordin 自己的面板与任务管理；执行工具检查在后台进行，不阻塞启动。
- `scripts/gate.sh`：最小闸门，落盘日志后报告退出码

## 目录

```
src/core/     领域模型与引擎：Trigger → Gate → Mandate → Ticket → Assignment（无外部依赖）
src/sources/  五个来路：cron / inbox / chat / rule / api
src/drivers/  执行单元适配：dsh / codex / claude（各自 pin 版本 + 契约测试）
src/desk/     总管分诊（自带 LLM client，不再借宿主的）
src/app/      store / effects / delivery / 自带 HTTP server 与面板
src/index.ts  独立进程入口
prompts/      worker / orchestrator / triage 提示词
bridges/      聊天桥（独立进程，从 Ordin 原样迁入）
panel/        面板静态资源
tests/        行为测试 + 各后端契约测试
scripts/      闸门与工具
```
