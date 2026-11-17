# 第三方模型设置验收

参考本机 DSH checkout 的 ui-settings-models 与 models-settings.e2e：API key 密码输入、写入独立凭据、留空保留、清除、地址及模型编辑、获取模型列表。Ordin 不引入 DSH 插件依赖。

## 已实现并离线验证

- 设置页：OpenAI/DeepSeek预设及自定义OpenAI兼容地址；API key密码输入；保存后清空输入不回显；高级环境变量认证；测试连接；获取和选择模型。
- GET model/config 仅返回 configuredKey/localKey/envKey 布尔状态；PUT model/config 保存非密钥设置和独立密钥；POST model/test/model/models 使用当前表单草稿而不改历史。
- 本地密钥优先；空值保留；显式清除后恢复环境变量。凭据原子写入 stateDir/model-credentials.json，权限0600。密钥不进入设置JSON、SQLite、对话或错误响应。
- 实际Runtime+HTTP+模拟上游验证保存/保留/清除/认证优先级、模型列表、SSE连接测试、参数拒绝及错误不泄漏密钥。VM执行真实面板处理函数验证保存/连接/列表/导航。
- 隔离全量 npm run check 退出0：50文件，865测试；日志 /tmp/ordin-provider-verified.log。子代理0600→0644变异退出1，还原哈希一致。

## 验证边界

当前只实现OpenAI Chat Completions兼容协议；未实现Anthropic原生协议，也没有DSH全量提供商目录、多提供商同时配置。预设只是填充地址和建议模型。
尚未做真实供应商调用及浏览器自动化；未改用户真实凭据或重启7471服务。测试连接会发起小型实际推理请求。
