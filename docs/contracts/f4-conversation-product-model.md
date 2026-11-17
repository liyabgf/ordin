# F4-S1 对话产品模型

## 三个不同对象

**Conversation** 是用户可见的上下文容器。它有独立 ID、标题、创建时间、最近活动、归档状态和消息历史。用户可以随时新建、打开、重命名、归档；重新打开时恢复该对话自己的历史窗口。

**Task** 是执行对象。它由一段 Conversation 中的明确动作创建，拥有自己的 Ticket、Assignment、预算、验收、资产和送达状态。一个 Conversation 可以创建多个 Task；一个 Task 的状态可以被其他 Conversation 查询或明确接续。Task 不等于 Conversation。

**Memory** 是长期共享对象。只有 confirmed、未过期、未删除的记忆进入新对话上下文；当前对话中的推测、候选记忆和任务临时上下文不自动共享。

## 新建与恢复

- `new conversation` 生成全新 conversationId、空消息历史和独立标题。
- 面板、HTTP、移动端使用同一 Conversation API；入口只改变 transport，不改变对象和权限。
- 对话历史按 conversationId 分区；默认加载有限最近窗口，较旧消息通过显式分页读取。
- 重命名、归档、恢复、删除是 Conversation 管理动作；删除不删除其 Ticket、资产、收据或 confirmed Memory。删除后的对话不能继续写入。

## Task 绑定

- create_task 记录 sourceConversationId 和 taskId 的绑定；它不把整个对话复制到 Ticket。
- 同一对话可以有多个任务；每个任务有独立任务卡片、进度和结果。
- 新对话查询任务必须显式提供 taskId，或由用户在任务卡片执行“在新对话中继续”。模型不得只凭标题、发送者、频道或相似文本自动接续。
- “继续这个任务”创建新的 user turn，并携带受信任 taskId；它不把旧对话全文注入新对话。系统只加载任务摘要、最新状态、必要的交付引用和用户确认的 Memory。

## 平台消息

- platform event 必须有明确的 conversation binding：平台 thread 映射只能作为候选绑定事实，不能永久把频道/发送者当作唯一 conversation。
- 入口可为当前聊天保存一个明确的活动Conversation绑定，普通消息继续该会话；用户执行新建时生成新ID并切换绑定，旧历史保持可恢复。未绑定时创建初始会话或等待绑定。不能把“每条消息自动新建”当作新对话功能。
- 只有显式 `conversationId`、平台 thread 的持久 operator mapping，或用户明确的 continue 动作，才允许恢复已有 Conversation。
- replyTo 是送达地址；conversationId 是上下文容器；taskId 是执行对象，三者不能互相推导替代。

## 跨对话边界

- 新对话默认加载 confirmed/live Memory 和用户明确选择的 Task 摘要。
- inferred/expired/deleted Memory、旧对话全文、未选择的 Task 输出、其他 Profile 内容不进入默认上下文。
- 搜索可以跨对话查找用户有权访问的 Task/Asset/Memory，但搜索结果不会自动改变当前对话历史。

## 验收出口

- 连续创建两个新对话，消息历史、标题和最近活动互不混淆。
- 同一对话创建两个 Task，两个 Ticket 独立且都回到正确的 sourceConversationId/replyTo。
- 新对话显式接续一个 Task 后能读取任务摘要并继续，不会收到旧对话全文。
- 没有明确绑定的平台消息不进入已有对话。
- 归档/删除 Conversation 不删除 Task/Asset/Memory。
- 网页/API/移动端使用同一 request/response 合同；真实移动端验收留到 F6/F7授权范围。

当前状态：合同完成，源码迁移和平台接线尚未实施；A3 frozen implementation remains an unmerged candidate pending this model.
