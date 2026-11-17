# F6 Worker准入兼容矩阵（离线探测）

- DSH：本机 /Library/Frameworks/Python.framework/Versions/3.13/bin/dsh 0.2.1-rc.2，exit0；headless help不含 --approval-policy/--permission-mode。DshDriver要求>=0.2.2并传安全策略参数，当前安装拒绝准入。删除参数不是兼容修复。
- Codex：ChatGPT.app内置CLI 0.166.0-alpha.6，login status exit0；真实任务已尝试，返回 usage limit，未冒报成功。
- Claude：PATH及常见用户bin未找到，有限探测不能宣称全机不存在。
- 待真实：DSH 0.2.2-rc.3+四探针；Codex额度恢复后重跑；Claude安装/认证后探测。模拟契约不能替代真实矩阵。
