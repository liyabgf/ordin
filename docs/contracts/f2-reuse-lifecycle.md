# F2-A 统一复用生命周期合同

## 共同规则

Ordin默认单人Profile，本地操作视为operator；模型工具只能提议、查询和按权限引用。模型参数不得充当用户确认、授权或技能验证证据。跨Profile不继承本地operator授权；未来登录体系另立合同。

资源拥有完整随机或内容派生ID、ownerProfileId、createdAt/updatedAt、不可变revision、状态、来源和审计。既有无owner的本地记录按default兼容，但不能把任意source.path升级为可信来源。业务新增字段存现有JSON record；仅出现真实索引/事务需要才迁schema。

每次修改产生新的revision，保留先前版本用于历史任务引用。归档阻止新引用，不删除旧任务使用证据；删除先作可审计软删除；物理删除只限无活动引用且明确用户动作，默认保留原产物和任务目录。执行使用记录区别“选中/投射/实际使用/使用成功”，不能用投射冒充成功使用。

## Asset

来源分两种：accepted Ticket注册产物（ticketId、相对路径、验收记录、内容hash）；用户显式导入内容（operator动作、来源说明、managed copy、内容hash）。未验收Worker产物为candidate，不能自动作为可信长期资产。

导入接口只接受文本内容/已上传附件ID或明确授权的内部artifact引用；不接受由模型给的任意绝对文件路径。服务把内容复制进stateDir/assets的受控目录，文件名由完整hash/UUID生成，拒绝symlink/遍历；不覆盖同名异内容。相同owner+hash导入幂等并可追加来源，不将内容相同推导为共享授权。

MVP API：GET assets（query/kind/includeArchived/limit）、GET assets/:id、POST assets/import、PATCH assets/:id（name/description/tags/archived）、GET assets/:id/revisions、GET assets/:id/references。模型的assetRefs解析到具体revision，再经目录/所有权校验投射；检查实际hash与登记版本一致，changed则拒绝或产生新版本。

引用和使用记录包含consumerTicketId、producer/source、revision/hash、selectedAt/materializedAt/usedAt、清理结果。不可用资源不得静默丢弃，应返回明确错误。来源URL只作元数据，导入不隐式抓网。

## Skill / 临时工具

SavedSkill扩展revision/hash、来源、兼容backend、依赖声明、validation记录和candidate/active/disabled状态；现有enabled兼容映射。用户手工新增与Worker晋升都保留来源差异。

任务选择skillRefs固定revision；默认不全量复制所有技能。匹配可由Coordinator建议，服务核enabled/版本/兼容/依赖后只投射最小集合。投射目录只存本任务快照；不允许Worker直接更新全局库。

任务内脚本经显式验证命令/结构检查及退出码后登记候选；晋升须明确operator确认或已保存可信策略，模型不能自报验证通过。技能回执只证明已读取/调用时注明observed，真正成功必须有可核验退出结果；去重按Ticket+revision+receiptID。失败可disable/revoke，后续任务不再投射。

## Memory

propose_memory永远创建inferred候选，记录sourceMessageId或sourceTicketId、scope、revision、proposal时间；confirmed只能由本地operator明确confirm API操作产生actor/time审计。

MVP API：GET memories（kind/scope/status/includeExpired）、POST memories（operator明确创建仍记录动作）、POST memories/:id/confirm、PATCH memories/:id（content/expiresAt/scope，修改后新revision）、DELETE memories/:id（软删除/审计）、GET memories/:id/revisions。confirmed状态不得通过普通PATCH伪造。

默认模型上下文只使用未删除、未归档/废弃、未过期的confirmed记录，并按当前Profile和Work证据过滤；候选出现在用户管理列表，模型不得把候选当已确认事实。纠正后下一次turn看到最新revision；旧revision只用于历史溯源不再注入。useCount只在实际注入时按turn幂等递增。

## 功能入口和验收

只在既有面板增加资源列表、导入/确认/编辑/归档按钮及错误提示，不做F5信息架构/视觉重建。所有变更经真实HTTP与VM/浏览器行为测试，资源不可用/越权/过期/重复请求负例必须可复现。

F2出口故事：第一任务产物以hash登记；第二任务选择固定revision并实际投射，使用关系双向可见；用户纠正记忆后第三轮不再引用旧值；临时工具先验证、后候选、明确晋升，失败可撤销。真实Worker成功仍需补F1-D额度可用后实测，不能用模拟记录升级真实。
