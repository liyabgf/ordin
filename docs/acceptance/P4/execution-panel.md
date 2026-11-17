# 面板执行工具选择与重检

状态：实际面板 JavaScript 在 Node VM 中进行交互级测试通过；真实浏览器视觉/布局与完整 DOM 事件链尚未验收。

设置的执行区域新增 backend 与 access 下拉框；renderSections 从配置取值，collectSections 写回既有 JSON，保留其他 executor 字段。重新检查按钮在 JSON 存在未保存修改时提示先保存，不调用 API；已保存时 POST execution/check，期间禁用按钮；返回可用/不可用/网络错误都用 textContent 呈现，finally 恢复按钮。

测试读取 panel/index.html 的真实 handler 与 collectSections 执行段，在 VM 提供最小 DOM stub，验证 API 调用、脏状态拦截、错误文本、按钮恢复、backend/access 序列化与 sandbox 保留。没有只做源码字符串存在性断言。

隔离闸门退出码 0，43 文件 / 812 测试。变异移除未保存设置保护，面板测试退出 1；还原 sha256 d9bf16965c6303238493df1cb66c9a4fa56546b87a24cbad9ae94c2bb8c25457，恢复全量闸门退出 0。日志 /tmp/ordin-panel-execution-final.log。

当前服务面板按请求读静态文件，但配套 execution/check API 所在 Node 代码仍需重启加载最新提交；活服务未在本轮重启，不能宣称在线整条链已验收。
