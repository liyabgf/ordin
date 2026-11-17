# M1-G 关键可靠性 B1/B5 验收

状态：**完成(离线)**。

## B1 协议流不被捕获上限截断

- 缺陷：ProcessRegistry.append 达到输出捕获上限后直接 return，连协议回调（driver 实时解析 ordin-report 的通道）一并被抑制——超长输出的任务会丢失 final 报告。
- 修复：一份字节两条流。捕获（rec.stdout/stderr）保持有界；协议回调始终收到完整解码文本。新增 capture-only 解码器，避免多字节字符在截断处污染捕获。finishOutput 的协议 flush 无条件执行。
- 证据：新测试用 perl 产出 256KB 输出+末尾 FINAL 标记，stdoutLimit=4096；断言回调收到 FINAL、record.stdoutTruncated=true、捕获长度有界。

## B5 停机收尾的错误诚实性

- 缺陷：signalGroup 的 catch 吞掉全部错误——非 ESRCH 的 kill 失败被伪装成“进程已死”，记录里看不到。
- 修复：ESRCH 照旧静默（预期竞态）；其他错误写入 rec.error（`kill failed: …`），不再声称已杀。
- 证据：已退出进程的 stopAll 不产生伪造错误（status=exited、error=null）。

## 验收证据

- 红测：恢复旧 append 早退逻辑后，B1 测试退出 1；还原 sha256 91832ac81522334250a92e662a28d98b9afb1895f1e827c3937533595a81d639，隔离闸门退出 0。
- 全量：47 文件 / 855 测试通过（/tmp/ordin-m1g-final.log）。

## 未覆盖

- 真实 DSH/Codex/Claude 的长输出回归（M3 真后端验收）。
- watchdog 与 stop 的端到端残留检查（M2-F）。
