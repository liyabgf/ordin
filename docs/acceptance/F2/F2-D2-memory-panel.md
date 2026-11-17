# F2-D2 记忆管理入口

完成(离线面板行为验证)。设置页增加记忆列表、候选/已确认/过期显示、候选确认、内容/过期修改、软删除、revision冲突保留草稿和显式提出候选。真实panel handler VM 6/6通过，候选确认/错误revision mutation均红后还原；serial typecheck+vitest 59文件/1039项通过，默认并行worker会令storage-maintenance CLI子进程用时超过5秒，未修改测试超时。无浏览器自动化。
