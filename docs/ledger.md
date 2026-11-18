# Ordin Publication Ledger

先写后做：先登记改动意图、文件范围和验证方式，再进行实现或发布。

## Task asset references

- The publication includes fixed-version asset selection for new work and durable asset inputs for open tasks. Queued does not claim consumption.
- The isolated repository gate passed before push. Real worker-backend consumption remains separately unverified.
- Never publish private development ledgers, machine paths, runtime logs, task data, databases, state/work directories or credentials.
