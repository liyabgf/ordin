# P1-T3 · 剩余纯 app 模块迁入验收

状态：**完成（离线验证）**；面板真实 HTTP 与 DSH 宿主未验收。

## 范围

- src/app：about、files、lock、passes、prompts、session-health、skills、uploads、views、watchdog。
- 资产：prompts/*.md、panel/index.html；cordis.patch.yml 仅为既有资产断言暂存，启动路径不加载，P2 移除或归档。
- 测试：prompts、skills、uploads、views、watchdog、passes-reliability；files-pure 由原 files.spec 前两个纯 describe 提取，完整 runtime 路由测试留 P2。
- session-health.spec 依赖 runtime，推迟 P2。

## 证据

- 依赖检查：上述 src/app 文件无 @deepseek-ai 导入。
- 首跑 typecheck 退出码 2：files-pure 提取时残留一个 `}`；修正后测试真实运行。
- 第二跑退出码 1：prompts/panel 资产缺失；补齐资产。
- 最终隔离快照 /tmp/ordin-gate-p1t3c-20261115：npm run check 退出码 0；17 个测试文件、434 项测试通过（/tmp/ordin-p1t3-gate3.log）。
- 变异：uploads 过期判断 > 改为 <，uploads.spec 退出码 1（预期红，/tmp/ordin-p1t3-mutation.log）。
- 还原哈希一致；最终闸门退出码 0（/tmp/ordin-p1t3-final-gate.log）。

## 五态

- 文件、提示词、技能注册逻辑、上传、视图、看门狗、锁：离线验证。
- 面板真实服务与 DSH 运行时：未验证。
