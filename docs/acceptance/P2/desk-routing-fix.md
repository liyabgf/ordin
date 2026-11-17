# 总管通知接线修复

状态：离线整机验证通过；真实 provider 未验证。

修复：Delivery 的 relay(requestId,text,ticketId) 在 Runtime 不再颠倒参数。总管未配置模型时，完成/失败通知通过 notify 留档，不触发模型，也不使 notify effect 反复失败。健康板明确显示总管未配置，避免写成 desk using / 的假健康。

新增 Runtime 整机回归：已配置路径 spy 断言请求编号、正文和 Ticket 身份；未配置路径验证通知恰好一条、relay 未调用、notify 队列清空、健康条目不健康。测试使用真实 Store/Effects/Runtime 和本地假执行器，无外部模型。

隔离快照位置记录于 /tmp/ordin-desk-routing-path。完整 npm run check 退出码 0；41 文件 / 798 测试。变异将 relay 参数改回错误顺序，Runtime 测试退出码 1；还原 sha256 cc89bc861269f0e778be743af0883b1444b7534fb3565be2aef19890a74febf2；还原后完整闸门退出码 0。日志 /tmp/ordin-desk-routing-restored.log。

运行中的 Ordin 未重启，本次代码会在下次启动加载。
