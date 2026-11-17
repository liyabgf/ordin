# P2-T2 · 独立 HTTP server 验收

状态：**完成（真 server 离线验证）**；生产 runtime 装配未完成。

## 实现

- src/app/server.ts：node:http、loopback-only、port 0、close/drain/forceClose。
- src/app/http.ts：53 条路由迁自 ordin，HttpHost 收窄；正典 /ordin/ + /ordin/api/*。
- 兼容别名 /ordin/ 与 x-ordin-request，因 panel/index.html 仍使用旧前缀；与 x-ordin-request 走同一 sameOrigin 守卫。
- body 限制、JSON 错误、活动请求 drain；desk/providers 未接入时显式 501。

## 验收

- 子代理：18 项真 server 测试；三组变异（删标记头、删 body 限制、drain 立即返回）均红并还原。
- 主代理基线快照 /tmp/ordin-gate-http-20261115：npm run check 退出码 0；33 文件 / 687 测试通过（/tmp/ordin-http-gate.log）。

## 未覆盖

- desk/providers 生产实现；progress/recipes/mainSession/createTicketWithUploads/deleteTicket 的 runtime 接线；浏览器视觉验收。
