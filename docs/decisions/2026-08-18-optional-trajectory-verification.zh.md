# Agent Note：可选轨迹验证能力接缝

Status: implemented

[English](2026-08-18-optional-trajectory-verification.md) | 中文

## 问题

智能体执行与价值评估承担不同职责。DeepSeek Harness 负责模型请求、流式传输、工具执行、持久事件和终止；评估器需要有界证据，但不应了解 DeepSeek 传输字段，也不应意外控制循环。如果从 `agent-loop` 直接调用某一种验证器实现，普通运行将依赖可选基础设施，未来的单元测试、安全、人工或组合评估器也会被绑定到一个后端。

集成还需要最终评分、成对比较、Best-of-N 选择和可选步骤进度。后端失败通常必须保留有效的智能体工作，候选选择必须保留原始结果对象身份，而进度只能作为信号，不能隐式成为停止策略。

## 决策

在 `packages/verification/` 下增加完整的验证能力族。

`@deepseek-ai/dsh-verifier` 是服务定义。`VerifierPlugin` 提供可选的 `score`、`compare`、`select`、`onStepEnd` 和 `onTrajectoryEnd` 操作，`ctx.verifier` 发布一个受 effect 生命周期管理的实现。`runBestOfN` 不负责生成：调用方提供独立 rollout 与适配函数，再由验证器从脱离运行时的候选记录中选择。结果保留被选中原始候选对象本身。

`TrajectoryAdapter` 把已提交的 `SessionEvent` 投影为与提供商无关的 `CanonicalTrajectory`。它保留可见助手答案、按顺序排列的工具调用和解析后输入、已提交输出、受限工具元数据、净化后的工具错误和轮次结果；排除推理块、原始分块、请求头、模型来源和提供商线协议数据。UTF-8 字段及整条轨迹上限从两端保留有界证据。

`@deepseek-ai/dsh-verifier-llm-as-verifier` 是可选服务提供商。受管理的持久 Python worker 只在配置后导入 `llm_verifier`，将最终评分映射到最后一个 `track` 检查点，使用其细粒度成对评分器与 PPT 原语执行比较和选择，并把进度映射到 `ProgressTracker`。最终评分在规范步骤后附加终端答案。固定的 `deepseek-v4-flash` 客户端默认仅对官方端点使用 DeepSeek 原生请求；自定义端点使用通用 OpenAI 兼容 transport，除非配置显式覆盖。第一次执行验证器操作前，worker 会发送一个简短的评分 token 能力探针，使用可配置的 1024-token 预算；只有推理耗尽第一次预算时，才用 2048 个 token 重试一次。成功检测结果会在 worker 进程内缓存，并且不包含凭据材料。仅推理耗尽预算时抛出 `VerifierProbeInconclusive`；正常完成的响应如果生成评分 token，却缺失或无法使用评分位置 logprobs，则抛出 `VerifierCapabilityError`。提供商自有 extractor 仍然只根据每次操作中准确 `<score_A>`、`<score_B>` 或 `<cN>` 位置可用的 A–T `top_logprobs` 计算期望值，不会使用上游文本或中性分数 fallback。有界能力诊断会比较可见响应文本与 chosen-token logprob 流，并记录评分载荷 span 候选、原始 alternatives、丢弃原因和 tokenization 分类，同时不会保留完整响应。每次操作都通过 `ctx.credentials` 解析凭据，并按显式引用放入经过清理的 worker 环境。响应、stderr、期限、tracker 保留量和诊断均受限制，配置的凭据值会被净化。

通用 OpenAI 兼容 DSV4 评分使用验证器专用 `scorePrefillMaxTokens` 设置，覆盖 `llm_verifier` 0.2 仅一个 token 的评分标签 prefill 预算。其默认值 2048 允许 reasoning 端点生成实际答复位置的 logprobs，同时保持所有 Worker 预算不变。

`@deepseek-ai/dsh-verifier-observer` 是消费者。它监听提交后的 `session/event` 边界，按 session 串行执行测量，重建一个轮次，并发出实时 `verifier/progress` 与 `verifier/trajectory` 信号。它不添加持久事件，也不执行停止、重试、重新采样、剪枝或计算分配动作。提交后观察者失败始终被隔离。直接提供商调用默认失败开放，也可以选择严格传播错误。

提供商将 `maxWorkers` 作为仅验证器的有界并发，默认值为四，并且独立于所有 Worker pool。每次操作在能力检测后快照上游累计用量，因此操作 token 不包含单独报告的探针成本。结果 details 报告计划与实际逻辑 comparisons 和 API calls、安全端点标识、token 缓存计费、scale 分布覆盖、ranking 和延迟。可选 `maxCallsPerOperation` 与 `maxComparisons` 限制会在任何探针或评分请求前拒绝超出无选择缓存计划的操作。

无需修改 `agent-loop`、LLM 适配器、DeepSeek 协议、session 格式或 SDK 事件投影。

## 测试

单元测试使用伪验证网关和受管理的子进程句柄，不需要付费 API。覆盖无提供商时保持惰性、能力分派、规范证据及排除项、UTF-8 限制、Best-of-N 对象身份、评分、比较、选择验证、进度顺序、tracker 重置、缺失凭据与后端错误映射、严格传播、超时与取消、凭据轮换、错误或超大 worker 帧、进程清理、设置期卸载、提交后观察者隔离、缺失任务或步骤证据、配置默认值与拒绝路径、固定 DSV4 请求参数、原生与通用验证器 transport、准确评分位置 token 规范化与能力拒绝、分离与融合 tokenization 诊断、chosen-token 流不完整分类、探针完成分类、有界重试、成功检测缓存与配置失效、每操作用量增量、单独探针成本、逻辑 comparison 与 API-call 遥测、避免重复项的 scale 覆盖、固定操作预检预算、诊断净化、完整最终答案评分、显式失败开放选择日志，以及 GPT、Claude、local 与 DSV4 worker 设置和客户端身份保持不变。

可运行的 headless Cordis overlay 加载真实服务定义、Python 提供商和生命周期消费者。外部 `llm_verifier` 调用不进入无密钥单元测试。

## 考虑过的替代方案

- **从 `agent-loop` 调用 `llm_verifier`** — 拒绝，因为生命周期事件已经暴露已提交步骤和轮次，而且单个评估器不应成为执行基础设施。
- **在 session 轨迹中存储验证器专用字段** — 拒绝，因为持久日志已经包含证据，后端响应格式也不是执行事实。
- **复用 worker 模型、端点、客户端或并发执行验证** — 拒绝，因为执行路由归用户所有，而验证测量需要独立配置的 DSV4 Flash 客户端与预算。
- **根据验证器模型推断 DeepSeek 原生 transport** — 拒绝，因为兼容网关可以提供 DSV4 Flash，却不支持 DeepSeek reasoning 扩展；端点解析和显式 transport 配置负责请求行为。
- **让验证器生成 Best-of-N 候选** — 拒绝，因为生成路由、重试和资源策略属于 Harness 编排；选择只接收已完成候选。
- **让进度自动停止或重新采样** — 拒绝，因为测量与控制策略需要独立插件、配置和生命周期决策。
- **在基础安装中强制 Python 验证** — 拒绝，因为普通 Harness 执行不能依赖评估器凭据、可用性或 Python 包。

## 后果

- 验证通过组合显式启用；仅安装通用服务不会改变模型请求或普通 session 执行。
- 未来验证器实现可以替换提供商，而无需修改适配器、观察者或执行循环。
- 候选生成和评估器开销可以独立配置与观测。启用验证不能改变 worker 模型、提供商、端点、客户端、并发或 rollout 策略。
- 验证器进程在首次能力检测时发送一次简短请求；仅推理耗尽第一次预算时，才发送至多一次更大预算的重试。无凭据端点标识、模型、transport、固定 logprob 设置和探针预算相同的后续操作会复用成功检测结果。
- 无需读取或改变 Worker 配置，即可测量并限制验证器并发、计划工作、实际调用、token 与延迟。
- 辅助评估失败时，已提交轨迹仍然可用；严格直接调用方则可要求必须获得分数。

## 已知限制和后续工作

- `llm_verifier` 0.2 没有独立最终评分调用，因此提供商使用最后一个 `track` 检查点。
- 每个验证器端点都必须实现 DSV4 Flash 请求，并在每个请求的评分位置提供完整 chosen-token logprob 流与可用 A–T `top_logprobs`。响应级评分标签无法弥补 logprob 流中缺失的评分 span。仅推理耗尽探针预算时无法得出结论；正常完成并生成评分 token 后，才能确认评分位置 logprobs 缺失或格式错误。文本和中性分数 fallback 均被禁用；两类失败默认按失败开放处理，在严格直接调用中传播。
- 实时测量信号只存在于当前进程，不从持久历史重放。
- Worker 路径必须对配置的 subprocess 提供商可见；远程执行需要显式挂载。
- 由评估器驱动的 Worker 停止、重试、反馈轮次、分支剪枝、rollout 分配以及 goal 或 Ralph 完成策略仍属于未来的独立消费者。对现有候选执行验证器侧分阶段重新评估由[自适应验证器选择](2026-08-18-adaptive-verifier-selection.md)负责。
