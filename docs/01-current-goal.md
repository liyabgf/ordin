# 独立宿主阶段目标：脱离 DSH，独立运行

> 本文记录 Ordin 独立宿主阶段的目标与完成定义。当前全项目执行目标以 [功能优先计划](33-functional-execution-plan.md) 为准；独立宿主能力仍是基础，不再是项目唯一目标。

## 完成定义（Definition of Done）

全部满足才算"独立"，缺一不可：

1. **独立进程**：`ordin` 不需要 DSH 宿主即可启动；状态目录、锁、SQLite 都在自己名下。
2. **五个来路不变**：cron / inbox / chat / rule / 面板派活，走同一道门禁，行为与 ordin 现役版本一致。
3. **至少一个执行后端跑通**：DSH 作为外部执行单元（headless CLI 或 ACP），一个真实任务从进来到回程端到端完成。
4. **面板自持**：面板由 Ordin 自己的 HTTP server 提供，不再挂在 DSH Web GUI 的子路径下。
5. **聊天桥原样工作**：桥进程零改动（它们本来就是独立进程，只认频道目录）。
6. **回归有据**：从 ordin 迁入的纯代码（core / sources / bridges）测试原样通过；
   门禁、Ticket 生命周期、效果队列的行为测试全绿，**以退出码为准**（纪律 0.1）。

## 非目标（本阶段不做）

- Codex / Claude Code 后端的完整接入（独立跑通后再加，见 [迁移计划](10-migration-plan.md)）
- 数字人格、长期记忆、手机操作端（见 [长期方向](00-vision.md)，仅参考）
- 多用户认证与隔离、真沙箱（沿用 ordin 的诚实立场：做不到就明说，不开假开关）
- 对 ordin 现役部署的替换——**ordin 继续维护到 Ordin 验收通过为止**

## 迁移策略（防止大爆炸）

- **分批迁入，不整包复制**：先迁无 DSH 依赖的纯代码（core / sources / bridges / store / effects），
  再逐块改造 DSH 绑定层（会话 → 驱动、面板 → 自带 server、DeskLoop → 自带 LLM client）。
- **每批一个可验证的终点**：迁入即带测试，闸门全绿才进下一批。
- **不在 Ordin 里同时重写两件事**：例如迁 store 时不改 schema，迁会话层时不改 Ticket 语义。
  语义变更单独立项、单独验收。
