# F2-D1 记忆提议与纠正API

完成(离线，操作入口待做)。新增Memories服务：候选proposal默认inferred；本地operator confirm记录actor/time并要求expectedRevision；edit产生revision/audit且内容更改撤销confirmed；delete软删除；过期/deprecated/deleted不再进入搜索/模型上下文。sourceMessage通过索引查询验证，避免全库笛卡儿扫描。Store JSON record，无schema迁移。

HTTP同源guard下提供list/propose/confirm/patch/delete/revisions；无service host返回501。Coordinator的propose_memory强制inferred，模型不能注入confirmed。默认Profile、Work/source授权沿用F3-C2。

集成冻结快照全量58文件/1033项退出0（/tmp/ordin-f2f3-verified.log）。候选过滤变异令profile-boundary失败，恢复源字节哈希一致且相关定向测试退出0。

边界：UI确认入口尚未做；既有legacy confirmed保留并标审计缺口，未证明其历史上真由用户确认。确认由现有same-origin本地operator API执行，不是面向多租户安全边界。真实任务纠正后复用待F2-F。