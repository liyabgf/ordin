# P3 · access 与技能物化验收

状态：**完成（离线验证）**；真实后端读取 SKILL.md 的行为未验收。

## 实现

- executor.workerSpec 使用 settings.executor.access，不再固定 edit。
- 新增 src/app/materialize.ts：启用的 SavedSkill 写入 worker cwd/skills/<name>/SKILL.md，含 name/description front matter；禁用不写、非法名字拒写。
- Executor.startTurn 在 driver.prepare 前物化手艺，并把路径以 <skills> 块追加到 prompt；不写全局目录。

## 验收

- tests/materialize.spec.ts：启用/禁用、内容、路径逃逸；executor.spec 增加 access=full 透传。
- 隔离快照 /tmp/ordin-gate-p3skills-20261115：npm run check 退出码 0；39 文件 / 793 测试通过（/tmp/ordin-p3skills-gate.log）。
- 变异：access 忽略设置固定 edit，executor.spec 退出码 1（预期红，/tmp/ordin-access-mutation.log）；还原哈希一致，最终闸门退出码 0。

## 未覆盖

- DSH/Codex/Claude 是否按各自技能发现机制自动加载这些文件；当前由 prompt 显式指路，真实行为待后端认证恢复后验收。
- MCP 报告通道 L2 尚未实现；L1 已验收。
