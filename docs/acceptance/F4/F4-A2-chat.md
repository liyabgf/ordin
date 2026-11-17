# F4-A2 平台聊天对话入口

离线验证。ChatSource只在显式mode: conversation时走Runtime单一ConversationIntake实例，其他消息保留Engine任务语义；mapped identity变trustedActor，channel/thread/external ID/replyTo保留。observe不调用模型，unmapped/paused/held保留原文件，错误状态可见；未支持附件和reply-to-ticket明确hold。

直接回复写out/reply-conversation-<receipt>.md，KV journal pending/written；重放不重建已收走输出。DB与文件非原子，pending不自动重发而暴露uncertain；非远端ACK。

独立与合并serial typecheck+Vitest退出0，64文件/1099项；移除mode分流变异7失败后源码完整恢复。专项11用例含重复、普通任务、observe、held与unsupported。

限制：未真实渠道收发；Coordinator建票时未将平台回复地址持久到任务，因此异步任务结果仍只有内部对话回报，F4-A3待做。
