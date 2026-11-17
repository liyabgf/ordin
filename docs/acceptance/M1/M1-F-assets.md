# M1-F 最小资产复用验收

状态：**完成(离线)**。

## 实现

- Runtime.registerAssetsFromTicket：done 任务 result.files 每项注册为 Asset（幂等 id=ticket前8位+文件名派生；kind 按扩展名 document/dataset/code/report；description=summary 前 200 字；source={ticketId, path}；accessLevel=project；usageCount 保留）。
- 接线：ticket.ended 事件处理器内同步注册，异常进 health 板（不毒化事件分发）。
- store.assets.list({includeArchived:true}) 查询修复：此前把参数当 archived=1 只查已归档行——这是上轮“注册了也查不到”的第二根因。
- create_task 的 assetRefs 已在 M1-B 支持解析为附件路径投射；search_assets 已能同时检索资产与记忆。

## 验收证据

- runtime 流程测试：假 worker 产出 result.md 并在报告声明 → Ticket done → 资产 waitFor 内出现，source.ticketId 匹配，search(完成) 命中 description。
- 隔离闸门：47 文件 / 853 测试，退出码 0（/tmp/ordin-m1f-final.log）。
- 变异：跳过 ticket.ended 注册调用，runtime.spec 退出 1；还原 sha256 102f00f9cc1ae7236a3335f0e5ad786dfb6d5ac1a9102ec526a93ad5f2b0347c；恢复闸门退出 0。

## 未覆盖

- 真实文件的按需投射（复制进新任务目录）目前经 attachments 路径实现，跨任务按权限检索的完整生命周期在 M2-A/B。
- 使用回执（usageCount 自增）的调用点在 M2-B 接线。
