# M1-E 最小记忆验收

状态：完成(离线)。

## 实现

- buildSystemContext：协调循环每轮重建 system 消息，包含身份/行为准则、global 长期记忆（限 20 条，带来源任务）、未结束任务摘要（限 10 条，含等待标记）。
- 记忆由 propose_memory 写入（默认 inferred、用户确认才 confirmed），可经 search_assets 检索；system 每轮从存储重建，纠正后立即生效。

## 验收

- tests/coordinator.spec.ts 新增 2 项：记忆与任务出现在 complete 收到的 system 消息；无记忆无任务时 system 仍存在。
- 隔离闸门：47 文件 / 849 测试，退出码 0（/tmp/ordin-mem-final.log）。
- 变异：buildSystemContext 不读记忆，coordinator 测试退出 1；还原 sha256 c3fcf8d21727e100b97edd66ddc9844e5b302a118e350c83a87f4f63ff37f3d6，恢复闸门退出 0。

## 未覆盖

- 记忆提取（从对话自动提议）未实现——当前只有模型主动 propose_memory；提取流程 M2-C。
- 记忆查看/纠正界面 M2-C；过期与失效标记只有字段，没有执行器。
