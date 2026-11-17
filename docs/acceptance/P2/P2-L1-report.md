# L1 报告解析组件验收

状态：**完成（离线验证）**；真实模型遵守协议率未验证。

- src/drivers/report.ts：无块=none；合法块=core Report；多块/坏 JSON/非法 state/缺 question=invalid。
- tests/report.spec.ts 正反用例 4 组；tests/dsh-driver.spec.ts 增加 fake DSH 合法块集成用例。
- 同一快照 /tmp/ordin-gate-p2boot-report-20261115：退出码 0。
- DSH 驱动若收到坏块会 protocol_error，不把坏报告当成功。
