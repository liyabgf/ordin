# WP-0.1 命名迁移合同

状态：契约文档，冻结后进入 WP-14 实施。本文是唯一事实源；实施中的变更须在此更新并登记账本。

## 原则

1. 用户可见的一切都叫 **Ordin**：面板标题、导航、日志前缀、提示词、README、错误消息、CLI banner。
2. 协议标识（工具名、环境变量、存储键、路由）在 M1 同步迁移；迁移完成前旧值仅作只读兼容读取，不再写入新数据。
3. 外部旧项目（ordin 仓库、DSH 官方）的真实 URL 和历史文档引用不改写为虚构路径；以来源标注方式保留。
4. 用户已有数据（SQLite 键、Ticket 目录、桥 .env）提供迁移脚本：备份→迁移→校验→可回滚。

## 分类迁移表

依据 [naming-manifest.json](../audit-rebuild/naming-manifest.json)：94 文件 / 837 处。

### 立即改（M1 首个 commit 起）

| 类别 | 旧值 | 新值 | 数量估计 |
| --- | --- | --- | --- |
| 界面标题/导航/文案 | ordin（面板各处） | Ordin | ~20 处 |
| 日志前缀 | `ordin —` / `ordin runs:` / 混用 | `ordin` | ~40 处 |
| README/文档叙述 | ordin 描述本仓库 | Ordin | ~134 处 |
| 测试临时目录前缀 | `ordin-*-` | `ordin-*-` | ~100 处（零行为影响） |

### M1 协议迁移（同一批次，含兼容读）

| 类别 | 旧值 | 新值 | 兼容策略 |
| --- | --- | --- | --- |
| worker 工具名 | `ordin_report` 等 9 个 | `ordin_report` 等 | 旧名只读：worker 输出仍接受；新 prompt 只教新名 |
| 技能名前缀 | `ordin-*` | `ordin-*` | 读取时两者都识别；新建只用新名 |
| desk 工具名 | `ordin_use_tools` 等 | `ordin_use_tools` 等 | 同上 |
| 报告 fenced 标记 | `ordin-report` | 不变（已是新名） | — |
| 存储键前缀 | `ordin:backend-session:` | 不变（已是新名） | — |

### M1 存储迁移（脚本 + 备份）

| 类别 | 旧值 | 新值 | 迁移方式 |
| --- | --- | --- | --- |
| 锁文件 | `ordin.lock` | `ordin.lock` | 启动时检测旧锁：有则迁移内容到新文件并删除旧文件；无则直接创建 |
| marker | `ordin.json` | `ordin.json` | 同上；旧文件保留只读副本供回滚 |
| SQLite 键 | `ordin:backend-session:` | 不变 | 已是新名 |
| SQLite 文件名 | `ordin.sqlite3` | 不变 | 已是新名 |

### M2 环境变量迁移（桥独立，各桥单独窗口）

| 旧 | 新 | 兼容窗口 |
| --- | --- | --- |
| `ORDIN_*`（各桥 env） | `ORDIN_*` | M2 读两套、写新套；M3 停止读旧 |

### 零豁免

用户要求仓库内零旧词。原豁免项全部改写：AGENTS.md 外部引用描述文字改写；README 现役叙述改写；background 调研文档全文替换旧名；cordis.patch.yml 归档或删除。

迁移完成后 git grep -ci ordin 全仓归零。
