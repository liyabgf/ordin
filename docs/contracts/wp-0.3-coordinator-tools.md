# WP-0.3 Coordinator 工具合同

状态：契约文档。定义 Ordin 协调模型可选的窄工具集；M1 由 DeskLoop 循环实现，工具名同步迁移。

## 设计原则

- 模型选择动作，程序核验执行。工具回执返回前，模型不得向用户宣称结果。
- 工具集封闭且语义单一；未知工具调用大声失败。
- 每个工具对应一个可测试的程序函数，不做"万能执行"。

## 工具清单

### reply
直接回答用户。不建票、不触发副作用。
    args: { text: string }
    result: 已发送

### search_assets
搜索默认Profile可访问的已注册内部数据产物和许可范围记忆；只返回摘要与来源。未经导入授权的外部路径不参与模型工具引用。
    args: { query: string; kind?: "data"|"tool"|"both"; limit?: number }
    result: { items: [{ id, kind, name, description, source }] }

### get_task_status
查真实持久任务状态，不允许模型猜。
    args: { ticketId: string }
    result: { title, stage, backend, lastReport, acceptance, waitingReason? }

### list_my_tasks
列出当前用户未结束或最近结束的任务。
    args: { filter?: "open"|"waiting"|"recent" }
    result: { tasks: [{ id, title, stage, backend }] }

### create_task
建立持久任务。Ordin 核验授权、创建目录、登记 Mandate 后返回。回执返回之前，模型不能说"已派工"。
    args: { title: string; text: string; scope?: string; backend?: "dsh"|"codex"|"claude"; acceptance?: string; plan?: string[]; estimatedBudgetMs?: number; assetRefs?: string[] }
    result: { ticketId, backend, directory, plan }

### add_task_input
向默认Profile可访问的任务追加说明/追问，同Profile跨会话允许。attachments为已登记资产ID而不是模型提供的文件路径；解析并授权后以持久 Input 交付；CLI 不接受时保留到下一轮。
    args: { ticketId: string; text: string; attachments?: string[] }
    result: { delivered: boolean; queuedForNextTurn: boolean }

### cancel_or_pause_task
取消任务。Ordin 等待执行器停止尝试完成后，依据持久化停止证据返回结果；逐任务暂停尚未实现，会明确拒绝且不改变任务。
    args: { ticketId: string; action: "cancel"; reason: string }
    result: { stopped: boolean; finalState: string }

### propose_memory
提议一条记忆。该模型工具永远只能写候选(inferred)，不接受confirmed输入。提升为confirmed必须由独立、可审计的明确用户动作完成；MVP仍待查看/纠正/删除入口。
    args: { kind: "preference"|"project-fact"|"task-lesson"; content: string; scope?: string; sourceTicketId?: string }
    result: { memoryId, stored: boolean }

### clarify
向用户提出澄清问题。只在目标/对象/授权不清时使用。
    args: { question: string }
    result: 已发送（等待用户回复后进入下一轮）

## 系统提示词模板要点

- 你是 Ordin，用户的长期协调者。你可以直接聊天、查状态、组织任务、记住偏好。
- 讨论就讨论；明确交代的工作就用 create_task 推进；查进度用 get_task_status。
- 一条消息可以包含多个动作（如先问候再建任务）。
- create_task 回执返回前不要告诉用户"已派工"。
- 不确定的只有关键事实才问；能用工具查到的不要问用户。
- 始终用用户的语言回复。

## 迁移对照

| 旧 ordin 工具 | 新ordin 工具 | 备注 |
| --- | --- | --- |
| ordin_reply | reply | 收窄：不再操作 Ticket |
| ordin_create_ticket | create_task | 增加 plan/backend/acceptance |
| ordin_list_tickets | list_my_tasks | 改名+过滤 |
| ordin_ticket_status | get_task_status | 改名+增加 acceptance |
| ordin_note_ticket | add_task_input | 改名+增加 queued 语义 |
| ordin_answer_ticket | add_task_input | 合并：answer 是 input 的子类 |
| ordin_stop_ticket / retry_ticket | cancel_or_pause_task | 合并 |
| ordin_recall | search_assets | 扩展：搜数据+工具+记忆 |
| ordin_read_artifact | search_assets 返回内容 | 合并：asset 引用自带读取 |
| ordin_ask_desk | clarify / reply | desk 已内化为 coordinator |
| ordin_promote_skill | propose_asset_update | M2 实现 |
| ordin_raise_decision | clarify | 合并：决策即澄清 |
| ordin_handback | reply + cancel_or_pause | 合并 |

## 验收

- 类型定义编译通过；每个工具有正负测试（合法 args、非法 args、越权）。
- 协议描述与实现不漂移（tool-surface-docs 同类测试）。
