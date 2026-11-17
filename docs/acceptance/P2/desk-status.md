# 总管状态 API 接线

离线集成验证通过；真实 provider 未验证。Runtime 实现 HttpHost.desk.status()，HTTP GET /ordin/api/desk/status 每次读取 DeskLoop.getStatus()，反映当前 configured/state/provider/model/recentErrors。保存配置后无需重启即更新。总管未配置时返回 configured=false；健康条目保持不健康，不被普通 ticket event 的 refresh 清掉。

验证：Runtime 真 HTTP server + 状态 API；配置→未配置→配置在线变更；每次响应断言。隔离快照 `/tmp/ordin-desk-status-path`，全量闸门退出码 0，42 文件 / 804 测试。变异把 status 硬编码 disabled，Runtime 测试退出 1；还原 sha256 e041e64b93552195c8b106e24b48608c24d9d67ef8c9953263eb1c94bbfc2949，恢复后全量闸门退出 0。真实模型调用未测试。
