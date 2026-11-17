# P2-T4 · WorkerDriver SPI 冻结验收

状态：**完成（离线验证）**；真实驱动实现未验收。

## 内容

- src/drivers/types.ts：BackendKind、DriverHealth、WorkerSpec/LaunchSpec、RunningTurn、WorkerEvent、TurnResult、FeedResult、WorkerDriver、failedResult。
- tests/driver-contract.spec.ts：身份透传、launch/resume 形状一致、失败不得伪装 completed。

## 证据

- 隔离快照 /tmp/ordin-gate-p2t4-20261115：npm run check 退出码 0；22 文件 / 553 测试通过（/tmp/ordin-p2t4-gate.log）。
- 变异：failedResult 强制 status=completed，契约测试退出码 1（预期红，/tmp/ordin-p2t4-mutation.log）。
- 还原哈希一致；最终闸门退出码 0（/tmp/ordin-p2t4-final-gate.log）。

## 冻结规则

- 之后改本契约须在账本申请变更；已实现驱动要同步迁移。
- P0 证据表明 DSH/Codex/Claude 真实探针被认证阻塞；契约冻结不表示驱动功能完成。
