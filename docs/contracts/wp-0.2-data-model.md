# WP-0.2 数据模型 v8

状态：契约文档。schema v7→v8 变更冻结后进入 M1 实施。

## 新增实体

### Conversation（对话线程）

    interface Conversation {
      readonly id: string                    // conv-<uuid>
      readonly profileId: string             // 所属用户（M1 单用户固定 "default"）
      readonly channels: readonly { readonly kind: string; readonly externalId: string }[]
      readonly createdAt: string
      readonly lastMessageAt: string
      readonly title?: string                // 自动摘要
    }

### ConversationMessage

    interface ConversationMessage {
      readonly id: string
      readonly conversationId: string
      readonly role: "user" | "ordin" | "system"
      readonly content: string
      readonly at: string
      readonly sourceChannel: { readonly kind: string; readonly externalId?: string }
      readonly actions?: readonly { readonly tool: string; readonly args: unknown; readonly result?: string }[]
    }

### Asset（数据资产）

    interface Asset {
      readonly id: string                    // asset-<uuid>
      readonly kind: "document" | "dataset" | "report" | "code" | "reference"
      readonly name: string
      readonly description: string
      readonly source: { readonly ticketId?: string; readonly path: string; readonly externalUrl?: string }
      readonly createdAt: string
      readonly updatedAt: string
      readonly tags: readonly string[]
      readonly license?: string
      readonly accessLevel: "private" | "project" | "shared"
      readonly contentHash?: string
      readonly usageCount: number
      readonly archived: boolean
    }

### MemoryEntry（记忆条目）

    interface MemoryEntry {
      readonly id: string                    // mem-<uuid>
      readonly kind: "preference" | "project-fact" | "task-lesson"
      readonly content: string
      readonly scope: string                 // "global" | project/workId
      readonly sourceTicketId?: string
      readonly createdAt: string
      readonly updatedAt: string
      readonly confidence: "confirmed" | "inferred" | "deprecated"
      readonly expiresAt?: string
      readonly useCount: number
    }

### Ticket 扩展（v8 新增字段）

    interface Ticket {
      // 现有字段不变，新增：
      readonly acceptance?: {
        readonly status: "pending" | "accepted" | "rework" | "unverified"
        readonly checks?: readonly { readonly name: string; readonly passed: boolean; readonly detail?: string }[]
        readonly checkedAt?: string
        readonly reworkReason?: string
      }
      readonly conversationId?: string       // 来源对话
      readonly plan?: readonly string[]      // 派工说明步骤
      readonly workerBackend?: string        // 实际选择的后端
      readonly estimatedBudgetMs?: number
    }

## 存储映射

- Conversation / ConversationMessage / Asset / MemoryEntry：各一张新表，schema v8 迁移时 CREATE TABLE IF NOT EXISTS。
- Ticket acceptance/plan/workerBackend：JSON record 内新增字段，旧记录读取时为 undefined（无 migration）。
- M1 单用户固定 profileId = "default"；多用户是 M3 之后方向。

## 迁移与回滚

- v8 迁移：只增不改不删；旧 v7 数据库打开时自动建新表、写 schema_version=8。
- 回滚：v8 新表独立，回滚到 v7 代码只是忽略新表，不丢数据。
- 首次在用户真实 stateDir 执行迁移前：自动复制 ordin.sqlite3 → ordin.sqlite3.bak-v8。

## 验收

- 类型文件编译通过。
- 迁移测试：v7 fixture → 打开 → 新表存在 → schema_version=8；二次打开幂等。
- 旧 v7 数据不丢失（fixture 含 trigger/ticket/effects，迁移后可读）。
