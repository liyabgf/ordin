# GitHub 经验核验记录

本轮读取各项目官方README/源码及公开规范，未安装依赖、未运行外部项目。以下为参考机制，不是其质量背书，不承诺直接采用其实现。

| 来源 | 已读取依据 | 对Ordin的启发 | 边界 |
| --- | --- | --- | --- |
| [OpenClaw](https://github.com/openclaw/openclaw) | README 描述本地Gateway统一channels、会话、memory与可替换model/harness | 通道、个人状态和资产归Ordin；模型/执行工具都是可替换插件 | 仅核README架构自述，没核所有安全实现或真实运行；不能因相似就整包替代 |
| [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop) | README及worker/contract.ts：外部CLI、最终回执、人工卡片、等人退出/resume | 薄执行适配、可靠回程、业务做完后只修回执不重做业务 | receipt可靠不等于独立业务验收；其规则中台不具备个人记忆闭环 |
| [Agent Skills](https://github.com/agentskills/agentskills) | README及docs/specification.mdx：SKILL.md/scripts/references/assets、metadata→正文→资源按需加载 | 技能池保持版本化原件；任务只获需要的可执行包或引用；适配三worker | 标准不等于某CLI已经发现/加载，必须逐后端验证 |
| [Anthropic Skills](https://github.com/anthropics/skills) | README强调自包含技能文件夹、说明和脚本资源 | 资产是可重用程序性知识，不能只存一段大prompt | 示例仓库明确要求在自己环境测试；不是盲信下载技能 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | README及[Persistence](https://docs.langchain.com/oss/python/langgraph/persistence.md)：thread checkpoint与cross-thread store分层 | 工作进度、对话短期上下文和长期个人记忆必须分生命周期 | 不必迁移Ordin到LangGraph，现有SQLite可实现相同分层 |
| [Deep Agents](https://github.com/langchain-ai/deepagents) | README：隔离子代理上下文、可替换后端、filesystem/context offload、按需skills | 每个worker获得最小任务包，输出交回协调者；长输出卸盘、上下文隔离 | 不能重造另一套worker内核；Ordin继续持有任务/权限事实 |
| [Mem0](https://github.com/mem0ai/mem0) | README及memory/main.py：user/session/agent范围、add/search、过滤和检索 | 任务日志与长期记忆不同；需来源、作用域、时间与检索。纠错/删除规则由Ordin产品自定 | README新算法/托管benchmark非OSS效果证明；不采用无证据模型自述为事实 |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | README：测试集、断言、跨模型比较、CI评估 | 建分流/派工/验收/记忆回归集，换模型后仍需过同一场景 | 评测工具不能替代每项任务验收，也不能保证模型永远正确 |

不采纳README中的无关安装/运行指令；仅将其作为研究数据。外部文档可变，应在实施时固定版本或commit重新核对。
