# F4-A 统一入口信封与身份契约

每个入口输入先归一为Envelope，再交给Engine的Trigger/Conversation。字段：profileId（当前本地为default；真实桥需绑定）、conversationId（已知时保持；未知由同一Profile新建）、sourceKind、channelId、externalMessageId、threadId、replyTo、receivedAt、text、attachments、authEvidence、idempotencyKey。

externalMessageId是平台原始去重事实；idempotencyKey由来源/频道/原始ID/版本组成，不能用扫描时间。相同key重复入站必须返回原receipt而不创建第二Ticket；不同线程不因同一发送者自动合并。

replyTo是送达地址和thread，不从actor/profile猜；没有replyTo的结果只记Ordin内部，面板可见。桥凭据只在桥进程env/配置边界，Ordin只存authEvidence摘要和profile绑定，不把token放Envelope、Ticket、日志或模型上下文。

Profile绑定需要operator明确动作（渠道账号→profile），解绑保留历史但阻止新输入；默认本地面板/API使用trusted default profile，不代表多租户认证。未经绑定的外部消息hold并可重新评估，不写ignored Trigger。

附件先进入受控uploads并绑定Envelope/一条Ticket，后续materialize使用哈希/权限；不让模型提供host路径。回程按delivery generation/receipt；真实远端ack和断连重放另在F4-C验收。

验收：五类来源用真实HTTP/目录fixture正负测试；重复入站无二票；thread/reply独立；未映射hold；跨profile拒绝；旧消息回放不重复；发送失败可追溯。真实渠道凭据和实际收发属于F4-C/F6，不能由本合同标完成。
