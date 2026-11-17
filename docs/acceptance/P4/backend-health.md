# 当前执行工具健康与手动检查

状态：HTTP 与 Runtime 离线集成通过；真实模型连通性未验收。

- GET /ordin/api/execution/status 返回 selected 和该后端最近的 health，没有检查记录时 health=null，不探测不启动任务。
- POST /ordin/api/execution/check 检查当前所选执行工具，记录后端名、时间、可用性和错误；受既有 Host/Origin/自定义头守卫保护。
- 当前后端改变后，不复用旧后端的检查结论；健康摘要显示尚未检查。过期探测完成时不得覆盖新选择的摘要。
- 启动不等待检查；Runtime 启动后后台调用同一 checkExecution；各后端 AvailableDriver 独立健康项。

验收：Runtime 真 HTTP server；GET 不触发 probe，缺标记头 POST=403，显式 POST 正常返回，配置切换后 health=null，probe 抛错映射不可用。隔离全量闸门退出码 0，42 文件 / 806 测试。把状态硬编码读取 dsh 的变异使测试退出 1；还原 sha256 b774db010d7bde102ff53f2d932f9c4f4a84261d31b237d5d7b8aa617ef62e82，恢复全量退出 0。

日志 /tmp/ordin-health-api-final.log。当前没有新增面板按钮；API 可用但按钮交互仍待实现。活进程未重启。

第 7 轮补充：同一后端按探测请求代次提交结果；晚到旧结果不能覆盖新结果。受控 Promise 测试覆盖同家乱序响应与切换后端时旧响应完成；移除代次保护变异使 Runtime 测试退出 1。还原 sha256 dc90b47afb8fe1df73a6c1f47f4d016be222871fa06820287cdd503bb49831f3，最终完整闸门退出 0，42 文件 / 808 测试。日志 /tmp/ordin-probe-race-final.log。

活进程当前 execution/status 404，仅说明它仍运行较早提交，不代表本轮 API 已在线生效；真实用户服务不在本轮重启范围。
