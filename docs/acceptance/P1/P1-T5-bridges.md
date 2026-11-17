# P1-T5 · bridges/prompts/panel 迁入验收

状态：**完成（离线验证）**；真实平台收发未验收，属 P4。

## 范围

- telegram / lark / dingtalk / wecom / qq 五桥及 lib；prompts 与 panel 已在 P1-T3 迁入。
- tests/bridges.spec.ts 覆盖 frontmatter、入站/出站、分片、监督、平台 transform、crypt、QQ 协议、README 环境变量一致性。

## 证据

- `diff -qr -x .DS_Store ordin/bridges ordin/bridges` 退出码 0（/tmp/ordin-p1t5-bridges2.diff），内容一致。
- 隔离快照 /tmp/ordin-gate-p1t5-20261115：npm run check 退出码 0；21 个测试文件、550 项测试通过（/tmp/ordin-p1t5-gate.log）。
- 变异：outbound 分片丢首字符，bridges.spec 退出码 1（预期红，/tmp/ordin-p1t5-mutation.log）。
- 还原哈希一致；最终闸门退出码 0（/tmp/ordin-p1t5-final-gate.log）。

## 五态

- 桥协议与离线转换：离线验证。
- 真实 Telegram/飞书/钉钉/企微/QQ 收发：未验证。
