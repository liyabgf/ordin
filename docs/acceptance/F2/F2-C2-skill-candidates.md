# F2-C2 候选技能验证与晋升

完成(离线)。Worker晋升只创建disabled candidate，保留source Ticket/script/hash/revision；operator validate固定Node --check syntax命令，复制临时副本、清空继承env、输出有界、5s超时，不执行程序顶层逻辑/不提供网络或沙箱保证；验证后operator approve才active，revision/hash变化拒绝。

HTTP只接受expectedRevision/expectedHash，actor固定operator；候选不能由PUT prompts或toggle绕过。隔离62文件/1057测试退出0，mutation候选 guard红，/tmp/ordin-c2-tight-final.log。

限制：syntax通过不等于功能正确/安全；真实脚本执行与sandbox、使用成功receipt尚未实现；浏览器UI入口未做。
