# F2-B2 资产目录与显式导入

完成(离线API行为)。GET/list/search/revisions、POST显式文本导入、PATCH元数据/归档、DELETE软删除均有真实HTTP测试；内容存SQLite JSON为权威，不再后台静默写文件。UTF8<=1MiB、严格kind/mime/tags、路径/upload/url/foreign owner拒绝；import hash+显式元数据去重，同名异hash不覆盖；Ticket/Work活动引用拒绝删除；Ticket来源路径不回传。

隔离focused4/4、typecheck0；serial全量59文件/1037项退出0（并行默认5秒storage子进程可能timeout，未放宽）。尚未真实浏览器验收；Coordinator reuse/import projection另行实现。
