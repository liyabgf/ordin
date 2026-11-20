# Manager Capability Workbench 工程规划

状态（2026-11-20）：阶段 0–4 与 Registry 已实现并完成离线/隔离验收，阶段 1 旧 Ticket 工件读取另经隔离 Chrome 验收。阶段 5 已形成写操作确认合同；阶段 5b 安全评审裁决为当前不开放对话目录写入；阶段 6 三条总管操作配方已按需提供并经隔离浏览器验收。Codex CLI 四探针及独立 Workbench 真实 Worker 的固定技能正文、回程、错误 pin 拒绝、取消和成功 Ticket 同状态目录重启读回已通过真宿主验收；预算修复版已按用户授权部署到现役 7471，部署树包含上述阶段。真实总管模型、独立验收器、Claude 与真实渠道仍待验；阶段 5b 保留待未来重新评审。
目标：让 Ordin 总管能查证、使用受控资产和经批准的手艺；长时或需独立环境的工作继续交给 Worker。

> **修订说明（2026-11-19）**：按代码评审意见调整五处：①资产只读分拆提前至 Registry 之前；②重复发送行为升为阶段 0 必须决策；③确认票据降级为 P2 安全加固；④Registry 调整为独立里程碑；⑤澄清 http.ts 与领域 facade 的鉴权分层。

## 1. 决策

采用"统一领域工具实现 + 按路径投影工具集"。统一服务、schema、权限、审计和结果类型；按 coordinator、DeskLoop、worker、operator UI 提供最小可用工具集。

- 总管专注对话、查证、资产发现/引用和任务编排。
- DeskLoop 保留任务分诊职责，以兼容 adapter 渐进迁移。
- Worker 只接收 Ticket 固定的资产/技能引用和 worker tools，不获得 manager tools；skillRefs 是否实际加载和能力降级按 driver 契约单独验证。
- UI 保留完整运维能力，与工具调用复用相同领域服务。
- Skill/Recipe 是经审查的操作方法，不是权限主体，不允许任意脚本执行。
- 第一版使用静态 TypeScript registry，不建设通用 Agent Runtime、插件商店或自改工具系统。
- **Registry 为独立里程碑**，不是资产只读工具的前置条件。资产发现和任务交接可先于 Registry 完成，Registry 以"两条路径实现不漂移"为约束并行推进。

## 2. 实施前基线

此节与第 3、5 节中的现状描述记录实施前基线。100 条技能摘要预注入、工具回合双发和任务回执本机绝对路径均为历史行为。阶段 0–4 与 Registry 的实际证据见 [Workbench 验收](acceptance/manager-capabilities.md)，产品状态见 [工程状态](engineering-status.md)。

- src/app/coordinator.ts 有封闭工具循环：reply、search_assets、任务查/列/建/补充/取消、记忆候选和澄清。
- src/app/asset-catalog.ts 提供受权限过滤的目录列表、详情、版本历史、来源/引用关系、导入、metadata patch 和归档保护。内容能力已存在但不是所有记录均可读：operator-import 与 managed object 有独立内容；旧 Ticket artifact 的读取仍受 artifact 注册、成功终局、workRoot containment 和对象读取条件限制。不能将 catalog 可列出等同于总管可读正文。
- src/app/asset-inputs.ts、executor.ts 与 HTTP/UI 已有本机 operator 为 Ticket 补充固定版本资产和 queued/delivered/not-delivered 回执；这是受保护本机 API，不是 Coordinator 对话确认流程。
- src/app/prompts.ts 有技能版本、hash、候选、验证、批准与启停；create_task 能固定 skillRefs。
- runtime.ts/http.ts 已有连接配置和显式 probe API；executionStatus 当前只给所选 backend 的进程内最近缓存检查，不是全 backend 健康快照，重启后也不能当作新鲜检查。
- DeskLoop 的 desk-tools.ts 从 mainTools(host) 生成 Desk schema 并共用对应 handler；Coordinator 的 COORDINATOR_TOOLS/executeCoordinatorTool 则是独立 schema 与 switch。当前是部分共享实现、工具面分叉，不是所有 handler 都重复。
- docs/contracts/wp-0.3-coordinator-tools.md 已定义旧工具合同，但须与当前实现核对更新。
- Coordinator 当前每轮最多把 100 条 enabled skill 描述注入 system context；这不是按需发现，也不是总管读取完整 Skill。阶段 4 需先实现 search/getVersion，再调整注入量，避免只删预注入而造成能力倒退。
- coordinator.ts:563-564 确认：模型在含 toolCalls 的回复中附带非空 answer.text 时，系统先把这段模型可见文本发送给用户，工具完成后再发送最终 reply。它是两次用户可见发送；这段文本是模型生成内容，可能是进度说明/前言/错误表述，不能预设为内部推理，也不能自动视为经过验证的进度事件。

## 3. 实施前缺口

1. Coordinator search_assets 把资产和记忆混合返回，kind=tool 返回空资产；其分支查 store.assets 并通过 trustedAsset 过滤任务产物，要求 artifact 登记、成功终局及 workRoot containment。operator-import/managed-object 的搜索应接 AssetCatalog，并保留独立来源授权。
2. coordinator 缺少 asset detail/read/revisions/relations 工具，无法从摘要推进到核对证据。
3. 当前 Ticket 追加资产有 HTTP/UI 路径，但 coordinator 没有接受固定 AssetRef 的对应工具；现有 attachments 字符串映射为经 ticket/Work/profile 校验的内部 artifact 路径，不是 operator-import 的 AssetRef。旧 Ticket 缺少 conversationId 时 ticketAllowed 有兼容放行行为；新写输入不能仅凭缺失归属字段授权，须将 legacy ownership unknown 作为拒绝或人工核对状态。
4. skills 每轮最多注入 100 条描述；总管可选 skillRefs，却没有按需搜索和读取固定版本的发现入口。Worker 当前把选择的 skill materialize 到工作目录；实际后端是否消费、能力/降级需按 driver 契约分别验证，不能由“backend accepts Ticket”推断。
5. Coordinator 无健康查询。Runtime executionStatus 只返回所选 backend 的进程内最近 probe cache；不等于所有 Worker 健康，也不持久化跨重启 probe 历史。须区分 configured、last probe/observedAt、recent task receipt、unknown，不能推断未检查后端。
6. HTTP operator 写接口并不意味着模型可直接调用。缺少写操作确认、expectedRevision 检查和模型可读的脱敏回执合同。程序签发的防重放票据是 P2 安全加固，不阻塞首发。
7. Coordinator 自有 schema/switch 与 DeskLoop 的 mainTools projection 会在参数、权限和文案上漂移；DeskLoop 已有部分 handler 共用，不应全量重复迁移。Registry 逐项映射 Coordinator 专属工具，只抽取经盘点确认重复的领域行为。Schema 隐藏不构成执行授权。
8. **已确认两次可见发送路径**：Coordinator 会在工具回合先发模型伴随 toolCalls 生成的可见 answer.text，随后发最终 reply。阶段 0 决定是否新增结构化 progress event；未新增前，普通 answer.text 不应默认发出，最终 reply 必须保留。中间文本来自模型，不能假定为真实进度或执行证据。测试断言用户可见事件的类型/顺序/状态，而非仅断言总消息数量。

## 4. 路径与最小权限矩阵

| 调用路径 | 允许能力 | 明确不开放 |
|---|---|---|
| Coordinator / 总管 | 对话、授权资产/任务/当前所选 backend 的只读证据、技能发现、Ticket 任务编排；本机 default Profile policy 下明确指定且按 conversation/source object policy 可访问任务的固定版本资产输入 | 任意 shell/路径/HTTP、凭据读取、删除/覆盖、绕过对象 Profile/source ACL、多用户 actor 假设、任意 Skill 脚本 |
| DeskLoop | 现有分诊及已有 mainTools，渐进映射到同一领域 handler | 因迁移而新增 manager-only 资产/凭据能力 |
| Worker | Ticket 级固定资产/技能快照和 worker tools | manager registry、跨 Ticket 搜索与修改 |
| Operator UI | 当前受信任本机操作者的管理、配置和确认入口；没有 authenticated principal，不能把此边界描述为多用户安全授权 | 绕过领域权限、revision/hash 检查 |

当前 default Profile policy 是本机范围/兼容策略，不是 authenticated user principal。Coordinator 当前通过 conversation/Profile/对象关系限定本机数据访问，但没有多用户认证 actor；不能将 UI 上的单轮确认视为跨身份授权。若未来支持多用户，需先增加认证 actor 与对象级 ACL。

**鉴权分层**：领域 facade 负责业务逻辑和权限校验；http.ts route 只做 HTTP 层解析和错误转换。禁止两层各自独立实现部分权限——策略只在领域 facade 一处维护，http.ts 不重复实现，也不绕过 facade。Registry schema 可描述风险，但每个 handler 仍须在 facade 内独立做严格解析、profile/source/对象权限和状态校验。

## 5. 分期

**关键路径：0 → 1（资产只读）→ 2（任务交接）→ 3（健康摘要）**。Registry 为独立里程碑，与关键路径并行，不阻塞用户可见改进。

| 阶段 | 交付 | 验收/停止条件 |
|---|---|---|
| 0 契约盘点 | ①列出现有 coordinator/DeskLoop/worker/UI 工具、handler、权限与返回形状；②更新 WP-0.3；③**决定 tool-call 回合中间文本发送合同**（是否发送、以何种形式、契约测试路径）；④**识别并安排处理 Coordinator 回执中的绝对路径**（get_task_status:directory、create_task:directory 当前返回本机路径，须加入阶段 0 盘点范围） | 产出逐文件计划与路径矩阵；中间文本合同落入文档并有测试覆盖；测试证明 get_task_status 和 create_task 回执不含 home/work 绝对路径；不开放新写权限 |
| 1 资产只读闭环 | 分离 asset_search 与 memory_search；asset_get/read_sample（单一 byte 上限，必要时另记解码字符数，并返回 truncated）/revisions/relations；经 AssetCatalog 授权 | operator-import/managed-object 内容可读；Ticket artifact 只在登记、成功终局、Work containment 和对象读取均通过时可读；foreign profile/source/archive/stale hash/超限拒绝；未授权正文不得进入模型上下文 |
| 2 固定资产任务交接 | 统一固定 AssetRef id+revision+contentHash；新建任务和当前任务补充共用解析器；requestId 幂等；查投递 receipt | 用户在当前 Coordinator conversation 明确指定唯一 task 与资产，且该 Ticket 有可核验的 conversation/Profile 关联并通过 task/source ACL，才可追加。多任务歧义先 clarify；legacy conversationId 缺失/ownership unknown 不得按“当前对话”自动授予写权限，只读最小信息或转 UI 人工核对。陈旧 hash、foreign source、归档、ended/recovery task 拒绝；queued/delivered/not-delivered 如实报告，不称 consumed |
| 3 当前执行端只读诊断 | 只读当前所选 backend 的配置与进程内 last probe(result/warnings/observedAt)；关联持久任务 receipt；probe 不新鲜或进程重启后显示“无当前证据” | 不声称全后端健康；区分 configured/probe-passed/recent-task-receipt/unknown；未来若需跨重启 freshness，再单独增加持久 probe history |
| R Registry（独立里程碑） | 静态 Registry 登记 path/schema/risk 并投影工具；映射 Coordinator 专属 schema/switch 与 Desk mainTools projection；只将实际重复的领域 handler 抽为共享实现，DeskLoop adapter 渐进兼容 | 每路径暴露/拒绝矩阵通过；共享 handler 正负行为一致；旧 DeskLoop 契约通过；非重复工具不强求合并；未知调用显式失败。R 不阻塞阶段 1-3 |
| 4 Skill 按需发现 | 搜索 enabled/approved 技能，读取固定 revision/hash 的 recipe contract；按需选择到 Ticket；不把全池放 system prompt | candidate 不作为可执行技能推荐；版本漂移失败；沿用现有验证/批准门禁 |
| 5 资产写操作设计（已完成：文档） | 首发继续由 UI 执行 import/metadata/archive；定义 pending/approve/cancel/expire、精确变更摘要、执行时重新授权和脱敏审计的产品合同；不注册 Coordinator 写工具 | expectedRevision 只防并发冲突，不是授权；本机 UI 的传输同源标记不构成异步审批主体。详细合同：`docs/contracts/manager-asset-write-approval.md` |
| 5b 对话写入（已评审：不开放） | 阶段评审发现当前没有可绑定的操作者身份或原子审批状态机；保留 UI 写操作。不实现或宣传总管目录写入/多用户授权 | 只有当本机批准主体、领域层实时授权、目标与 revision/hash 绑定、幂等原子提交及隔离 HTTP/Chrome 全套负例均实现并复审后才重开。详见安全评审合同 |
| 6 Recipe 试运行（离线/隔离浏览器已验证） | 三条由仓库维护的总管配方：资产比较、任务补材料、执行失败诊断；经 `recipe_list` / `recipe_get` 只读发现和固定版本读取 | 覆盖适用条件、所需工具、步骤、证据、验证标准、失败路径、版本/哈希及启用状态；配方不授权工具，模型生成内容不进入启用目录 |

## 6. 推荐首个可用版本

首发对话工具只在当前本机 default Profile policy 内工作，不代表多用户认证授权。用户可搜索授权资产、读取受支持来源的有界预览、比较固定版本；可对其明确指定且权限校验通过的任务追加 fixed AssetRef，并读取实际 receipt。可查询当前所选 backend 的进程内 last-known probe；没有本次进程证据就显示 unknown。Ticket artifact 正文须满足成功终局、artifact registration、workRoot containment 及对象读检查，否则只报不可读，不尝试任意路径。operator import/metadata/archive 仍留 UI。

实施前的首发设计曾保留每轮最多 100 条 enabled skill 摘要预注入。阶段 4 已将其替换为按需搜索和固定版本读取。选择、固定版本和投递回执不能证明真实 Worker 消费了技能。

## 7. 实施范围与责任

- 合同：docs/contracts/wp-0.3-coordinator-tools.md；新增 tool path/permission contract；**阶段 0 须同步落地中间文本发送合同**。
- 资产工具：修改 src/app/coordinator.ts 的工具表和 CoordinatorHost，分拆 search_assets/search_memories，增加 asset 只读工具；不依赖 tool-registry.ts 先完成。
- Registry（独立里程碑）：建议新增 src/app/manager-tools.ts 与 src/app/tool-registry.ts；先适配现有 coordinator.ts 和 desk-tools.ts，不一次性搬迁所有 mainTools。
- Asset 服务：复用 src/app/asset-catalog.ts；规范 src/app/asset-inputs.ts 的 fixed ref/idempotency receipt；禁止在 coordinator 直接查 SQL 或读任意路径。
- Runtime/HTTP：**领域 facade 负责业务和权限，http.ts 只做 HTTP 层解析和错误转换**；策略不分散到两层各写一半。
- Skills：prompts.ts 增加权限过滤的 search/getVersion facade；沿用候选、验证、批准生命周期。
- Tests：新增 coordinator 资产工具和中间文本行为的 focused tests；阶段 R 再新增 tool-registry tests；更新 coordinator、asset-catalog、asset-input-core、skills、desk-tools、HTTP/runtime contracts。
- 每阶段单独提交、单独允许文件表；共用 schema/HTTP/model 文件设单一 owner。

估算：阶段 0-3 为中等规模，预计 3-4 个实现波次，不依赖 Registry；Registry 里程碑单独估算，以"两路不漂移"为验收约束。精确文件数/人日须阶段 0 后按代码 owner 和测试范围重新估算，不把初估当承诺。

## 8. 安全和语义规则

- Tool result 为模型唯一事实依据；unknown/error/truncated/stale 必须显式表达。
- 搜索结果仅返回授权的摘要和来源。读取不信任内容，做长度限制并指示模型把正文视为数据而非指令。
- 本计划新增的 managed AssetRef 输入固定 revision/hash；既有 legacy attachments 语义需单独迁移，不宣称所有历史 Ticket 输入已 pin。投递回执不证明 Worker 阅读或消费。读取的资产正文和 Skill 内容均属不可信数据，可能包含 prompt injection；总管必须按引用资料处理，绝不把正文中的指令提升为系统/用户授权。
- 首发资产目录写操作由 UI 执行，当前 metadata PATCH 的 expectedRevision 为可选字段。未来对话写须绑定审批主体、版本与哈希；结果不确定时先查回执。一次性 token/nonce 机制按威胁模型评估。
- 审计记录 actor/path/tool/target/version/requestId/outcome/time 和脱敏摘要；不记录 key、token、完整正文。
- 使用 allowlist DTO；不得返回连接 URL secret、原始配置、home/work absolute path 或整条无关事件历史。
- Manager recipes 不执行任意 shell；candidate worker skills 继续走独立验证和 operator approval；被批准不代表每个 backend 都支持相同行为。

## 9. 验收门槛

1. 路径投影测试：每条调用路径只见许可工具；删掉投影限制的 mutation 必须令测试红。
2. 资产正负测试：operator import/managed artifact 可见；foreign source/profile、archive、stale revision/hash、文件超限和损坏内容不可见/不可读；固定 revision 内容哈希一致。
3. 任务补充正负测试：明确对象 + 固定版本成功；越权/结束/并发变化拒绝；重复 requestId 无重复效果；receipt 和 Store 状态一致。
4. Skill 测试：enabled/approved 才可发现；候选、禁用、失效验证、hash drift 不被选用；ticket pin 与实际 materialization 有证据；DSH/Codex/Claude 支持差异显式呈现，未经实测不得宣称跨后端等价。
5. 健康诊断测试：not configured、no probe in current process、probe failed/warnings、陈旧的持久 probe（仅未来实现持久历史后）及真实任务 receipt 分别表达；没有持久检查记录时不得造出 probe stale；不得将支持列表冒充可用列表。
6. 对话端到端：问答不建任务；搜索/读取不派工；明确补充 pin 一次；各 tool outcome 与最终 answer 按阶段 0 的 user-visible event contract 验证，不重复最终结论，也不把模型前言当执行进度、不吞掉失败状态。
7. 变异验证：阶段 1-3 去掉 Profile/source/object ACL、task ownership check、hash/revision、幂等、来源/终局/workRoot check、截断/unknown 状态或路径投影后对应测试必须红；阶段 5b 实施时再验证 pending approval 的发起/取消/过期、actor/operation/target binding、重放拒绝和审计脱敏。恢复原字节并核 hash。
8. 隔离 typecheck/serialized full suite；最后用隔离真实 HTTP+Chrome 验收，不触碰现役状态或凭据。

## 10. 暂不做

不开放全部 mainTools 给总管，不让模型直接访问 Store/filesystem/HTTP，不做任意通用工具代理，不自动执行脚本技能，不自动启用模型生成手艺，不让总管自改权限/连接、不自动删除或覆盖资产，不在历史结果缺失时编造健康或消费结论。

## 11. 评审决策点

已采纳的首发范围包括当前对话任务的固定版本资产补充和所选执行端的只读摘要。资产目录写操作保留在操作者面板。DeskLoop 保持兼容入口，Registry 按路径暴露工具。对话在工具完成后发送综合答复，模型随工具调用生成的中间文本保持静默。验收和待验项见 [总管能力验收记录](acceptance/manager-capabilities.md)。
