# F2-B1 资产身份与登记

完成(离线)。Runtime ticket.ended不再同步重写Asset，而是入耐久asset-registration effect；handler重读持久Ticket并核验resultKey，服务 realpath/regular file/hash。ID使用完整Ticket ID与规范路径identity/content digest，解决前8位和净化路径碰撞。accepted产物为active，unverified为candidate。

同hash重放幂等并保留operator tags/archive；字节变化生成revision，外部路径/符号链接/目录拒绝。进程重启effect重放不会重建重复版本。

证据：独立snapshot F2资产/runtime定向测试30项；最终完整快照58文件/1033项退出0，/tmp/ordin-f2f3-verified.log。移除AssetRegistration路径校验/内容hash的反向变异失败；部分变异取证在/tmp/asset-service代理日志。记忆confirmed过滤变异也使边界测试失败，源还原SHA256 0ddea73e59f4645f4074882749e58fb4e11c97a3a6577f84ad9b3c0aad485b33；相关恢复后定向测试退出0。

限制：来源只涵盖Ticket reported files和当前Store注册来源；UI CRUD/用户导入/技能按需投射/Usage receipt在后续F2包；没有真实Worker跨任务复用测试。