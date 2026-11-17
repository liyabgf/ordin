# F4-A1 统一对话入口门禁与幂等收据

完成(离线服务)。ConversationIntake严格归一profile/default、source/channel/external message/thread/replyTo/text/attachmentsEnvelope；trustedActor由host绑定，不取模型字段。调用现有deterministic gate但不直接Engine.receive/建Ticket；accepted才调用Coordinator，observe/reject/paused/unknown hold语义不重复消费。

同external identity+fingerprint运行中join；完成收据跨重开直接返回；pending重开变uncertain且不重复回调；fingerprint/actor/thread/conversation冲突409；callback失败保存uncertain不泄露错误。store事务先reserve，未映射/paused hold不占收据，重复调用可在绑定后重试。

28项定向通过，typecheck0，/tmp/ordin-intake-final-targeted.log。reserve变异红；单处fingerprint变异被冗余校验拦截，全三处移除后红，恢复SHA256 5a982a4914c0c442b1ade918d1c32ec85687eeb19d3911d09d758ca5057cd587后28项绿；整合serial全量63文件/1088项退出0，/tmp/ordin-f4a1-commit.log；F4-A1仍未接Platform ChatSource/Runtime，真实渠道回程未验证。
