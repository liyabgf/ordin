# 安装、升级与恢复

状态：维护路径文档/离线CLI合同；未有对外安装包或正式发布候选。package仍private，不能把npm pack称为可安装产品。

## 前置条件

- Node.js >=24.9.0；仓库当前实测Node 24.21.0。仓库同时有npm与pnpm lockfile，选择其中一套并按对应lockfile安装；本手册使用npm ci。发布前还需干净目录安装证据和依赖版本清单。
- 每个Ordin实例使用自己专属config/stateDir/workRoot/inbox/port；绝不复用另一个用户或现役宿主状态目录。Worker版本和安全flag必须通过准入；当前DSH0.2.1-rc.2会被拒，Codex额度不足，Claude版本未证实。
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
2. 确认SQLite未被任何进程占用；用独立存在的输出路径做WAL-aware backup。备份与SQLite一起保存到权限受控位置。
3. 将代码更新到明确commit；在副本目录安装锁定依赖、跑`npm run check`；schema迁移测试应过后才备份生产副本迁移。
4. 启动后确认Runtime状态/schema版本/source及worker probes，先创建最小无副作用任务。未经真实provider/callback验收不要开放外部Bridge。
5. 保留旧commit和DB/credentials分别的恢复材料。

显式数据库备份：

```sh
node --experimental-transform-types src/index.ts storage backup --state-dir /absolute/existing/stateDir --output /absolute/new/ordin-before-upgrade.sqlite
```

必须使用目标实例的实际CLI参数说明复核；output不得是SQLite本体/已存在文件。CLI只备份database，不包含credentials、work artifacts、uploads或bridge状态。

## 回滚

代码回滚和数据回滚是两件事。先停服务、确认SQLite无锁，保留失败版本数据一份新副本用于分析；目标旧代码只支持其schema时才在一个**新的临时stateDir**用离线restore恢复兼容备份，校验`PRAGMA integrity_check`与项目`schema_version`表（当前目标为9）再启动。绝不直接用旧代码打开新schema数据库。生产回滚前验证路径、版本和备份hash，并由operator确认；本文不授权/记录对现役用户库做restore。

```sh
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/new/rollback-state --input /absolute/ordin-compatible-backup.sqlite
```

Restore目标必须是已存在的专用stateDir；工具制作原数据库旁备份并保留rollback策略，但仍须在临时副本验证。凭据文件独立保留并按最小权限重新配置，不会从数据库恢复。

## 已核验限制

〔离线验证〕schema1..9 migration、损坏schema拒绝、WAL-aware backup/restore、锁/路径拒绝测试存在；serial full gate当前证据见状态表。

〔未验证〕干净非开发机首次安装/实际升级生产库/停机后无写入/旧版本恢复真实work artifacts/渠道凭据恢复；没有正式npm包、签名release artifact或release hash，因此不得提供版本安装命令或向外宣称发布。
