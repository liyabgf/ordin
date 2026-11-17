# M1-D 独立验收状态机验收

状态：**完成(离线)**（含回归修复）。

## 实现

- src/app/acceptance.ts：4 内置检查器（result-nonempty / scope-respected / file-exists / file-readable）+ runAcceptance 判定 accepted / rework / unverified；返工上限 MAX_REWORK=2。
- Engine.setAcceptance / Engine.rework / Engine.annotate。
- Executor.forwardReport：ready 报告默认走验收（acceptanceEnabled !== false，生产默认开；假驱动管道测试可显式关闭）；accepted→报 ready 结案；rework→结束本轮+失败原因 note+新 Assignment（同目录）；unverified→照常结案但 summary 明确标注无法自动验证。
- unverified 标注在异步改写中曾被丢失，本轮恢复并有测试覆盖。

## 回归修复（本批）

- 现象：runtime.spec 集成测试 RESULT.md waitFor 超时。
- 取证定位（A3）：失败点是早前 M1-F 残留的资产断言在等已被移除的注册逻辑；同时验收被误改为 === true 的伪开关（A6 违规，生产默认关闭）。
- 修复：验收恢复默认启用（仅测试可显式关闭）；createRuntime 补 acceptanceEnabled 透传签名；移除流程测试中的 M1-F 残留断言。

## 验收证据

- tests/acceptance.spec.ts 8 项 + tests/executor.spec.ts 验收集成 4 项：存在文件→accepted+done；缺文件→rework（结束原因 rework、新 Assignment running、note 含 did not pass Ordin acceptance）→修复后 accepted+done；两轮返工耗尽→unverified+summary 含 could not verify；无文件报告平凡通过。
- 隔离闸门：47 文件 / 853 测试，退出码 0（/tmp/ordin-m1d-full2.log）。
- 变异：runAcceptance 恒 accepted，集成测试退出 1；还原 sha256 6834e0955b964ae7753e9742cba3df20096bbbde30bfeed830b72786bae77b2b；恢复闸门退出 0。

## 未覆盖

- 真实 worker 的 rework 往返（M3 真后端）。
- test-command / structure-check / source-check 检查器（M2）。
- 面板验收视图（M2-D）。
