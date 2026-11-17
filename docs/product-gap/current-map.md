# Ordin 当前能力与长期协调者目标映射

审计范围：实际源码静态只读；不读凭据或用户 state，不调用真实模型。唯一写入为本文。
子代理仅修改本文；主代理已统一登记本轮账本并负责提交。

## 通道与 triage
| 目标能力 | 已有基础（源码证据） | 缺失／重建范围 |
| --- | --- | --- |
| 所有通道收件与回程 | ChatSource 将 channel/thread 映射 Trigger、replyTo，并接续 Thread；[chat.ts:507](../../src/sources/chat.ts#L507)、[chat.ts:536](../../src/sources/chat.ts#L536)、[chat.ts:552](../../src/sources/chat.ts#L552)。运行时统一注册 chat/inbox/cron/session/rule：[runtime.ts:359](../../src/app/runtime.ts#L359)。 | 可保留通道适配基础；不能据此声称所有输入都已由同一个长期协调者判断。 |
| 闲聊／任务分流 | triage 能走主 desk，brief 要求回答／派活／提问后关闭 triage：[executor.ts:47](../../src/app/executor.ts#L47)、[executor.ts:416](../../src/app/executor.ts#L416)。desk 首轮轻工具门，允许直接文本回答：[desk-loop.ts:368](../../src/app/desk-loop.ts#L368)、[desk-loop.ts:387](../../src/app/desk-loop.ts#L387)。 | 默认 triage=false、dedicated、仅 chat；可选范围仅 chat/inbox/cron，且 depth=0；session/rule 不进入，不能称“所有通道统一分流”：[policy.ts:112](../../src/core/policy.ts#L112)、[policy.ts:356](../../src/core/policy.ts#L356)、[policy.ts:584](../../src/core/policy.ts#L584)。需统一入口策略。 |
| 长期协调者身份 | desk system prompt 与持久历史存在：[desk-loop.ts:130](../../src/app/desk-loop.ts#L130)、[desk-history.ts:51](../../src/app/desk-history.ts#L51)。 | dedicated triage 走外部 worker，主 desk 只在设置为 main 才接管：[executor.ts:416](../../src/app/executor.ts#L416)。需明确始终由 Ordin 统筹的产品默认与通道生命周期。 |

## worker 路由与 prompts
| 目标能力 | 已有基础（源码证据） | 缺失／重建范围 |
| --- | --- | --- |
| 内部组织任务 | desk 的 create_ticket 支持 scope、Work、depends_on、附件与原请求回程地址：[tools.ts:335](../../src/app/tools.ts#L335)。 | 已有任务组织原语；该 schema 没有 backend/model 路由字段，尚无协调者按任务选择执行器。 |
| 选择 DSH／Claude／Codex | 三驱动已构造：[index.ts:64](../../src/index.ts#L64)；新任务取全局 executor.backend，旧会话取 session.backend：[router.ts:9](../../src/drivers/router.ts#L9)。 | 是设置选择，不是逐任务判断；需新增任务路由决策、落账与失败改派语义，保留 SPI/驱动。WorkerSpec 也无 backend 字段：[types.ts:29](../../src/drivers/types.ts#L29)。 |
| orchestrator prompt 实际接入 | init/变更都写 system，启动订阅 prompts 变更；LLM 读取 recent(50)：[desk-loop.ts:130](../../src/app/desk-loop.ts#L130)、[runtime.ts:1141](../../src/app/runtime.ts#L1141)、[desk-loop.ts:373](../../src/app/desk-loop.ts#L373)。 | 源码调用链已接通；未核活进程/构建产物与用户 override，不声称当前部署生效。 |
| worker／triage prompts 实际接入 | prompt 配置能保存三角色：[prompts.ts:14](../../src/app/prompts.ts#L14)、[prompts.ts:257](../../src/app/prompts.ts#L257)。 | 外部 worker 的实际 prompt 只来自 taskText+技能目录：[executor.ts:457](../../src/app/executor.ts#L457)、[executor.ts:472](../../src/app/executor.ts#L472)、[executor.ts:722](../../src/app/executor.ts#L722)。未读取 current(worker/triage)，dedicated 也走同一 startTurn；需重接角色提示，不能把可编辑 UI 当作生效证据。 |
| worker 工具可达性 | workerTools 定义 read_artifact、report/promote 等：[tools.ts:175](../../src/app/tools.ts#L175)、[tools.ts:236](../../src/app/tools.ts#L236)。 | src 内 workerTools 仅定义与 runtime import，无实际调用；启动 CLI 仅带 prompt 等参数：[dsh.ts:84](../../src/drivers/dsh.ts#L84)、[codex.ts:76](../../src/drivers/codex.ts#L76)、[claude.ts:79](../../src/drivers/claude.ts#L79)。需重建外部 worker 到 Ordin 工具桥，不能认为提示中写了工具名就可调用。 |

## 资产、使用证据与记忆
| 目标能力 | 已有基础（源码证据） | 缺失／重建范围 |
| --- | --- | --- |
| 数据资产注册 | report.files 规范化后入 artifact registry，拒绝非 Ticket 相对路径：[engine.ts:1283](../../src/core/engine.ts#L1283)、[engine.ts:1854](../../src/core/engine.ts#L1854)。 | 注册依据仍是 worker 声明；这不是内容正确或质量验收。保留 registry，补内容身份、有效性与版本。 |
| 按需读取／临时投射 | Engine 授权已注册资产；Runtime 安全读取/物化，事件记录成功读取的双向 lineage：[engine.ts:1537](../../src/core/engine.ts#L1537)、[engine.ts:1570](../../src/core/engine.ts#L1570)。附件复用在成功复制后记读：[executor.ts:674](../../src/app/executor.ts#L674)、[executor.ts:702](../../src/app/executor.ts#L702)。 | 已有数据池原语，但通用按需工具桥未接通；不能称所有 worker 可动态发现/借用。需接通目录查询、授权与使用回执。 |
| 技能／工具池投射 | SavedSkill 持久化、启停；每次 launch 将全部 enabled 技能写入 workspace/skills 并追加路径清单：[prompts.ts:185](../../src/app/prompts.ts#L185)、[materialize.ts:16](../../src/app/materialize.ts#L16)、[executor.ts:472](../../src/app/executor.ts#L472)。 | 目前是全量文件投射，不是按任务挑选，也非宿主虚拟注册；无撤销清理逻辑（materialize 仅写入）。需按需选择、作用域/租约与释放。 |
| 资产实际使用证据 | artifact_read 有成功路径；skillUsed 去重事件、recordSkillUse 计数原语存在：[engine.ts:1570](../../src/core/engine.ts#L1570)、[engine.ts:1648](../../src/core/engine.ts#L1648)、[prompts.ts:248](../../src/app/prompts.ts#L248)。 | src 全量检索未发现 skillUsed/recordSkillUse 的调用点；注释仍指向 Sessions，但外部启动未接计量。技能“已投射”不等于加载/运行成功；需重建真实回执采集，不能沿用 useCount 的可用性承诺。 |
| 按需让 worker 造工具 | report 工具有 promote_skill；Runtime 检查脚本位置、大小、硬编码路径后保存：[tools.ts:193](../../src/app/tools.ts#L193)、[runtime.ts:552](../../src/app/runtime.ts#L552)。 | 外部报告解析仅保留 state/summary/question/files，不接 promote_skill：[report.ts:20](../../src/drivers/report.ts#L20)、[report.ts:32](../../src/drivers/report.ts#L32)。且无工具功能试跑/独立验收；需补造工具派单→验证→晋升闭环。 |
| 使用记忆 | 持久 desk_messages；ordin_recall 按历史 Ticket 标题/最终摘要关键词检索；Work/Project/同 Work 资产摘要会入 worker 上下文：[desk-history.ts:51](../../src/app/desk-history.ts#L51)、[tools.ts:401](../../src/app/tools.ts#L401)、[executor.ts:737](../../src/app/executor.ts#L737)。 | 有历史召回，不等于长期偏好、教训与跨通道实体记忆；desk 实际仅投射最近50消息：[desk-loop.ts:373](../../src/app/desk-loop.ts#L373)。需提炼、更新、检索与纠错机制；core/memory 是测试仓储，非产品记忆：[memory.ts:2](../../src/core/memory.ts#L2)。 |

## 验收、回程与进度
| 目标能力 | 已有基础（源码证据） | 缺失／重建范围 |
| --- | --- | --- |
| Ordin 独立验收 | 结构化报告验证字段、终态格式；executor 防陈旧 attempt/未投递输入后转发：[report.ts:13](../../src/drivers/report.ts#L13)、[executor.ts:622](../../src/app/executor.ts#L622)。 | ready 直接写 result 并 ended(done)，原因明写 worker reported ready：[engine.ts:1248](../../src/core/engine.ts#L1248)。没有独立 checker/验收证据/拒收返工状态；终局格式检查≠任务验收。需重建 ready→待验收→通过/返工。 |
| 回程负责 | report 会写通知并向原地址 send，派生任务可复制地址：[delivery.ts:611](../../src/app/delivery.ts#L611)、[tools.ts:343](../../src/app/tools.ts#L343)。普通 worker 终态会 relay 唤醒 desk：[delivery.ts:835](../../src/app/delivery.ts#L835)。 | 原请求回程已有基础，但 worker 自报 ready 后已发送并结案，desk 后续唤醒不构成独立验收门；需让验收通过控制发布/结案。 |
| 用户问才查进度 | progress 仅注入 desk，不向 requester 推送；查询工具要求回答状态前读取任务：[delivery.ts:618](../../src/app/delivery.ts#L618)、[tools.ts:389](../../src/app/tools.ts#L389)。 | 该目标部分符合；blocked/waiting/failed/ready 等仍主动回程，需与用户确认的“结果回程”语义保持一致：[delivery.ts:49](../../src/app/delivery.ts#L49)。不要把“问才查进度”误改成不接收内部完成事件。 |
| 进度可观测 | Assignment/Report 状态可读：[runtime.ts:1029](../../src/app/runtime.ts#L1029)。 | progress() 当前固定 loaded=false、recentTools=[]，不能声称可见真实 worker 工具活动：[runtime.ts:1037](../../src/app/runtime.ts#L1037)。需接执行事件摘要，但按需展示。 |

## 保留、补齐与重建边界
- 保留：Source/Thread/回程地址、Ticket/Work/依赖、三后端 SPI、历史与资产仓储；上述均为静态源码基础，非真宿主验证。
- 优先补齐：统一 Ordin 入口、逐任务后端路由、worker/triage 角色 prompt 与外部工具桥、按需资产投射及真实使用证据。
- 必须重建语义：把 worker 自报 ready 与 Ordin 独立验收分开；长期记忆形成/更新/纠错；工具制作后功能验收与晋升闭环。
- 验证边界：仅静态追踪 src 与现有 prompt/配置实现；未运行构建/测试/模型，未读凭据或用户 state，未宣称部署行为通过。

