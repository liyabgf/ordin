# Ordin 安全边界（当前真实状态）

这份文件描述**当前实现**，不是未来承诺。做不到的事不假装做到。

## 执行权限

- worker 是 Ordin 启动的外部进程（DSH / Codex / Claude Code CLI），运行在你的系统用户权限下。
- Ordin 没有提供 VM、容器或系统调用级沙箱。`executor.sandbox: vm` 会被拒绝并在健康板上明示。
- `executor.access` 只是把权限模式传给后端：read/edit/full。后端自己的实现若失效，Ordin 不能替你兜住。
- Ticket 工作区边界是应用层策略，不是安全隔离。不要把 Ordin 部署给不可信用户或不可信本机进程。

## 面板与 API

- 面板只绑定 loopback（默认 127.0.0.1），拒绝绑定非回环地址。
- 管理 API 要求标记头 x-ordin-request: 1（兼容 x-ordin-request）和同源 Host/Origin；这不是用户认证。
- 当前没有多用户身份、登录、按 Ticket 归属授权或跨用户数据隔离。不要把面板/API 暴露给网络。

## 凭据

- DSH 服务模式使用 `ORDIN_DSH_URL` 和 `ORDIN_DSH_SERVICE_TOKEN`；CLI 模式使用各工具自己的登录态或环境变量。
- Desk LLM 可将 API key 保存到 stateDir 下权限为 `0600` 的 `model-credentials.json`，面板不会回显。没有本地密钥时按 `deskLlm.apiKeyEnv` 指定的变量取值。
- 聊天桥凭据只应存在桥自己的 env 文件，权限建议 0600；不要把 bot token/app secret 写进 Ordin 设置。

## 数据与持久化

- SQLite、效果队列、Ticket 目录在 ORDIN_STATE_DIR/WORK_ROOT；一个 stateDir 一个写者，由锁文件保证。
- 每个 Ticket 的结果写 RESULT.md；回程失败的回复另写 REPLY-UNDELIVERED.md。
- 删除 Ticket 是显式域操作；worker 进程按进程组收尸，但已写出的文件不会自动消失。

## 网络与外部动作

- 聊天桥只通过频道目录与 Ordin 交换文件；桥自己访问 Telegram/飞书/钉钉/企微/QQ。
- 对话模型由 Ordin 调用，Worker 模型由所选后端调用。执行工具的版本和登录态检查在后台进行；真实调用能力仍须按准入矩阵验收。
- 外部 CLI 版本周级变化。生产使用应固定版本并运行 scripts/probe/*.mjs 契约探针。

## 当前明确未实现

- 多用户认证与授权。
- VM/容器级 worker 隔离。
- 真实平台双向附件和 Worker 端到端仍待分别验收。当前探测结果见 [Worker 准入矩阵](docs/acceptance/F6-worker-admission.md)。

## 操作者建议

1. 只在受控本机使用；不要把面板端口转发到局域网或公网。
2. 为 Ordin 使用独立 stateDir、独立后端登录态和可恢复的数据副本。
3. 在隔离副本运行 `bash scripts/gate.sh`。真实后端按准入矩阵核查；`blocked` 表示未准入。
