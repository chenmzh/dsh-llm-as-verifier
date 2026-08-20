# Agent Note：本地验证器评估记录

状态：已实现

[English](2026-08-19-local-verifier-evaluation-records.md) | 中文

## 问题

在校准置信度或自适应策略之前，验证器排序和成本需要来自日常 Harness 工作负载的证据。仅有选择遥测无法证明正确性，而持久化任务文本或轨迹会在 session 存储之外复制私有源代码、工具输出、路径和用户数据。

观察必须保持辅助地位。存储失败不能使已完成的 Worker 轨迹或验证器选择失效，禁用验证或日志时也不能改变正常执行。

## 决策

`VerifierRuntime.select()` 只在提供商返回选择之后发出 `verifier/selection`。该信号包含验证器标识、候选数量、排序字段、成本遥测和调用方提供的评估上下文；它排除任务文本、候选对象和规范轨迹。`runBestOfN()` 接受运行时作为选择 dispatcher，因此普通候选生成仍归现有调用方所有，而选择观察统一经过通用服务。

观察者默认关闭的 `evaluationLogging` 选项把每个信号投影成带 schema 版本的本地 JSONL。每个插件实例拥有一个随机命名的按日文件，并通过单个进程内队列串行追加。在支持权限的系统上，文件和目录使用私有权限。卸载会排空待写记录；追加或关闭失败只发出警告，不会改变选择结果。

schema 存储验证器设置、排序与分数字段、计划和实际成本、自适应 baseline 与 escalation 成本，以及零调用的 top-two shadow 判断。不透明的运行、任务标识和轨迹引用以 SHA-256 摘要保存。任务文本、原始轨迹、候选值、提供商请求数据、authorization 字段和凭据值不会被复制。导出工具使用 schema-v1 字段白名单，而不是转发未知输入字段。

验证器输出是预测。独立的整体和候选 outcome 只通过 `VerifierCallContext.evaluation` 进入；没有证据时明确记为 `unknown`。DSH 完成事件描述执行终止，不会被转换为正确性标签。因此选择决策与测试、CI、grader、reward 或用户验收证据保持清晰区分。

Python 分析工具只使用标准库，绝不调用验证器或要求凭据。它们从准确率计算中排除未知 outcome，报告配对 candidate-zero uplift、oracle accuracy、regret、score-gap buckets、adaptive-shadow 触发覆盖、存在时的实际 escalation yield，以及操作成本。Shadow 分析只说明哪些已记录 Stage-1 结果满足规则，不推断未执行升级的结果。

## 考虑过的替代方案

- **持久化完整轨迹**——拒绝，因为 session 存储已经拥有该数据，分析旁路会扩大暴露范围。
- **把验证器 winner 当作 ground truth**——拒绝，因为这会测量与验证器的一致性，而不是选择质量。
- **从 `turn/end` 完成推导成功**——拒绝，因为执行成功终止不能证明任务正确。
- **把记录上传到托管分析服务**——拒绝，因为本地优先观察已经足够，也不需要增加网络或数据处理方。
- **让遥测持久化成为选择完成的一部分**——拒绝，因为观察存储不能延迟或使有效结果失效。

## 后果

- 普通 DSH 组合可以选择记录本地验证器证据，而无需改变 Worker 生成、提供商、端点、并发、重试或 rollout 策略。
- 记录支持未来的阈值和成本分析，同时 schema 保持明确且可演进。
- 哈希引用和省略正文会减少暴露，但不会让记录匿名；用户按自己的数据策略保留或删除本地目录。
- 没有独立 outcome 的运行无法计算准确率、uplift、regret 和修正指标。

## 相关决策

- 提供商中立验证器与 Worker 分离由[可选轨迹验证 seam](2026-08-18-optional-trajectory-verification.md)定义。
- 置信度和选择性升级由[自适应验证器选择](2026-08-18-adaptive-verifier-selection.md)定义。
