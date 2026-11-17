# F4-D1 场景模型选择

离线验证。Settings.deskLlm新增严格scenarios.conversation/triage；覆写必须在models保存列表，未知模型阻止解析/HTTP更新。conversationTurn无显式model时使用conversation覆写；显式已保存model优先；main DeskLoop triage使用triage覆写；普通DeskLoop使用全局；dedicated triage走Worker driver，不读取desk场景。

fake fetch捕获5请求模型顺序talk/global/judge/global/global，endpoint/auth/temp/maxTokens不变，全局settings.model仍global；policy membership mutation令3项红；focused 66 policy/http +23 runtime通过，serial整合64文件/1105项退出0（/tmp/ordin-f4d1-int.log）。未连接真实provider。

acceptance/assets/extraction无LLM消费者，保持确定性。
