# 工程状态（唯一事实源）

更新：2026-11-17。代码基线 d5fd3fd；最新完整规划见 [执行规划 v2](33-functional-execution-plan.md)。

## 当前执行状态

**F1-R、F3-A1/A2、F3-B1、F3-C1已完成离线验证。F3-B2启动意图与F3-C2默认Profile边界正隔离实施。** 真实Codex任务已尝试但额度用尽，未获成功验收；现役服务未修改。

| 项目 | 状态/等级 | 证据 |
| --- | --- | --- |
| F0 LLM 接入与实际对话 | 用户真实验收 | [F0](acceptance/M1/F0-user-acceptance.md) |
| F1-A Ticket 后端路由 | 完成(离线)，e99ff2f | [F1-A](acceptance/F1/F1-A-worker-routing.md) |
| F1-B 进度查询与事件保存 | 完成(离线)，a50e754 | [F1-B](acceptance/F1/F1-B-progress-reporting.md) |
| F1-C 返工与取消确认 | 完成(离线)，d5fd3fd；逐任务暂停未实现 | [F1-C](acceptance/F1/F1-C-rework-cancel.md) |
| F1-R1/R2/R3 协议、派工约束、验收及原会话回报复核 | 完成(离线)，证据 acceptance/F1/F1-R-readiness.md | [规划第四节](33-functional-execution-plan.md#四f1可信任务闭环) |
| F1-D1/D2/D3 真实后端准入、任务及评测 | 部分完成/阻塞于额度 | Codex 0.166.0-alpha.6认证OK，但真实任务提示 usage limit；DSH 版本不满足driver能力；详见ledger F1-D探测 |
| F3-A1 迁移快照与准入 | 完成(离线)，d66990d | [F3-A1](acceptance/F3/F3-A-storage-recovery.md) |
| F3-A2 显式离线备份/恢复CLI | 完成(离线) | [F3-A2](acceptance/F3/F3-A2-storage-cli.md) |
| F3-B1 不确定Worker保守恢复 | 完成(离线)；保护遗留running，pending窗口待B2 | [F3-B1](acceptance/F3/F3-B1-uncertain-recovery.md) |
| F3-C1 记忆确认来源 | 完成(离线)，e11a01a | [F3-C1](acceptance/F3/F3-C1-memory-confirmation.md) |
| F2-A 资产/技能/记忆复用生命周期契约 | 完成(文档) | [F2-A](contracts/f2-reuse-lifecycle.md) |
| F2-D1 记忆候选/确认/纠正/删除API | 完成(离线)，管理UI待做 | [D1](acceptance/F2/F2-D1-memories.md) |
| F2-D2 记忆管理入口 | 完成(离线行为验证)，浏览器待验 | [D2](acceptance/F2/F2-D2-memory-panel.md) |
| F2-B1 产物稳定身份/哈希/候选登记 | 完成(离线) | [B1](acceptance/F2/F2-B1-assets.md) |
| F2-B2 资产目录与显式导入API | 完成(离线)，浏览器待验 | [B2](acceptance/F2/F2-B2-assets-catalog.md) |
| F2-C1 版本技能按需投射 | 完成(离线)，使用回执待做 | [C1](acceptance/F2/F2-C1-skills.md) |
| F2-C2 候选技能语法验证/显式晋升 | 完成(离线)，浏览器待验 | [C2](acceptance/F2/F2-C2-skill-candidates.md) |
| F2-E1 资产跨任务revision/hash复用 | 完成(离线)，实际成功回执待做 | [E1](acceptance/F2/F2-E1-asset-reuse.md) |
| F3-E1 模型错误与诊断脱敏 | 完成(离线) | [E1](acceptance/F3/F3-E1-diagnostic-redaction.md) |
| F3-C2 Profile与Asset授权 | 完成(离线) | 默认Profile工具边界和已注册产物授权，真实多用户认证未实现 |
| F3-B2 启动前持久意图与迟到事件围栏 | 完成(离线) | [F3-B2](acceptance/F3/F3-B2-spawn-intent.md) |
| F3-B3 Effects generation/CAS、schema9 | 完成(离线) | [B3](acceptance/F3/F3-B3-effect-fencing.md) |
| F3-D1 显式任务预算/跨重试墙钟 | 完成(离线) | [D1](acceptance/F3/F3-D1-task-budget.md) |
| F3-D2 attempt用量账本 | 完成(离线) | [D2](acceptance/F3/F3-D2-usage-ledger.md) |
| F3-D3 永久失败终局收据 | 完成(离线) | [D3](acceptance/F3/F3-D3-terminal-receipt.md) |
| F3-E/F 回程策略、脱敏与故障矩阵 | 离线基线已汇总，真实chaos/环境权限仍待验 | [矩阵](acceptance/F3/F3-F-fault-matrix.md) |
| F2-A–F2-F 资产、技能、记忆复用 | AL-0合同与AL-1独立自动归档/资产面板首切片完成；新任务/运行中引用、AI关系、Skill/Tool投射未完成 | [F6-P3计划](acceptance/F6/F6-P3-asset-library-ux-plan.md)；离线门74文件/1209项；隔离Chrome已验收 |
| F4-A1 统一入口门禁/幂等收据 | 离线验证 | [F4-A1](acceptance/F4/F4-A1-intake.md) |
| F4-A2 平台聊天显式对话模式 | 离线验证，任务异步回程待A3 | [A2](acceptance/F4/F4-A2-chat.md) |
| F4-A–F4-E 入口身份、来源统一与真实渠道 | A1/A2离线完成，A3异步回程待做，真实桥未验 | [F4合同](contracts/f4-envelope-identity.md) |
| F4-D1 场景模型选择 | 离线验证，真实provider待验 | [D1](acceptance/F4/F4-D1-model-scenarios.md) |
| F4-S3/S4 新建/历史/归档会话 | 离线验证，浏览器及平台绑定待验 | [S3/S4](acceptance/F4/F4-S3-S4-conversations.md) |
| F4-S5/S6 跨对话显式接续任务 | 离线验证，浏览器/平台绑定待验 | [S5/S6](acceptance/F4/F4-S5-S6-task-continuation.md) |
| F5-U1/U2/U3/U5 友好面板、任务收件箱、动作合同与视觉修复 | 源码/7471 Chrome门通过；真实任务/用户CP-F5待做 | [F5](acceptance/F5/F5-U1-friendly-panel.md) / [F6-U5](acceptance/F6/F6-U5-dsh-protocol.md) / [F6-U6](acceptance/F6/F6-U6-task-interface.md) |
| F6-A 三后端真实兼容矩阵 | DSH按能力兼容离线通过，真实四探针待验；Codex额度阻塞/Claude未证实 | [DSH能力准入](acceptance/F6/F6-A2-dsh-capability-admission.md) |
| F6-C 安装、升级、备份恢复、回滚 | npm/pnpm clean install及离线恢复通过，真实生产安装待验 | [F6-C](acceptance/F6/F6-C-maintenance-rehearsal.md) |
| F6-B/D/E 渠道、稳定性、最终交付 | 未完成；Chrome E1基础演练通过，E2成功模型回合/真实渠道/长时/用户验收待做 | [F6-E1/E2](acceptance/F6/F6-E1-browser-rehearsal.md) |
| F7-A–F7-C 手机/数字人格/现实连接器 | 延伸设计范围，未授权实施 | F6 后另行定范围 |

最近业务全量基线：F5-U1整合快照69文件/1150项退出0；Chrome页面与窄屏演练通过，真实模型/任务/渠道、F2成功复用回执、长时稳定性及F6用户验收仍未完成。[规划基线](acceptance/roadmap-baseline.md)

## 旧 WP 历史登记（冻结，不作为当前派工或事实结论）

以下保留原始工作包记录便于追溯，其中“未开工”“阻塞”可能早于 M1/F0/F1 提交，不能覆盖上表。凭据是否可用必须重新安全探测；历史条目的缺凭据结论不作为当前阻塞依据。按新工作包实施时用具体证据迁移状态，不做字符串批量升级。

| 工作包 | 名称 | 状态 | 证据 | commit |
| --- | --- | --- | --- | --- |
| `WP-0.1` | `命名迁移合同` | 未开工 | — | `—` |
| `WP-0.2` | `数据模型 v8` | 未开工 | — | `—` |
| `WP-0.3` | `Coordinator 工具合同` | 未开工 | — | `—` |
| `WP-0.4` | `验收合同` | 未开工 | — | `—` |
| `WP-1.1` | `provider 配置与连接检查` | 完成(离线) | acceptance/P4/backend-health.md | `b160d42` |
| `WP-1.2` | `面板配置表单` | 进行中 | 草稿在 /tmp/ordin-desk-panel-in-progress.html | `—` |
| `WP-1.3` | `coordinator 模型分离配置` | 未开工 | — | `—` |
| `WP-2.1` | `Conversation 存储` | 未开工 | — | `—` |
| `WP-2.2` | `Coordinator 循环` | 部分实现 | DeskLoop 已有，工具合同未接 | `—` |
| `WP-2.3` | `HTTP 对话端点` | 未开工 | — | `—` |
| `WP-2.4` | `面板对话界面` | 未开工 | — | `—` |
| `WP-2.5` | `分流回归评测集` | 未开工 | — | `—` |
| `WP-3.1` | `Profile 与渠道身份绑定` | 未开工 | — | `—` |
| `WP-3.2` | `渠道接入统一` | 部分实现 | 桥已迁入，对话流未统一 | `—` |
| `WP-3.3` | `cron/rule 事件接入` | 部分实现 | Source 已有，对话流未接 | `—` |
| `WP-4.1` | `任务计划字段` | 未开工 | — | `—` |
| `WP-4.2` | `Worker Registry` | 进行中 | execution/status 已接 P4/backend-health.md | `b160d42` |
| `WP-4.3` | `逐任务路由` | 完成(离线) | acceptance/P3/backend-routing.md | `e7b93ce` |
| `WP-4.4` | `派工说明与沟通` | 部分实现 | 提示词协议已接 P3/report-prompt.md | `de7dfc4` |
| `WP-5.1` | `connector 稳定层` | 完成(离线) | 三驱动契约测试 | `—` |
| `WP-5.2` | `executor-skill 格式` | 未开工 | — | `—` |
| `WP-6.1` | `交付状态机` | 未开工 | — | `—` |
| `WP-6.2` | `验收检查器` | 未开工 | — | `—` |
| `WP-6.3` | `面板验收视图` | 未开工 | — | `—` |
| `WP-7.1` | `资产目录模型与 API` | 未开工 | — | `—` |
| `WP-7.2` | `面板数据资产页` | 未开工 | — | `—` |
| `WP-7.3` | `LLM 管理助手` | 未开工 | — | `—` |
| `WP-7.4` | `导入/归档/引用` | 部分实现 | Artifact 基础已有 | `—` |
| `WP-8.1` | `技能登记版本化` | 完成(离线) | SavedSkill 收口 | `—` |
| `WP-8.2` | `任务匹配与最小投射` | 部分实现 | 现为全量投射 | `—` |
| `WP-8.3` | `使用回执与效果记录` | 部分实现 | skillUsed 无调用点 | `—` |
| `WP-9.1` | `记忆模型` | 未开工 | — | `—` |
| `WP-9.2` | `记忆提取` | 未开工 | — | `—` |
| `WP-9.3` | `记忆检索注入` | 未开工 | — | `—` |
| `WP-9.4` | `查看/纠正/删除` | 未开工 | — | `—` |
| `WP-10.1` | `任务内造工具流程` | 部分实现 | promote_skill 存在，验收缺失 | `—` |
| `WP-10.2` | `晋升候选通道` | 未开工 | — | `—` |
| `WP-11.1` | `执行事件持久化` | 未开工 | — | `—` |
| `WP-11.2` | `进度查询与回报` | 部分实现 | RESULT.md 与回程已有，进度 API 未接 | `—` |
| `WP-12.1` | `协议流不截断` | 未开工 | — | `—` |
| `WP-12.2` | `崩溃恢复租约` | 未开工 | — | `—` |
| `WP-12.3` | `停机收尾` | 未开工 | — | `—` |
| `WP-12.4` | `状态分离` | 未开工 | — | `—` |
| `WP-12.5` | `预算跨恢复` | 未开工 | — | `—` |
| `WP-12.6` | `用量持久化` | 未开工 | — | `—` |
| `WP-12.7` | `副作用白名单/脱敏` | 未开工 | — | `—` |
| `WP-13.1` | `面板信息架构` | 未开工 | — | `—` |
| `WP-13.2` | `对话页` | 未开工 | — | `—` |
| `WP-13.3` | `任务页` | 未开工 | — | `—` |
| `WP-13.4` | `数据资产页` | 未开工 | — | `—` |
| `WP-13.5` | `工具/技能页` | 未开工 | — | `—` |
| `WP-13.6` | `记忆页` | 未开工 | — | `—` |
| `WP-13.7` | `执行者页` | 未开工 | — | `—` |
| `WP-13.8` | `设置页` | 未开工 | — | `—` |
| `WP-14.1` | `用户可见名称迁移` | 未开工 | — | `—` |
| `WP-14.2` | `协议/数据迁移` | 未开工 | — | `—` |
| `WP-15.1` | `真浏览器验收` | 未开工 | — | `—` |
| `WP-15.2` | `三家真实后端` | 阻塞 | 凭据未配置 docs/p0/auth-recovery.md | `—` |
| `WP-15.3` | `真实通道` | 阻塞 | 渠道凭据未配置 | `—` |
| `WP-15.4` | `安装/升级/回滚` | 未开工 | — | `—` |
