# P2 进程注册表组件验收

状态：**完成（离线验证）**；尚未接入 executor/驱动。

## 复核

- 实现：src/app/process.ts（ProcessRegistry）；tests/process.spec.ts 13 用例。
- 主代理复核了源码与测试；快照复跑 npm run check 退出码 0，23 文件 / 566 测试通过（/tmp/ordin-p2proc-main-gate.log）。
- 哈希：process.ts 4d1fc2fb28353b827055f68b59fc620d031fba1e49951240629cf954009818d8；process.spec.ts bd7f4e4a2c3f2b1a44f721650d88740ce51ef39ae8a574c211cf091c168b9bba，仓库与快照一致。
- 子代理已做两组变异：丢 exitCode、只杀 leader 不杀组，均按预期变红并还原。

## 能力

argv/cwd/env/stdin、输出上限、owner 登记、数字退出码、AbortSignal、进程组 SIGTERM→SIGKILL、stopAll、spawn 失败可见、无孤儿测试。

## 未覆盖

真实 DSH/Codex/Claude 进程接入与 Ticket 集成，留 P2-T5/T6。
