# P1-T1 · src/core 迁入验收

状态：**完成（离线验证）**；不涉及真实后端。

## 迁入范围

- src/core：engine.ts、model.ts、policy.ts、timing.ts、memory.ts、ids.ts、errors.ts、index.ts
- tests：engine.spec.ts、policy.spec.ts、timing.spec.ts
- 配置：zod@4.4.3；tsconfig 对齐 ordin（去掉 exactOptionalPropertyTypes，开启 isolatedModules/resolveJsonModule/noImplicitOverride/noFallthroughCasesInSwitch）

## 验收证据

- 依赖检查：`grep -R '@deepseek-ai' src/core --include='*.ts'` 无命中。
- 隔离快照：/tmp/ordin-gate-p1t1b-20261115。
- 初跑 typecheck 退出码 2：Ordin tsconfig 比 ordin 严格；按“迁移不改语义”对齐编译配置，不改 core。
- 复跑 `npm run check`：退出码 0；Test Files 4 passed，Tests 179 passed（/tmp/ordin-p1t1-gate2.log）。
- 变异检验：隔离副本将 parseTime 返回值的 second 项移除，tests/timing.spec.ts 退出码 1（预期变红，/tmp/ordin-p1t1-mutation.log）。
- 还原验证：备份哈希 48638b1face56c47b76e837499d7cbbc873bf1d2056278723a8a24befdd6191c，还原后一致；最终闸门退出码 0（/tmp/ordin-p1t1-final-gate.log）。
- 回滚演练：本卡独立提交；回滚命令 `git revert <提交哈希>`。提交后记录实际哈希。

## 五态标注

- 领域引擎、门禁策略、时间计算：离线验证。
- DSH/宿主行为：本卡不涉及，未验证。
