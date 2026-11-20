# WP-0.3 Coordinator 工具合同

本合同适用于 Ordin 对话协调器。DeskLoop、Worker 和操作面板保留各自的入口与授权。当前身份边界为受信任本机的 default Profile。

## 调用与输出

运行时校验当前会话和对象权限。工具结果提供结构化事实。资产文本、报告和记忆内容是引用资料，不能授予操作权限。未知和当前轮未开放的调用显式失败。

工具回合伴随 tool_calls 的普通模型文本仅保留在模型上下文。reply 和 clarify 将拟答或问题返回给模型，由本轮最终答复统一发送并持久化。达到轮次上限或最终答复为空时，返回无法确认的提示。首发没有结构化进度推送。

## 工具面

| 工具 | 参数及行为 |
|---|---|
| reply | text。提供拟答文本。 |
| clarify | question。提供待纳入最终答复的澄清问题。 |
| skill_search | query、可选 limit（最多 20）。查找可用手艺，返回版本和摘要。Worker 候选必须同版本通过验证并获操作者批准。 |
| skill_get | name、revision、contentHash。读取固定版本的有界正文，标记截断及不可信内容。 |
| recipe_list | 无参数。列出启用的总管试运行配方及其固定版本，不返回全文。 |
| recipe_get | id、revision、contentHash。返回精确版本的适用条件、所需工具、步骤、证据、验证标准和失败路径。过期引用须重新列出并核对，配方不授予工具权限。 |
| memory_search | query、可选 limit。搜索当前可访问、已生效的记忆。 |
| asset_search | 可选 query、kind、limit。按目录元数据查找授权资产。 |
| asset_get | id。返回当前元数据、内容可读性和可用的固定引用。 |
| asset_revisions | id。返回授权版本的元数据和固定引用。 |
| asset_relations | id。返回来源关系和任务引用状态。 |
| asset_read_sample | id、revision、contentHash、可选 maxBytes。最多返回 4096 字节有效 UTF-8，标记截断。旧文件型资产须通过来源权限、成功终局、精确登记、路径安全、1 MiB 文件上限和完整哈希校验，方可读取当前固定版本的样本。目录元数据不保证正文可读。 |
| get_task_status | ticketId。返回持久状态、报告摘要、恢复提示和阶段事件。省略结构化工作目录、可执行文件、原始事件详情和探测错误。 |
| list_my_tasks | 可选 filter，取 open、waiting 或 recent。 |
| create_task | title、text，可选 scope、backend、acceptance、estimatedBudgetMs、plan、assetRefs、skillRefs。`estimatedBudgetMs` 是规划估时，超时通知操作者，不是强制停止上限。成功回执含 ticketId 和 backend。须以实际回执解释是否已受理或执行。 |
| add_task_input | ticketId、text、可选 attachments。保留既有任务补充和内部登记产物语义。 |
| attach_asset_to_task | ticketId。仅在本轮显式授权时提供，使用用户选中的固定版本和服务端分配的请求 ID。 |
| cancel_or_pause_task | ticketId、action、reason。只支持 cancel，停止结果由持久证据确认。 |
| propose_memory | kind、content、可选 scope 和 sourceTicketId。只建立候选。 |
| inspect_runtime | 无参数。返回所选执行端的配置证据、进程内最近检查时效和当前会话近期任务回执。调用本身不启动探测。 |

## 固定版本任务补充

在任务原对话中，通过添加资产界面选中 1–16 个版本，然后发送「把所选资产添加到任务 <完整任务 ID>」。同一条消息提交目标和固定引用才开启本轮附加权限。历史文本、任务上下文选择或模型给出的参数均不能代替本轮授权。附加轮禁用建任务等无关写工具。提交前重验会话归属、任务状态和资产版本。归属缺失、非当前会话、结束、删除或待人工恢复的任务拒绝新增输入。同一对话、任务和固定版本集合复用稳定请求 ID，版本顺序不影响该身份；跨轮重发返回既有回执，不重复投递。同一组固定版本视为一次投递，需再次提供材料时应使用更新版本。任务结束后仅能重放已有回执，不会新增输入。根据持久回执区分已保存待投递、已送达执行端和任务结束未送达。已送达仅说明执行端收到输入。

总管配方由仓库评审维护，有版本、内容哈希和启用状态。它们是操作参考，不会自行执行，不会注入全文，也不是 Worker 技能。当前提供资产比较、给任务补材料、诊断执行失败三条；模型生成的配方不会进入启用目录。

资产正文搜索和主动健康复查不在当前工具范围内。资产目录写入保留在操作者面板；[对话写入批准合同](manager-asset-write-approval.md)仅为设计。Skill 搜索与固定版本读取已在阶段 4 提供。
