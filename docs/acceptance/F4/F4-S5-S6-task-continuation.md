# F4-S5/S6 跨对话显式接续任务

状态：离线验证；浏览器真测、平台真实绑定和移动端未验收。

`POST /conversations/from-task` 只接受明确 `ticketId`，服务端重新验证 Ticket 未删除、Profile/源Conversation可访问；调用方不能注入 `taskRefs`。成功后新会话没有旧消息，只保存受控 taskRef。Ticket归属、原始replyTo、Worker状态和结束状态不改变。这个动作不发送消息、不自动重启或恢复Worker。

Coordinator 每轮重新读取 taskRefs，最多投影8个任务的 allowlist：id、title、最新assignment state、report summary、ended outcome、acceptance status。不会注入旧对话全文、inputs、文件路径、执行目录、session或任意持久JSON；任务数据作为不可信引用数据处理。删除任务、foreign owner/profile或源会话失效后不再投影。

面板提供完整Task ID输入和“继续任务”按钮：pending期间防双击；成功创建后刷新列表并切换到新会话；原会话草稿保留；失败保留Task ID并显示错误；迟到的创建/list响应不会覆盖用户新选择。

验证：S5 focused 3/3、typecheck0、ownerProfile授权变异exit1并恢复；S6 VM 14/14、typecheck0、pending变异exit1并恢复、generation/list guard变异已执行恢复；整合serial `/tmp/ordin-s5s6-final.log` 67 files/1130 tests exit0。
