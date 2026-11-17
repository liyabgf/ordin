# P2 运行时审计：DSH 插件 → 独立宿主

> 只读分析。对象：ordin 提交树（工作区）中 src/index.ts 与 src/app/{runtime,http,executor,delivery,sessions,agent-delivery,background,desk-loop,desk-llm}.ts，共 6,784 行。
> 结论分级沿用 AGENTS.md A6：〔已核〕= 读过该文件该行；〔文档〕= 取自 docs/10、docs/20；〔待核〕= 未读够，不据此施工。
> 本文件不修改任何源码；未覆盖项集中列在第 6 节。

## 1. createRuntime 的依赖与启动/停止顺序

### 1.1 依赖来源〔已核〕

- 入口 `apply(ctx, config)`（src/index.ts:41）。DSH 注入声明在 src/index.ts:17–29：`agents, sessionController, sessionPersistence, workspaceRegistry, permissionPresets, tools, systemPrompt, webServer, subprocess, skills, llm`。
- `createRuntime`（runtime.ts:1893–1900）只做 `new Runtime(context, config)` 并识别 `LockHeld`。Runtime 直接持有 `context: Context`（runtime.ts:291）与 `subprocess = context.subprocess`（runtime.ts:307、366）。
- 路径/部署参数来自 `machineOf(config)`（runtime.ts:368，deployment.ts），不是 DSH 服务。

### 1.2 构造顺序（runtime.ts:364–559）〔已核〕

1. `machineOf` → `Uploads`（369）→ `takeLock(stateDir)`（370）→ `writeMarker`（373）；锁先于 Store，一个 stateDir 一个写者。
2. `new Store(stateDir/ordin.sqlite3)`（379）；`SchemaTooNew` 时释放锁再抛（381–385）。
3. `Prompts(store)`（389）。
4. `Effects(store, {health, lifetime, onPermanentFailure})`（395–459）；失败钩子按 kind 分派到 executor/delivery/engine（406–457）。
5. `DshExecutor`（460–468）——此时注册 `effects.handle('launch'|'input')`（356–357），engine/sessions 用 getter 延迟读。
6. `Sessions`（469–524）——构造函数挂 `ctx.on('agent/created')`（450）与 `ctx.on('tools/result')`（459）。
7. `OutcomeDelivery`（525–539）——注册 `effects.handle('notify'|'send')`（519–520）。
8. `Engine`（540–545）——依赖 repos/tx、policy、executor、delivery、emit。
9. `effects.handle('trigger')`（549）→ `Passes`（550–555）→ `SourceRegistry`（556，五种 kind）→ `Watchdog`（557）。
10. `registerHttp(this)` 推入 disposers（558），http.ts:826–871。

### 1.3 启动顺序（index.ts:41–92；runtime.ts:1320–1399）〔已核〕

- `registerSkills` 与 `setProblemSink` 先于 start（index.ts:60–65）；stop 以 `ctx.effect` 注册（74–80），`StopIncompleteError` 只降级为 warn、保留 DB/锁。
- `startNow`（1326）：uploads 清理（1328）→ `indexSessions`（1329）→ `wireAgents`（1330，三条 ctx.on 监听 1597/1651/1673）→ `DeskLoop` 创建+init（1335–1343，注释明示必须早于 recover）→ `prompts.onChange`（1345）→ 配置了 deskLlm 才 `sessions.setDeskLoop`（1347–1352）→ `recover()`（1354，1720–1762）→ `refresh()`（1355）→ `sources.sync()`（1357）→ `passes.start()`（1364）→ 预算定时器（1365–1374）→ `watchdog.start()`（1375）→ 清已结束票的 sessionHealth（1381–1383）。

### 1.4 停止顺序（runtime.ts:1467–1562）〔已核〕

1. `stopped=true`、清预算定时器、`abort.abort()`（1483–1486）。
2. disposers 逆序释放（含 HTTP 路由，收集 `drain`）（1487–1491）→ `watchdog.stop()`（1492）→ `effects.dispose()`（1493）。
3. `stopDrain` 内 `Promise.allSettled` 11 个任务（1497–1517）：HTTP handlers drain、pump（passes）、Sources、Effects drain、Sessions dispose、Sessions drain、Executor drain、DeskLoop、startup、Host 工具操作、workers `halt`。
4. 二次 drain executor/sessions/effects（1522–1524）→ `store.close()`（1527）→ `lock.release()`（1528）。
5. 15s 上限，超时抛 `StopIncompleteError`，锁与 DB 保留供重试（1538–1551）；index.ts:74–80 捕获它。

## 2. 被使用的 DSH 服务与用途〔已核〕

| 服务 | 调用点 | 用途 |
| --- | --- | --- |
| cordis `Context` | logger 遍布；`ctx.on` runtime.ts:1597/1651/1673、sessions.ts:450/459、agent-delivery.ts:42；`ctx.effect` index.ts:62/74；`ctx.get('jobs'/'subagents')` background.ts:44–46 | 生命周期、事件总线、日志 |
| `agents` | runtime.ts:1222/1737/1788、executor.ts:484/870、sessions.ts:495/518/538/610/994/1067、background.ts:113–160、agent-delivery.ts:99 | 按 SessionId 取活 Agent、判断 running/idle |
| `sessionController` | sessions.ts:506 resolveAgent、524/561 create、531/584 rename、590–598 selectModel | 创建/恢复/命名/选模型 |
| `sessionPersistence` | agent-delivery.ts:65–75 open/read、112 flush | 投递幂等：读历史 + 先落盘再确认 |
| `permissionPresets` | sessions.ts:625–627 | worker 固定 `danger-full-access` |
| `tools`（agent.ctx） | sessions.ts:703/714/732/846–885 | 注册工具、restrict 白名单、guard |
| `systemPrompt` | sessions.ts:703 | 注入 ordin prompt 段 |
| `webServer` | http.ts:832 register(prefix)、859 port；runtime.ts:1210 | 面板与 API、同源端口 |
| `subprocess` | runtime.ts:307/366 → executor.ts:267（prepare）、delivery.ts:870（terminal-notifier） | 起子进程 |
| `skills` | index.ts:63 registerSkills；sessions.ts:765–782 agent 作用域注册手艺 | 手艺库（全局 vs agent 层） |
| `llm` | desk-llm.ts:72 stream；http.ts:659–663 listProviders/listModels | 总管模型与 provider 列表 |
| `jobs`（ctx.get） | background.ts:70–95 | 杀 worker 的 shell 作业 |
| `subagents`（ctx.get） | background.ts:108–152 | 收 worker 的子代理 |
| dsh-scope | sessions.ts:847 `scopeParentOf` | restrict 的作用域父层 |
| `cordis.patch.yml` | sessions.ts:29/39 的 preset 名 | worker/researcher 预设定义在宿主补丁里 |

补充〔已核〕：`workspaceRegistry` 只在 inject 出现（index.ts:18），这 9 个文件中无调用点；`permissionPresets` 只有一处。迁移时可先不实现 workspaceRegistry。

## 3. 保留 core/sources/store/effects/delivery，换成独立 HTTP server + 外部 WorkerDriver

### 3.1 必须替换的类/接口（按文件）〔已核〕

1. **入口**：`src/index.ts:41 apply(ctx)` → 独立 `main()`。现为骨架（ordin/src/index.ts:13–24），需整体替换。
2. **Runtime**（runtime.ts:288–1900）：保留组合根职责，去掉 `Context` 类型与 `sessions`/`subprocess` 成员；`wireAgents`（1588–1690）改为驱动事件订阅；`progress`（1218–1234）改读驱动状态；`panelPath`（1209–1212）读自建 server 端口。
3. **Sessions**（sessions.ts:406–1086）：拆两半。worker 侧（ensure 550、resume 608、authorize 624、decorate 670、restrict 846、promptWorker 976）整体废弃，由 WorkerDriver 取代；desk 侧只剩 `notify`（914）、`relay`（935）两个入口，而它们在有 DeskLoop 时已直接转交（920–923、941–944）。
4. **AgentDelivery**（agent-delivery.ts:37–115）：随 DSH Session 一起废弃；幂等模型改用 DeskLoop 的 receipt 方案（desk-loop.ts:250–258、516）。
5. **DshExecutor**（executor.ts:336–958）：保留外层语义，替换 `ensure/promptWorker/agent.cancel/ctx.agents`。`ExecutorHost`（70–84）中 `context`、`subprocess`、`sessions` 三个成员换成 `{logger}`、ProcRegistry、WorkerDriver。
6. **background.ts**：`killJobs/stopSubagents`（70–152）是 DSH jobs/subagents 的适配层，换成进程注册表按进程组收尸；`until`（59）与 `stopBackground`（155）的编排可保留。
7. **desk-llm.ts**：`deskGenerate`（42–85）签名可不变，内部 `ctx.llm.stream`（72）换 OpenAI 兼容 client（P2-T3，已由 p2-desk-llm 在建）。
8. **http.ts**：`registerHttp`（826）换 `node:http` server；`HttpHost`（43–110）的 `context` 收窄为 `{logger}`+`serverPort()`，`executor: DshExecutor` 收窄为 `{used(), sandbox}`；`desk/providers` 路由（656–666）改由新 client 提供。
9. **delivery.ts**：文本构造全保留（`borrowedFrom`191、`replyText`316、`headline`347、`relayText`361、`escalationText`393、`resultDocument`435、`findNotifier`480）；`OutcomeDelivery`（492）保留，`DeliveryHost`（62–102）的 `context/sessions/subprocess` 三个成员换成 `{logger}`、DeskPort{notify,relay}、ProcRegistry。
10. **ExecutionSandbox**（executor.ts:116–182）与 `LocalHostSandbox`（230–334）保留；唯一 DSH 触点 `SandboxSubprocess`（216–228）换成进程注册表的 spawn 形状。

### 3.2 可以原样保留的接口

`core.Executor`/`Delivery` 端口（engine 构造处 runtime.ts:543 注入）、`SourceHost`（996–1010）、`WatchdogHost`（931–982）、`ToolsHost`（572–592）、`ExecutionSandbox`、sources 五种 kind 与 chat 桥（独立进程，delivery.ts:672–690 只调 `TwoWaySource.deliver`）、effects 队列与 key 语义（`launch`/`input`/`send`/`notify`/`trigger`）。

### 3.3 最小改造顺序（依赖优先，不做大爆炸）

1. **T1 先行**：定义窄上下文（logger、ProcRegistry）+ boot（stateDir/锁/Store/Prompts/Effects），按 1.2 顺序装配，先不接 worker；启动日志证明组件齐全。
2. **T2 并行**：HTTP 自建 server + `HttpHost` 收窄；面板/路由原样迁入，`sameOrigin` 不动。
3. **T4 冻结**（已落 src/drivers/types.ts：`WorkerDriver`96、`RunningTurn`87、`WorkerEvent`65、`WorkerSpec`29）。
4. **T5**：进程注册表 + DshDriver，四探针契约测试。
5. **T6**：ExecutorHost 换驱动；`launchNow`（507）中 `sessions.ensure/promptWorker`（552–559）→ `driver.launch`；`deliverInputs`（813）→ `RunningTurn.feed`；`halt`（866–946）→ `cancel`+进程组；`agentRunning/used`（474–485）→ 驱动 running 计数。
6. **T7**：DeliveryHost.sessions → DeskPort；`notify`（764）与 `relay` 调用点（772/779/825–826）保持语义；RESULT.md 端到端。
7. **收尾**：删 sessions.ts/agent-delivery.ts/background.ts 的 DSH 分支，runtime 瘦身，文档与验收同步。

## 4. 测试复用矩阵

### 4.1 已在 ordin 复用（P1 迁入，闸门绿）〔已核〕

tests/：engine、sources、chat、chat-contract、store、effects、policy、timing、tools、tool-schema-json、tool-surface-docs、prompts、skills、uploads、views、watchdog、passes-reliability、files-pure、bridges、transaction、smoke。这些不依赖 DSH stub，P2 不改动。

### 4.2 可直接复用（无 DSH 运行期依赖，仅改 import 路径/类型）〔已核〕

- `desk-idempotency.spec.ts`：自带 `ctx = { logger, llm.stream }` 内联桩（第 24–27 行），把 Context 类型换成局部类型即可跑。
- `desk-history.spec.ts`：Context 仅 `as unknown as` 类型断言（192/214/254/280/317/349/385 行）。
- `executor.spec.ts` 的 `LocalHostSandbox` 部分（第 12 行只 import 沙箱）：配 stub `SandboxSubprocess` 即可，与 DSH 无关。
- `desk-tools.spec.ts` 的 schema 断言部分（若只读 `deskToolSchemas`）可保留，涉及 host 的部分见 4.3。

### 4.3 依赖 DSH stub，需换成驱动/进程假件〔已核：均 import tests/helpers/host.ts〕

`http、executor(launch 部分)、delivery、notify、notify-machine、chat-send、background、agent-delivery、mount、flow、recovery、fault-injection、auto-retry、session-health、session-decoration、silent-visibility、worker-preset、shutdown-reliability、ticket-delete、files、recipes、desk-tools` 共 22 个 spec 使用 `stubHost`（host.ts:383，36.8KB，含 agents/sessionController/sessionPersistence/permissionPresets/webServer/subprocess/jobs/subagents 全套）。

替换成本分三档：
- **低**：http.spec（webServer 桩 → 真 server 临时端口）、notify-machine.spec（spawn 桩 → ProcRegistry 桩）。
- **中**：delivery/notify/chat-send（`Sessions` 桩 → DeskPort 假件，投递语义不变）、executor 的 launch/halt 用例（stub agent → fake WorkerDriver 实现 types.ts）。
- **高/作废**：mount.spec（apply 被 main 取代）、session-decoration.spec 与 worker-preset.spec（decorate/restrict 语义由 `AccessMode` + 驱动 prepare 取代）、agent-delivery.spec（类被删除）。

## 5. P2-T1/T2/T6/T7 文件级实施清单

### P2-T1 bootstrap（src/index.ts、src/app/boot.ts 新建）

- `src/index.ts`：替换骨架（ordin/src/index.ts:13–24）为 `main()`：解析 env（ORDIN_STATE_DIR 等）→ boot → 安装 SIGINT/SIGTERM → `stop()`。
- `src/app/boot.ts`（新）：按 runtime.ts:364–559 的顺序装配 Uploads→lock(lock.ts)→Store→Prompts→Effects→[驱动/执行器]→[DeskLoop]→[Delivery]→Engine→Passes→Sources→Watchdog；按 1326–1399 的顺序 start；stop 按 1467–1562 的 11 任务编排 + 15s 上限。
- 日志：沿用 context.logger 形状的本地 logger；启动行写明 stateDir/端口（对齐 runtime.ts:1384–1398）。
- 验收：三次起停无残留（锁文件、-wal/-shm、端口）；`docs/acceptance/P2/P2-T1.md`。

### P2-T2 HTTP server（src/app/http.ts、src/app/server.ts 新建）

- `http.ts`：原样迁 http.ts:37–39（BASE_PATH/REQUEST_HEADER）、135–206（readBody/json/failure/match）、368–781（路由表）、785–820（BodySchemas）、826–871（注册与 drain）；`registerHttp` 改 `serve(host, {port})` 返回 `{close, drain}`，保留 `active` 集合（829–838）语义。
- `HttpHost`（43–110）：`context` → `{logger}` + `serverPort(): number`；`executor` 收窄；`desk/providers`（656–666）接新 client。
- `server.ts`（新）：node:http createServer + 127.0.0.1 绑定 + 端口 0 支持；`sameOrigin`（161–169）不改。
- 面板：panel/index.html 已在（P1-T3）；`panelHtml`（runtime.ts:1268）读文件逻辑随之搬入。
- 验收：面板在 Ordin 端口可开；`sameOrigin` 正/负测试；`tests/http.spec.ts`。

### P2-T6 executor（src/app/executor.ts 改造）

- 保留：ExecutionSandbox（116–182）、LocalHostSandbox（230–334）、PrepareFailed（68）、LaunchPayload（87–89）、gaveUp（386）、releaseDependants（405）、releaseWaitingSlots（420）、stuckLaunches（434）、rescueStuckLaunch（461）、copyAttachments（645）、environment（707）、taskText（720）、threadContext（789）、queueStop/drain（881–921）、deliverInputs 的排队与 Later 语义（813–854）。
- 替换：ExecutorHost（70–84）→ `{logger, proc, driver, engine, store, effects, health, lifetime, settings, workRoot, closing}`；`launchNow`（507–590）的 `sessions.ensure/promptWorker`（552–559）→ `driver.launch` + WorkerEvent 循环（started→assignmentStarted，report→engine.report 兜底，final→turnEnded/inputsDelivered）；`deliverInputs`（845）→ `RunningTurn.feed`；`halt/haltWorkNow`（866–946）→ `cancel` + 进程组；`used/agentRunning`（474–485）→ 驱动 running 集合；删除 cleanupLateAgent（600–615）的 agent.cancel 分支，改按 ticket/assignment 校验。
- runtime 配套：`wireAgents`（1588–1690）→ 驱动事件订阅；`progress`（1218–1234）字段来源改驱动（`agentStatus/sessionTitle` 降级为空）；`recover`（1720–1762）用驱动/进程存活判断；`sessionIndex`（317、1568–1578）存 BackendSession。
- 验收：槽位/暂停/依赖重试原用例在 fake WorkerDriver 下全绿；`tests/driver-contract.spec.ts` 四探针。

### P2-T7 delivery 与回程（src/app/delivery.ts 改造）

- 保留全部纯函数与文档（1–491、707–753 的同步写 REPLY-UNDELIVERED.md 例外理由不动）。
- `DeliveryHost`（62–102）：`context`→`{logger}`；`sessions`→`DeskPort{notify(text,requestId,ticketId),relay(requestId,text,ticketId)}`（调用点 772/779/825–826）；`subprocess`→ProcRegistry（`machineNotification` 851–877）。
- effects `send` 处理器（672–690）不变：仍走 `SourceRegistry.source(kind).deliver`，聊天桥是外部进程。
- 验收：engine.report → notify → RESULT.md + desk relay + 桥回程端到端；`docs/acceptance/P2/P2-T7.md`。

## 6. 未覆盖与风险（不据此施工）

- 〔未覆盖〕delivery.ts:361–479（relayText/escalationText/resultDocument 正文）只按导出签名与调用点核对，未逐行读。
- 〔未覆盖〕tests/helpers/host.ts:438–654（stubHost 内部实现）未读，4.3 的替换成本按接口面估算，需在 T2/T6 实测校正。
- 〔未覆盖〕runtime-budget.spec、dependencies.spec、policy.spec 等未逐一核对是否使用 stubHost；4.3 名单只含 grep 证实的 22 个。
- 〔待核〕P2-T5 的 DshDriver 与本报告的 ExecutorHost 契约需在 SPI 冻结后对齐一次；types.ts 若改字段，第 5 节 T6 的映射表随之改。
- 风险：`progress` 面板字段（sessionTitle/agentStatus/turn）依赖 DSH Session 事件；驱动化后要么由驱动提供等价事件，要么面板显示降级——文档不得承诺不存在的字段（A6）。
