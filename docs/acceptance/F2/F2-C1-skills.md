# F2-C1 技能版本与显式投射

完成(离线)。SavedSkill保存revision/contentHash/history；Ticket.skillRefs固定name/revision/contentHash。Coordinator没有可信skills目录或引用未知/禁用/哈希不匹配/重复/超过16项时拒绝建票。Runtime提供可信目录，Executor只投射refs的精确历史版本；无refs不投射自定义技能。物化目录使用canonical workRoot、revision/hash路径和O_EXCL/O_NOFOLLOW，拒绝symlink/逃逸。

测试：旧版本编辑后仍投射固定版本；无refs不出skills目录/prompt；坏hash不prepare/launch；技能内容不可变历史保留；路径防护。red-first 2失败；选中版本/坏hash mutation 2/3断言失败；最终隔离serial gate60文件/1050项退出0，/tmp/ordin-f2c1-final.log。

限制：没有实际Worker读取技能成功回执，useCount/skill_used仍未接入真实完成事件；临时工具验证晋升另包；面板技能管理尚未浏览器验收。
