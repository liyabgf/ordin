# 独立启动验收

通过：真实 Node 子进程在 DSH 路径不存在、模型 key 为空时，仍能提供 HTTP 面板和状态 API。执行工具不可用仅写入 execution-backend 健康条目，不阻塞产品启动。任务准备/执行阶段检查工具；工具恢复后重试重新探测。

隔离快照：/tmp/ordin-independent-check-Y74GtB。完整闸门退出码 0，41 文件 / 796 项测试。日志 /tmp/ordin-independent-check.log。

变异：把启动 probe 改回失败即退出，真实启动回归退出码 1。还原 sha256 83eb05438e0b41bea39f285107dc1bfdc3e6d5c9aec9a94302c363ab1963fb2f；还原后完整闸门退出码 0，日志 /tmp/ordin-independent-restored.log。

启动：在仓库执行 npm start，打开终端打印的 /ordin/ 地址（默认 http://127.0.0.1:7471/ordin/），Ctrl-C 停止。不需要先启动 DSH 或配置 API key。

真实模型执行、MCP、平台收发仍需单独验收，不因本次启动验收通过而算完成。
