# F4-S3/S4 显式新建与历史对话

状态：离线验证；未部署到日常服务、未真实浏览器验收。

会话可显式创建、列出、重命名、归档、恢复及软删除，revision冲突409；旧ID与历史保留，schema仍9。消息历史按seq的message-id cursor读取最新页/更早页，同时间戳不丢页。每轮保存保留元数据和owner；新对话默认只加载本会话任务与已确认记忆。跨对话显式查询仍受Profile策略约束。

面板不再把panel-default硬编码为唯一上下文。新对话按钮生成新ID；历史选择、按会话草稿、重命名/归档/恢复/删除、历史失败重试和更早消息已接管理API。迟到的旧会话请求不会渲染到新会话。删除不删除Ticket/Asset/Memory，模型返回后重查删除状态；任务反馈目标已删除/缺失时保存抑制收据并显示health提示，保留独立任务结果。

验证：后端focused79项、panel真实脚本VM8项分别exit0；删除append guard变异exit1并精确恢复Store；panel selected-ID/generation guard移除后捕获OLD RESPONSE误渲染，精确恢复panel。最终整合快照/tmp/ordin-conversation-final-c80s4o：npm run typecheck及npx vitest run --maxWorkers=1 --no-file-parallelism退出0，66文件/1121项；日志/tmp/ordin-conversation-final.log。

VM测试不代表浏览器布局/移动端实测；平台固定thread映射还需显式活动会话绑定管理，A3来源回程候选未合入；明确任务接续入口待做。
