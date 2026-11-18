# Ordin Publication Ledger

## 双语 README 更新（2026-11-18）

- 修正上游归属和启动地址，补齐当前功能、限制和英文说明。范围为中英文 README、账本；源仓另记录已确认的发布文档错误。验证链接和隔离回归后推送发布仓。

先写后做：先登记改动意图、文件范围和验证方式，再进行实现或发布。

## PANEL-6 public release (2026-11-18)

- Scope: sync only public runtime code, panel pages, regression tests, browser verifier, and user-facing documentation from source commit b931e96. Exclude private incident registers, operational ledgers, acceptance reports, temporary paths, runtime logs, task data, databases, state/work directories and credentials.
- Include the connection setup, progress and input receipt changes used by the panel. Release preparation corrected an invalid ledger anchor and excluded unrelated bridge/process files and internal draft reports before staging.
- Verification: stage a temporary publication tree; run secret/path scan, typecheck, serial full suite and diff review before committing and pushing.

## Asset library follow-up

- Scope: reviewed changes to asset, home and workspace panels, catalog, runtime, executor, HTTP, DSH service and router, and six regression suites. Keep the source ledger, runtime evidence and credentials out of this repository. Verify the staged publication tree in isolation before release.

## Task asset references

- The publication includes fixed-version asset selection for new work and durable asset inputs for open tasks. Queued does not claim consumption.
- The isolated repository gate passed before push. Real worker-backend consumption remains separately unverified.
- Never publish private development ledgers, machine paths, runtime logs, task data, databases, state/work directories or credentials.
