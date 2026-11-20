# 安装、升级与恢复

状态：维护路径文档/离线CLI合同；未有对外安装包或正式发布候选。package仍private，不能把npm pack称为可安装产品。

## 前置条件

- Node.js >=24.9.0；仓库当前实测Node 24.21.0。仓库同时有npm与pnpm lockfile，选择其中一套并按对应lockfile安装；本手册使用npm ci。发布前还需干净目录安装证据和依赖版本清单。
- 每个 Ordin 实例使用专属 config/stateDir/workRoot/inbox/port。Worker 版本与权限参数须符合准入条件。Codex CLI `0.169.0-alpha.11.1` 已通过四探针并完成真实任务验收。DSH `0.2.1-rc.2` 的 CLI 缺少只读任务所需参数，按服务模式接入。Claude Code CLI `2.1.325` 已定位，但 `auth status` 显示未登录，尚未验收。见 [Worker 准入记录](acceptance/F6-worker-admission.md)。
- API key通过模型配置界面/API写入独立凭据文件（0600）；没有交互式凭据CLI。目录需要可访问的执行权限，不设成0600。不要将key写入普通settings或提交日志；bridge token保留在bridge自己的env配置。

## 干净目录运行（开发/验收路径）

```sh
git clone <ordin-repository> ordin
cd ordin
npm ci
npm run check
ORDIN_STATE_DIR="$HOME/.local/state/ordin-instance" \
ORDIN_WORK_ROOT="$HOME/.local/share/ordin-instance/work" \
ORDIN_INBOX_DIR="$HOME/.local/share/ordin-instance/inbox" \
ORDIN_PORT=7472 npm start
```

仓库`package.json`仍`private: true`且`start`直接运行`src/index.ts`，依赖Node实验性类型转换；以上是源码检出运行，不是稳定用户安装器。部署前检查 Node/npm、默认端口锁、work/state目录权限和Worker可执行文件版本。默认不开server端口替代已在运行实例；停止测试实例确认退出和端口释放。

## 升级

1. 通过面板停派工并优雅停Runtime，等待child Worker收尾。若进程被kill，启动后uncertain Ticket不会自动重跑；先人工检查真实子进程/workspace。
2. 停止所有写入并确认 `ordin.lock` 已消失。用独立输出路径执行维护 CLI 备份。数据库引用托管对象时，CLI 同时生成同名 `.assets/` 目录，复制当前及历史对象并校验 SHA-256。将备份材料一起保存到权限受控位置。
3. 将代码更新到明确commit；在副本目录安装锁定依赖、跑`npm run check`；schema迁移测试应过后才备份生产副本迁移。
4. 启动后确认Runtime状态/schema版本/source及worker probes，先创建最小无副作用任务。未经真实provider/callback验收不要开放外部Bridge。
5. 保留旧commit和DB/credentials分别的恢复材料。

显式数据库备份：

```sh
node --experimental-transform-types src/index.ts storage backup --state-dir /absolute/existing/stateDir --output /absolute/new/ordin-before-upgrade.sqlite
```

如生成 `/absolute/new/ordin-before-upgrade.sqlite.assets/`，请将它与数据库一起保存。输出数据库和目录均须为新路径。凭据、工作文件、uploads 和桥状态需按各自位置单独保存。恢复会先校验数据库及全部对象，在状态锁下补齐不可变对象，最后替换数据库。常规异常时清理本次新增对象，保留已有对象和已生成的回滚材料。

恢复前后检查：目标必须是已停写的独立 stateDir；把 `.assets/` 目录与数据库放在一起，执行 restore 后运行只读验证：

```sh
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/new/rollback-state --input /absolute/ordin-compatible-backup.sqlite
node --experimental-transform-types src/index.ts storage verify --state-dir /absolute/new/rollback-state
```

`verify` 要求无运行锁和 SQLite sidecar；它核对 schema、数据库完整性及所有当前/历史托管对象的摘要。它不核对 workRoot、credentials、uploads、bridge 状态，也不证明应用可启动。

## 回滚

代码回滚和数据回滚是两件事。先停服务、确认SQLite无锁，保留失败版本数据一份新副本用于分析；目标旧代码只支持其schema时才在一个**新的临时stateDir**用离线restore恢复兼容备份，校验`PRAGMA integrity_check`与项目`schema_version`表（当前目标为9）再启动。绝不直接用旧代码打开新schema数据库。生产回滚前验证路径、版本和备份hash，并由operator确认；本文不授权/记录对现役用户库做restore。

```sh
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/new/rollback-state --input /absolute/ordin-compatible-backup.sqlite
```

Restore目标必须是已存在的专用stateDir；工具制作原数据库旁备份并保留rollback策略，但仍须在临时副本验证。凭据文件独立保留并按最小权限重新配置，不会从数据库恢复。

## 已核验限制

〔离线验证〕schema1..9 输入兼容、损坏 schema 拒绝、WAL-aware backup/restore、当前/历史托管对象恢复、对象摘要和锁/路径拒绝见 [F3-A2](acceptance/F3/F3-A2-storage-cli.md) 与 [R1 修复验收](acceptance/R1-recovery-integrity.md)。

〔离线验证〕已从同一备份恢复数据库及托管对象，将合成私有配置单独恢复为 `0600`，再启动实例并检查正文及历史元数据。坏包被拒后原目标仍可验证。生产停机窗口、真实 stateDir 及工作区材料的完整恢复待现场验收。见 [R1 恢复后启动复验](acceptance/R1-recovery-integrity.md#同一备份恢复后启动复验)。

〔未验证〕干净非开发机首次安装、生产库升级/回滚、work artifacts/渠道凭据恢复；没有正式 npm 包、签名 release artifact 或 release hash，因此不得提供版本安装命令或向外宣称发布。
