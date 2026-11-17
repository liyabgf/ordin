# CP-2 首次使用入口整改

- 设置页新增独立模型配置：baseUrl/model/apiKeyEnv/temperature/maxTokens；读取state并合并保存，保留其他设置。密钥当前仅通过启动进程环境变量读取，尚不支持面板保存明文密钥。
- 主导航“聊天”嵌入已有对话页，进入时懒加载，不需修改地址。
- pnpm-workspace.yaml 仅授权 esbuild 构建；保留用户生成的 pnpm-lock.yaml。pnpm 11.28.5 隔离验证 frozen安装、esbuild transform、check、独立state/动态端口start及实际Node SIGTERM退出0、端口释放。
- Boot日志只报告storage ready，避免把存储层尚未装配Runtime的状态当整个应用失败。
- 最终隔离快照：/tmp/ordin-cp2-final-4DjBj6；npm run check 退出0，49文件/862测试。
- 变异：删除设置合并导致VM测试退出1；还原后全量退出0；主树与还原快照面板字节相同，sha256 2f3e5265ff453cad25c60bca1c2f34c96181540cf42a0940029430f5e65a752c。
- 限制：没有真实浏览器自动化验证、没有真实供应商调用。主面板JS经过VM行为验证；用户7471现有服务未重启。需要用户停止旧进程并重新启动，刷新页面。
