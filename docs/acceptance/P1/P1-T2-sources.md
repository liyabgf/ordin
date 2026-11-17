# P1-T2 · src/sources 迁入验收

状态：**完成（离线验证）**；真实聊天平台未验收。

## 范围

- src/sources 全部 7 文件；真实依赖 src/app/health.ts、effects.ts、store.ts、desk-history.ts。
- bridges/lib/*.mjs（chat 测试所需协议库）。
- tests：sources.spec.ts、chat.spec.ts、chat-contract.spec.ts，以及 store/effects/transaction 三组依赖测试。
- desk-history.spec.ts 因覆盖 Cordis/DeskLoop 集成而移出本卡，留待 DeskLoop 批次，不写成桩。

## 证据

- 依赖检查：src/sources 无 @deepseek-ai 导入。
- 首个快照退出码 2：effects 运行时依赖 store；补齐 store/desk-history。
- 第二个快照退出码 2：desk-history.spec 超出本卡范围；移除该测试文件。
- 最终隔离快照 /tmp/ordin-gate-p1t2c-20261115：npm run check 退出码 0；10 个测试文件、356 项测试通过（/tmp/ordin-p1t2-gate3.log）。
- 变异：inbox frontMatter 忽略 title，sources.spec 退出码 1（预期红，/tmp/ordin-p1t2-mutation.log）。
- 还原哈希：abbd3eb92cc59fc53635f4868967db0f31d4d36048cf4b410fd5a03228e87220，前后一致；最终闸门退出码 0（/tmp/ordin-p1t2-final-gate.log）。

## 五态

- cron/inbox/chat/rule/registry、SQLite Store、Effects、Memory/Store 事务契约：离线验证。
- 真实 Telegram/飞书等平台收发：未验证，属 P4。
