# Ordin 项目拓扑

> 本文把产品长期结构纳入工程。它描述系统责任边界，不把未实现层写成已完成能力。当前工程目标仍是 Ordin 独立运行。

## 总体拓扑

```
人（意图、决策、监督）
  ↕
个人数字人格（身份、长期记忆、上下文、行为连续性）
  ↕
Ordin（对话协调、任务、授权、派工、资产、验收、回程）
  ↕
手机操作端（APP、通知、设备能力、现实交互）
  ↕
现实世界（信息、服务、应用、设备、外部环境）
```

- 人决定意图、范围和风险。
- 个人数字人格回答“是谁、记得什么、习惯如何连续”。
- Ordin 把意图变成可授权、可跟踪、可验收的工作。
- 手机端是设备交互层。
- 现实世界是读取、改变或验证的外部对象。

## 当前 Ordin 数据流

```
消息/事件 → Conversation → Coordinator → Policy/Mandate
          → Ticket → Assignment → WorkerDriver
          → DSH/Codex/Claude → Report
          → Independent Acceptance → Asset/Memory update
          → Delivery → 原渠道/面板/RESULT.md
```

当前实现有 Source、Gate、Ticket、Assignment、Driver、Delivery、Artifact/SavedSkill 基础；个人数字人格、手机操作端、完整长期记忆、独立验收闭环和真实渠道验收仍未完成。

## 三类流

### 控制流

人消息进入 Coordinator。模型建议直接回复、查询、建任务、追加输入、暂停、取消、记忆提议或澄清；Ordin 程序核验身份、授权、幂等、状态和执行者健康后才执行。

### 数据流

现实输入和 worker 产物进入 Ordin，登记来源、作用域、时间和使用关系；Coordinator 按任务权限检索；只把最小数据/技能投射到临时任务目录。

### 反馈流

worker 报告 ready 只是声明；Ordin 检查文件、测试、结构和来源。通过才交付；失败进入返工；无法检查则标 unverified。

## 资产生命周期

1. 临时资产：只给当前 Ticket 使用。
2. 候选资产：任务产生且有来源/验证记录，等待晋升。
3. 长期资产：通过验证、带权限和适用范围，可被后续任务检索。

worker 可以在任务目录创建临时工具，但不能直接修改全局技能池。

## 组件责任

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Source/Bridge | 输入归一和原渠道回程 | 最终验收、长期记忆 |
| Coordinator | 理解、直接回复、查询、建任务、计划、记忆提议 | 绕过权限执行 |
| Policy/Engine | 门禁、授权、Ticket/Assignment、审计 | 内容质量判断 |
| Asset/Memory Store | 资产/记忆来源、作用域、使用和纠错 | 把任意 worker 文本自动当事实 |
| WorkerDriver | 启动、续接、取消、事件、终局 | 用户身份、全局资产、最终验收 |
| Acceptance | 可验证的文件/测试/结构/来源检查 | 无法检查的主观质量 |
| Delivery | 状态和限制回传 | 把失败写成成功 |
| Panel/Mobile | 展示、对话、通知、设备入口 | 第二套数据库 |

## 阶段映射

| 阶段 | 拓扑工作 |
| --- | --- |
| M0 | 冻结 Conversation、Asset、Memory、Acceptance、Coordinator 工具合同 |
| M1 | 对话→分流→Ticket→worker→验收→回程；最小记忆和资产复用 |
| M2 | 面板、通道身份、资产池、记忆管理、名称迁移 |
| M3 | 真实后端、真实渠道、浏览器、安装升级回滚；手机端另立阶段 |

## 拓扑验收故事

1. 任一渠道闲聊直接回复，不建无意义 Ticket。
2. 交代任务时说明处理方式，选择 worker，投射最小资产，独立验收后回原渠道。
3. 换渠道追问同一事项能找到原任务，不重复派工。
4. worker 创建的工具先在当前任务验证，再决定是否晋升。
5. 用户纠正偏好后，后续任务能使用；用户能查看、纠正、删除。

每个故事区分离线假 worker、真实后端、真实渠道、浏览器四种证据等级。


## Ordin 内部拓扑（核心工程图）

本节展开 Ordin 自己的责任层。外部五层拓扑是“人—个人数字人格—Ordin—手机操作端—现实世界”；内部核心是：

	a 用户/入口
	  ↓
	Conversation（身份、渠道、对话上下文）
	  ↓
	Coordinator（闲聊/任务判断、查询、计划、澄清、派工决策）
	  ├─ Memory Store（偏好、项目事实、任务经验）
	  ├─ Asset Store（数据、报告、技能、工具、血缘）
	  └─ Policy/Planner（授权、范围、验收条件、预算）
	       ↓
	    Ticket / Work / Assignment
	       ↓
	    Worker Router
	       ├─ DSH Driver
	       ├─ Codex Driver
	       └─ Claude Code Driver
	              ↓
	          Worker Process
	              ↓
	          Report / Events
	              ↓
	          Independent Acceptance
	       ├─ accepted → Delivery → 原渠道/面板/RESULT.md
	       ├─ rework → 新 Assignment（保留原目录与失败原因）
	       └─ unverified → Delivery（明确未验证）

### 内部层的责任边界

| 层 | Ordin 负责什么 | Worker 不得拥有的责任 |
| --- | --- | --- |
| Conversation | 身份、来源、对话与任务关联 | 不能按同名自动合并身份 |
| Coordinator | 直接回答、查询、建/改/停任务、澄清 | 不能声称未执行动作已完成 |
| Memory | 有来源/范围/时间/置信度的偏好、事实、经验；纠正/删除 | Worker 自述不能直接成为确认事实 |
| Asset | 数据、产物、技能、工具、版本、权限、来源、使用记录 | Worker 不能直接晋升全局资产 |
| Policy/Planner | 授权、计划、预算、验收条件、派工理由 | 模型文本不能覆盖确定性授权 |
| Ticket/Work | 任务、项目、依赖、Assignment、审计 | 状态不能只存在模型上下文 |
| Router/Driver | 选择、启动、续接、取消、事件、真实终局 | 换 Worker 不换身份/记忆/资产归属 |
| Acceptance | 独立核验文件、测试、结构、来源 | ready 不等于验收通过 |
| Delivery | 回传结果、限制、阻塞 | 不能把失败改写成功或静默丢回程 |

### 三类资产的生命周期

| 对象 | 例子 | 任务中如何使用 | 生命周期 |
| --- | --- | --- | --- |
| Memory | 用户偏好、项目事实、任务经验 | Coordinator 按相关性读取，带来源 | 可纠正、过期、删除 |
| Data Asset | CSV、报告、网页资料、代码产物 | 授权后按需投射给 Ticket | 版本化、可追溯、可归档 |
| Tool/Skill Asset | 脚本、技能、模板、流程 | 匹配后临时物化 | 默认任务级，验证后才晋升 |

### 当前实现映射

| 拓扑层 | 当前基础 | 当前缺口 |
| --- | --- | --- |
| Conversation | desk history、chat Thread、/ordin/chat API | 所有渠道共享 profile/conversation 尚未完整接通 |
| Coordinator | DeskLoop、Coordinator tools、独立 LLM client | 统一入口和跨渠道协调仍在 M1 |
| Memory | MemoryEntry v8、propose_memory、global 注入 | 提取、纠错/删除 UI、过期策略、真实闭环缺失 |
| Asset | Asset v8、Artifact、SavedSkill、search_assets | 目录、权限/版本生命周期、按任务投射、使用回执缺失 |
| Policy/Planner | Gate、Mandate、executor 设置 | 用户计划、任务级验收/路由决策尚未完整运行 |
| Ticket/Work | Engine、Ticket、Assignment、Work、Effects | 预算/恢复/执行状态仍有可靠性缺口 |
| Router/Drivers | DSH/Codex/Claude 驱动、路由、健康探测 | 本机真实认证阻塞，成功路径未实测 |
| Acceptance | 四检查器、pending/rework/unverified 合同 | Executor 整机集成仍有 RESULT.md 回归待修 |
| Delivery | RESULT.md、通知、桥回程 | 真实平台端到端未验收 |

### 工程阶段

- **M0**：冻结 Conversation、Asset、Memory、Coordinator Tools、Acceptance 合同。
- **M1**：对话协调闭环、数据模型、独立验收、最小记忆和资产复用。
- **M2**：面板七区、资产/记忆管理、全渠道身份、零豁免命名迁移。
- **M3**：真实后端、真实渠道、浏览器、安装升级回滚验收。

关键不变量：Worker 可替换；Conversation、授权、Ticket、Memory、Asset、Acceptance、Delivery 由 Ordin 持有。模型变强应减少协调摩擦，不应让用户迁走身份、记忆、资产或任务历史。
