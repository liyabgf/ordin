# 项目执行工程方案

> 这份文件回答"**怎么施工**"。docs/10-migration-plan.md 是策略（为什么分这几批），
> 本文件是工程分解（每批有哪些任务卡、改哪些文件、用什么命令验收、证据落在哪）。
> 派单就按这里的任务卡派；任务卡与 AGENTS.md 的纪律配套使用。

## 1. 工程链路

```
当下目标（docs/01） → 批次（P0–P4） → 任务卡（Px-Tn）
   → 账本登记（docs/ledger.md，先写后做）
   → 隔离副本执行（/tmp 快照，R3）
   → 闸门（scripts/gate.sh，退出码为准）
   → 验收证据（docs/acceptance/<批次>/）
   → git 提交
```

### 任务卡模板（每张卡必须写全）

| 字段 | 内容 |
| --- | --- |
| 编号 / 意图 | 一句话说清干什么、为什么 |
| 输入 | 依赖的前置任务卡、要读的文件 |
| 允许修改 / 禁改 | 文件级清单（R2），子代理不得越界 |
| 产出 | 文件或实测记录，先落盘再完善 |
| 验收命令 | 可执行、看退出码；不接受"看起来对" |
| 回滚 | 具体命令；演练过才算完成（R5） |
| 证据 | docs/acceptance/<批次>/ 下的文件名 |

---

## 2. P0 尖兵（未开始，等授权）

目的：把可行性报告里的〔推测〕变成〔已验证〕。**只写脚本与实测记录，不碰产品代码。**

| 卡 | 干什么 | 产出 | 验收 |
| --- | --- | --- | --- |
| P0-T1 | probe 脚本骨架：`scripts/probe/`，统一输出 JSON（版本、登录态、四探针结果） | probe 框架 + README | 空跑对三家都输出"未测"而非崩溃 |
| P0-T2 | DSH 实测：`dsh@next headless --json` 起任务、抓全事件、`--session-id` 续接、`--approval-policy never` | docs/p0/dsh.md（事件样例、版本、坑） | 记录含真实命令与真实输出；版本钉子当时量 |
| P0-T3 | Codex 实测：`codex exec --json`、`exec resume` 往返、非 git 目录行为、stdin 行为 | docs/p0/codex.md | 同上 |
| P0-T4 | Claude 实测：安装 CLI、`-p --output-format stream-json`、`--resume`、权限模式 | docs/p0/claude.md | 同上 |
| P0-T5 | 报告通道对比：同一真任务各跑"回复代码块"与"MCP"两种方式 | docs/p0/report-channel.md + L1 协议决定 | 决定写进 docs/03-architecture.md |

退出条件：三家四探针记录齐 + 风险清单更新 + L1 协议有决定。**任何一家跑不通就如实记"未通过"，不降级成推测。**

2026-11-15 实测修订：三家均受认证阻塞，P0 暂不能退出。为避免停工，允许不依赖真实模型的 P1/P2 离线任务与其交叠；但 P0 的补测义务保留，所有真实后端与端到端结论仍受它约束。

---

## 3. P1 纯代码迁入（文件级映射）

迁入铁律：**只改包名与 import 路径，不改语义**；每张子卡以"原仓库对应测试绿 + ordin 闸门绿"双证收尾。

| 卡 | ordin 源 | ordin 目标 | 专项验收 |
| --- | --- | --- | --- |
| P1-T1 | src/core/（8 文件，3,522 行） | src/core/ | `grep -r "@deepseek-ai" src/core` 为空；core 测试迁入全绿 |
| P1-T2 | src/sources/（7 文件，1,715 行） | src/sources/ | 同上；五来源行为测试全绿 |
| P1-T3 | app 纯部分：store(857) effects(222) prompts(288) skills(510) files/lock/health/views/watchdog/uploads | src/app/ | node:sqlite 实测建库读写；effects 重试测试全绿 |
| P1-T4 | app/tools.ts（570，9 个工具的域逻辑） | src/app/tools.ts | 工具域逻辑测试全绿（注册部分留 P2） |
| P1-T5 | bridges/（五桥 + lib）、prompts/、panel/ | 同名目录 | 桥 transform 测试全绿；桥进程零改动声明经 diff 证实 |

回滚：每张子卡独立提交，`git revert <子卡提交>` 即回滚；演练一次后该批才算完成。

---

## 4. P2 独立宿主（最重一批，8 张卡）

**T4 契约先行冻结，主代理拥有；T1/T2/T3 可并行（文件边界不重叠）；T5/T6 随后；T7/T8 收尾。**

| 卡 | 干什么 | 允许修改 | 验收 |
| --- | --- | --- | --- |
| P2-T1 | bootstrap：stateDir、锁、SQLite、日志、信号处理 | src/index.ts、src/app/boot* | 进程起停三次无残留；锁与 WAL 归位 |
| P2-T2 | 自带 HTTP server + 面板 + API 路由迁入 | src/app/http*、panel/ | 面板在 ordin 自己的端口可开；同源管理请求守卫测试绿 |
| P2-T3 | DeskLoop 换自带 LLM client（接口签名不变） | src/desk/ | 桩 LLM 下 DeskLoop 原测试全绿；真实 key 一次实测 |
| P2-T4 | WorkerDriver SPI 冻结：接口、NormEvent、错误与取消语义 | src/drivers/types.ts | 契约文档 + 类型测试；冻结后改动需变更申请 |
| P2-T5 | DshDriver（headless）+ 进程注册表（收尸） | src/drivers/dsh/、src/app/proc* | 四探针契约测试绿；杀进程组实测无孤儿 |
| P2-T6 | executor 改造：会话调用点换驱动，效果队列不动 | src/app/executor* | 槽位/暂停/依赖重试原测试全绿 |
| P2-T7 | delivery 与回程接线（文件 + 聊天 + 通知） | src/app/delivery* | RESULT.md 与聊天回程端到端实测 |
| P2-T8 | 端到端验收：docs/01 六条完成定义逐条过 | 只写报告，不改代码 | docs/acceptance/P2/ 报告，能力五态标注 |

---

## 5. P3 / P4（P2 验收后排期）

- P3：CodexDriver、ClaudeDriver 各一张卡（四探针契约测试 + 真实任务回程）；
  技能物化与 MCP 报告通道（L2）各一张卡。
- P4：版本 pin 核查、认证健康监测、超时/预算熔断、SECURITY.md、真实多桥验收、文档齐套。

---

## 6. 每批固定节拍（不可省）

账本登记 → 批次合同（允许/禁改文件）→ 隔离快照 → 实现 → 正/负测试 → 变异检验 →
闸门退出码 → 回滚演练 → 证据落 `docs/acceptance/<批次>/` → 提交。

证据目录约定：`docs/acceptance/<批次>/<任务卡>.md`，含命令原文、真实退出码、当时量的哈希、
以及五态标注（真宿主验证 / 离线验证 / 部分实现 / 仅有设计 / 尚未实现）。

## 7. 当前状态

P0 未开始，等授权。本文件与 AGENTS.md、docs/10 同步维护；批次有变动先改这里再施工。
