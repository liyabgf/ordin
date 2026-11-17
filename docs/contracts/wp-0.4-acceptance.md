# WP-0.4 验收合同

状态：契约文档。定义 Ordin 独立验收的状态机、检查器和返回语义。

## 交付状态机

    worker 报告到达
      → state = ready
      → acceptance.status = "pending"
      → 检查器逐项运行
        → 全部通过 → acceptance.status = "accepted" → Ticket 结束(done)
        → 任一失败 → acceptance.status = "rework" → 派生新 Assignment（携带失败详情）
        → 无法自动检查 → acceptance.status = "unverified" → 通知用户（明确标"未验证"）

## 检查器接口

    interface AcceptanceCheck {
      readonly name: string
      run(directory: string, ticket: Ticket): Promise<CheckResult>
    }
    interface CheckResult { readonly passed: boolean; readonly detail?: string }

## 内置检查器（M1）

| 检查器 | 检查内容 | 失败示例 |
| --- | --- | --- |
| file-exists | report.files 中每个文件实际存在且非空 | "report.md 不存在或为空" |
| file-readable | 实际路径在任务目录内的普通文件且可打开读取；暂不判定二进制内容 | "路径越界、目录或文件不可读" |
| result-nonempty | ready报告summary非空；暂不做重复内容质量判断 | "worker 没有留下文字结果" |
| scope-respected | 产物路径都在 Ticket 目录内 | "产物写到任务目录外" |

## 可选检查器（M2）

- test-command：运行用户配置的测试命令，退出码 0 通过。
- structure-check：报告文件包含预期章节/关键词（用户自定义）。
- source-check：引用来源可追溯（URL 可达 / 文件存在）。

## 检查器注册

- 默认：file-exists / file-readable / result-nonempty / scope-respected 对所有任务启用。
- test-command、structure-check、source-check 是后续能力，目前尚无设置注册入口，不宣称已实现。
- 检查失败不自动无限返工：最多返工 N 次（默认 2），超限转为 unverified 并通知用户。

## 语义边界

- acceptance.status = accepted 表示 Ordin 的自动检查通过；不保证模型产出的内容质量。
- acceptance.status = unverified 表示无法自动检查；如实告知用户"已执行但未验证"。
- 缺报告（worker 没写 ordin-report）按现有 waiting 语义处理，不推断为 ready。
- 返工 Assignment 在原目录继续，携带失败详情；不重做已验收通过的文件。

## 验收

- 状态机类型编译通过；每个检查器有正负测试。
- 集成测试：worker ready + 检查通过 → done；worker ready + 文件缺失 → rework → 第二轮通过 → done；worker ready + 无 files → unverified 通知。
- WorkerExecutor 的 ready 通道必须等待验收后才提交done/返工；底层Engine.report仍允许已获授权的域调用直接ready→done，这不是“所有入口已强制验收”的保证，扩展入口须另行审计。
- 验收与final顺序执行；异步检查后重核当前Assignment、授权与输入集合；过期判定不得覆盖取消或后续输入。判定与任务转移在同一Store事务提交。
- 默认检查器无files且summary非空时为unverified，不以缺少可验证物触发无意义返工；显式专属检查器按其实际结果判断。realpath边界拒绝外部符号链接，但并发修改文件仍有TOCTOU限制，不宣称沙箱。
