# probe 脚本

P0 的实测探针。每个后端一个脚本，统一输出 JSON 与人读摘要：
版本、登录态、起任务、事件流、结构化终局、会话续接。

- 所有临时目录都在 /tmp/ordin-p0-*；不改全局安装与现役宿主状态。
- 退出码含义：0 = 探针脚本自身跑完（单项可记 failed/blocked）；1 = 探针脚本自身失败。
- 单项结论只允许 passed / failed / blocked / skipped，不允许推测成 passed。
