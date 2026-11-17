# F2-E1 资产跨任务版本复用

完成(离线)。Coordinator接受operator-import或已登记Ticket资产引用；Engine持久assetRefs(id/revision/hash)，Executor在prepare之后、launch之前重新解析，archive/delete/hash变化拒绝启动；有效内容写入本任务attachments/asset-id-rN.txt并hash校验，重复复制O_EXCL且字节一致。旧Ticket内部引用继续走已有artifact授权。

隔离79项专项+full npm test通过，覆盖两任务字节复用、旧revision、归档/hash/foreign拒绝、异步prepare撤销mutation；整合serial 62文件/1060测试退出0，/tmp/ordin-f2-wired.log。真实Worker成功使用回执仍未实现，materialization不冒充skill_used。
