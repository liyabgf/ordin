# P2-T7 · Delivery 验收

状态：**完成（离线组件级验证）**；runtime 端到端接线未验收。

## 实现

- src/app/delivery.ts 全量迁入；DeliveryHost 收窄为 logger/Store/Effects/DeskPort/HealthBoard/lifetime/ProcessRegistry/source/replyLost/writeResultFile/panelPath。
- RESULT.md、notify/send 效果、TwoWaySource 回程、重试与失败可见、附件与成果复用文案、F1 唤醒、F-D5 分诊防回声保留。
- machineNotification 走 ProcessRegistry，非零退出可见。

## 验收

- 子代理：delivery/notify/chat-send 57/57；5 组变异（删 UNDELIVERED、禁 relay、去 TwoWay 收窄、吞非零日志、去附件复用行）均红并还原。
- 主代理基线快照 /tmp/ordin-gate-delivery-20261115：npm run check 退出码 0；36 文件 / 744 测试通过（/tmp/ordin-delivery-gate.log）。
- 交接哈希复核一致：delivery.ts d2949584b8998e427a4851993020707065cf30da2bf73cee866dfdc64db59e8b 等。

## 未覆盖（如实）

1. 原 delivery.spec 的 state-lock 用例归 lock/boot 批次。
2. 整机 runtime 接线：registry 挂载 chat、replyToRequester、watchdogHost、面板路由、main session。
3. reply_lost 域事件落库归 runtime；本卡只断言回调载荷。
4. machineNotification 真进程未实弹。
5. 真实平台收发，属 P4。
