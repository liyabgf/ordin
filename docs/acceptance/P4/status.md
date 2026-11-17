# P4 验收状态：安全文档完成，真实验收阻塞

## 已完成

- SECURITY.md：worker=外部进程权限面、面板 loopback+同源守卫、凭据边界、持久化、未实现清单。
- README 当前状态更新为“离线一体化已验收，真实后端未过 P0”。
- 认证健康：入口先跑所选后端 probe，不健康拒绝启动；driver 内 auth_expired/missing_credential 分类。
- 超时/预算：WorkerDriver timeoutMs + Runtime.enforceRuntimeBudgets（继承 ordin W6 预算规则）。

## 阻塞

- DSH：headless 路由 MISSING_CREDENTIAL（无 DEEPSEEK_API_KEY）。
- Codex：refresh token 已被服务端消费，需 CODEX_HOME=/tmp/ordin-p0-codex/home 下重新登录后重跑 scripts/probe/codex.mjs。
- Claude：本机无登录态，需 CLAUDE_CONFIG_DIR=/tmp/ordin-p0-claude/config 下 claude login 后重跑 scripts/probe/claude.mjs。
- 真实平台多桥：需要 Telegram/飞书/钉钉/企微/QQ 的可用凭据或人工通道。

## 暂不能宣称

- “可生产执行”：真实后端、真实平台、浏览器视觉验收未过。
- 三后端“功能完成”：驱动与宿主离线完成，真实模型路径未验收。

## 启动拒绝实测（2026-11-15 05:33）

命令：ORDIN_STATE_DIR=/tmp/ordin-start-refuse-m37BRt ORDIN_PORT=0 npm start。
结果：退出码 1；日志明确 backend=dsh、version=0.2.1-rc.2、problems=[dsh headless lacks --approval-policy; require DSH >=0.2.2, DEEPSEEK_API_KEY not visible to probe]，随后干净停止。证据 /tmp/ordin-start-refuse.log。没有假装可启动。
