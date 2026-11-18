# Ordin Publication Ledger

先写后做：先登记改动意图、文件范围和验证方式，再进行实现或发布。

## Explicit asset relationships

- Synchronize only the reviewed catalog, HTTP route, asset page and regression tests. Never copy the source development ledger.
- Relations show same-source provenance and selected pinned revisions, not confirmed consumption. Relation loading failures do not prevent preview.


## Asset library publication

- This repository is a sanitized publication copy of the independent Ordin source repository.
- The AL-1 asset archive and library panel slice was validated with the repository test gate before publication.
- Private development ledgers, machine paths, runtime logs, task records, databases, work directories, service tokens and model credentials are excluded.
- Source development stays in `ordin`; only this publication repository pushes to GitHub.
