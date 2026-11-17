# P1-T4 · tools 域逻辑迁入验收

状态：**完成（离线验证）**；DSH 工具注册与权限守卫未验证，属 P2。

## 范围

- src/app/tools.ts（worker/main 工具域逻辑）。
- tests：tools.spec.ts、tool-schema-json.spec.ts、tool-surface-docs.spec.ts。

## 证据

- 依赖检查：tools.ts 无 @deepseek-ai 导入。
- 隔离快照 /tmp/ordin-gate-p1t4-20261115：npm run check 退出码 0；20 个测试文件、468 项测试通过（/tmp/ordin-p1t4-gate.log）。
- 变异：worker 报告工具名 ordin_report → ordin_reprot，tool-surface-docs.spec 退出码 1（预期红，/tmp/ordin-p1t4-mutation.log）。
- 还原哈希一致；最终闸门退出码 0（/tmp/ordin-p1t4-final-gate.log）。

## 五态

- ordin_report / ask_desk / read_artifact 等工具的域逻辑与 schema：离线验证。
- 外部执行单元真实调用这些工具：未验证，依赖 P0/P3。
