# P2-T1 · 独立 bootstrap 验收

状态：**完成（真进程离线验证）**；executionReady=false 是明示合同，不代表可执行任务。

## 内容

- src/index.ts：真实入口，配置失败 exit=2、锁占用 exit=1、SIGINT/SIGTERM 停止。
- src/app/boot.ts：Uploads→锁→Store→Prompts→Effects→Passes；start/stop 幂等；StopIncompleteError 保留锁库可重试；15s 排空上限。
- src/app/config.ts：显式参数 > ORDIN_* env > ~/.ordin 默认；绝对路径解析。
- src/app/logger.ts：本地 logger。
- npm start 改为 --experimental-transform-types；裸 node strip-only 无法解析既有 TS 参数属性。

## 验收

- 子代理：12 项 boot 测试 + smoke；两组变异（漏 lock.release、漏 effects.drain）均红并还原。
- 主代理完整快照 /tmp/ordin-gate-p2boot-report-20261115：npm run check 退出码 0；27 文件 / 611 测试通过（/tmp/ordin-p2boot-report-gate.log）。
- 真进程冒烟：ORDIN_STATE_DIR=/tmp/ordin-p2-start-ZJRrf8 ORDIN_PORT=0 npm start → SIGTERM，退出码 0；锁/-wal/-shm 无残留（/tmp/ordin-p2-start.log）。
- 未接入项如实列出：engine、executor、delivery、sources、watchdog、http。
