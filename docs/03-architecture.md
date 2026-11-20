# 目标架构

> 这里只定工程结构；可行性与取舍见迁移计划与准入记录。

## 形状

```
聊天桥 / inbox / cron / rule / 面板（不变的部分）
                  │
                  ▼
        Ordin 独立进程（node:sqlite + 自带 HTTP server）
   Source → Gate → Decision → Mandate+Ticket → Assignment
                  │
           DeskLoop（总管分诊，自带 LLM client）
                  │
           Manager 能力层（Registry / 资产读取 / 健康 / 固定配方）
                  │
           WorkerDriver SPI（核心抽象，新增）
        ┌─────────┼─────────┐
        ▼         ▼         ▼
    DshDriver CodexDriver ClaudeDriver
    各自目录里各一轮进程；报告经 MCP / 回复代码块回流
                  │
        Delivery（RESULT.md + 回程 + 面板）
```

## WorkerDriver SPI（最小接口）

```ts
interface WorkerDriver {
  probe(): Promise<DriverHealth>            // 版本、登录态、配置完整性
  prepare(spec: { cwd: string; prompt: string; model?: string;
                  skills?: string[]; mcpReport?: object }): Promise<LaunchSpec>
  launch(spec: LaunchSpec): RunningTurn     // 事件流 AsyncIterable<NormEvent>
  feed(turn: RunningTurn, input: string): Promise<'accepted' | 'queued-for-next-turn'>
  cancel(turn: RunningTurn, reason: string): Promise<void>
  resume(sessionRef: BackendSession, input: string): RunningTurn
}
type NormEvent = { kind: 'started'|'text'|'tool'|'usage'|'report'|'final'|'error'; /* … */ }
```

## Manager 能力层

- **工具路径 Registry**：`src/app/tool-registry.ts` 静态登记 coordinator / desk / worker 三条路径的工具名与风险类别，绑定既有 schema 与 handler。它只做投影与缺项检查，不替代对象权限。
- **资产读取**：`manager-asset-reads.ts` 提供目录搜索、固定版本读取与关系查询；Ticket 产物正文经 `manager-artifact-reader.ts` 另行校验来源、成功终局、登记路径、物理边界与完整哈希。
- **运行健康**：`manager-health.ts` 只读当前所选执行端的配置、进程内最近检查与近期任务回执，不主动探测。
- **固定配方**：`manager-recipes.ts` 提供资产比较、任务补材料与失败诊断三条操作配方，只引导现有工具，不新增写授权。

## 报告通道（两级）

- **L1（先做）**：worker 在最终回复末尾写约定代码块，Ordin 解析成六态 Report
  （progress / waiting / ready / blocked / failed / dropped）。三家通吃，agent-autoloop 已验证。
- **L2（增强）**：per-ticket MCP server 暴露 ordin_report 等工具（Claude / Codex 原生支持 MCP）。
- 等人语义：L1 下进程退出、Ticket 转 waiting、回答后 resume——**等待不占进程不花 token**。

## 已知的后端差异（驱动层各自吸收，不往域层渗）

| 差异 | 处理 |
| --- | --- |
| Codex 运行中不可插话 | feed 返回 queued-for-next-turn，本轮结束后 resume 喂入 |
| DSH SDK 无 wire 级 cancel | DSH 驱动主路径用 ACP（有 session/cancel）或 headless+杀进程组 |
| 用量口径不一（Claude 给钱，另两家只给 token） | 面板注明口径；预算控制在 Ordin 层做 |
| 技能目录各家不同 | 按后端物化；血缘事件留在 Ordin core |
| 版本周级漂移 | 纪律 1.3：pin + 契约测试 |
