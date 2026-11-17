# Ordin

个人任务协调器：在对话中交代工作，由 Ordin 创建并跟踪任务，调用 DSH、Codex 或 Claude Code 等执行端，汇总结果和交付物。

当前为开发预览版。面板与账本可独立启动；执行任务需要另行配置执行端。DSH 服务适配已通过小任务验证；这不代表所有执行端、聊天渠道或长期稳定性均已完成生产验收。

## 启动

需要 Node.js ≥24.9。

```bash
git clone https://github.com/liyabgf/ordin.git
cd ordin
npm ci
npm start
```

打开终端显示的本地地址，默认 http://127.0.0.1:7471/ordin/。使用 Ctrl-C 正常停止。面板仅面向受信任的本机使用。

也支持 pnpm；项目锁文件与 pnpm-workspace.yaml 限制依赖构建脚本。

## 模型与执行端

在设置中配置 Ordin 自己的对话模型。支持 OpenAI Chat Completions 兼容服务；密钥保存于本机独立凭据文件（0600），不应提交到 Git。

DSH 使用自己的模型和凭据，与 Ordin 对话模型独立。连接已有 DSH 服务时，在启动 Ordin 的环境中设置 `ORDIN_DSH_URL` 和 `ORDIN_DSH_SERVICE_TOKEN`。后者是 DSH 服务访问令牌，不是模型 API key；请通过本机私有配置注入，不写入任务文本、命令历史或仓库。没有服务地址时使用 DSH CLI 模式。

服务模式支持创建 Session、任务入队、结果关联、续接与取消。接收成功不等于任务完成；外部执行状态不确定时可从本地列表移除并保留记录和文件。当前服务模式只允许 full 请求并沿用 DSH 自身权限配置，不提供逐任务 read/edit 沙箱保证；尚无实时 token 流，长历史超出读取窗口时明确拒绝。

受理模式默认 observe（只记录），启用执行需显式选择 auto。Codex 和 Claude Code 使用各自安装和登录状态。

## 面板

- 首页：任务收件箱和需要处理的事项。
- 开始：独立对话历史、草稿和模型选择。
- 任务：进度、报告、执行动作及交付物。文本交付物可安全预览，其他文件可下载。
- 更多：设置与高级诊断。

## 数据与维护

状态、工作目录和收件目录默认位于用户主目录的 .ordin 下，可通过 `ORDIN_STATE_DIR`、`ORDIN_WORK_ROOT`、`ORDIN_INBOX_DIR` 调整。不要上传这些目录或其中的 SQLite、密钥、任务记录。

离线备份/恢复前必须停止服务：

```bash
node --experimental-transform-types src/index.ts storage backup --state-dir /absolute/path/to/state --output /absolute/path/to/backup.sqlite3
node --experimental-transform-types src/index.ts storage restore --state-dir /absolute/path/to/state --input /absolute/path/to/backup.sqlite3
```

维护工具只处理数据库；工作文件与凭据需要分别备份。

## 开发与边界

```bash
npm run typecheck
npx vitest run --maxWorkers=1 --no-file-parallelism
```

- [安全边界](SECURITY.md)
- [发布快照说明](PUBLICATION.md)
- [架构](docs/03-architecture.md)
- [工程规划](docs/33-functional-execution-plan.md)
- [执行纪律](AGENTS.md)

本仓库是脱敏的独立源码快照，未携带原开发提交历史、私人任务、运行日志或凭据。历史设计文档仅供参考，能力以当前代码和实际验收为准。
