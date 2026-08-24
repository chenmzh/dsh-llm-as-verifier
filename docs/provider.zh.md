# dsh-llm-as-verifier/provider

[English](README.md) | 中文

此可选服务提供商使用 Python [`llm_verifier`](https://github.com/llm-as-a-verifier/llm-as-a-verifier) 包实现通用验证器。它始终使用 `deepseek-v4-flash` 进行评估；agent 模型、提供商、端点、客户端、并发和 rollout 策略继续由现有 Harness 运行时负责。一个受管理的持久 JSON-lines worker 将最终评分映射到 `llm_verifier.track`，使用上游细粒度成对评分器与 PPT 原语执行比较和 Best-of-N 选择，并使用 `ProgressTracker` 处理在线更新。

启用该提供商前，请安装 Python 依赖：

```sh
python3 -m pip install 'llm-verifier>=0.2,<0.3'
```

在配置并调用提供商之前，npm 包可以在没有 Python 依赖的情况下使用。验证器 API 密钥通过 `apiKeyEnv` 从 `ctx.credentials` 解析；该引用默认为 `DEEPSEEK_API_KEY`，解析后的值会复制到经过清理的验证 worker 环境，并且不会存入 Cordis 配置。`baseURL` 只配置验证器客户端；省略时先读取不可变启动环境中的 `VERIFIER_BASE_URL`，再回退到 `https://api.deepseek.com`。`transport: auto` 将最终的官方 URL（包括 `/v1`）解析为 `deepseek-native`，将所有自定义 URL 解析为 `openai-compatible`；显式 transport 值会覆盖这一解析结果。OpenCode 或其他 Worker 可以继续独立配置，同时此验证器使用 DeepSeek 官方端点。

该提供方注册实时 `verifier-llm-as-verifier` 设置命名空间和 `llm-as-a-verifier` 目录描述符。Web 配置继续使用 `settings.*` 和 `credentials.*`；API Key 仅可写入，环境提供的凭据保持只读。Host 能力操作调用验证器执行前使用的同一个严格探针，并且只返回安全的能力概述。

## 配置

可运行的 [headless 示例](../../../examples/headless-agent/verifier.cordis.yml)为现有智能体增加验证：

```yaml
- id: verifier
  name: 'dsh-llm-as-verifier/core'
- id: verifier-provider
  name: 'dsh-llm-as-verifier/provider'
  config:
    model: deepseek-v4-flash
    baseURL: https://api.deepseek.com
    apiKeyEnv: DEEPSEEK_API_KEY
    transport: auto
    capabilityProbe:
      maxTokens: 1024
      retryMaxTokens: 2048
    scorePrefillMaxTokens: 2048
    criteria:
      Overall: Is this trajectory correct, complete, and adequately verified?
    nEvaluations: 1
    pivots: 2
    maxWorkers: 4
    reasoningEffort: high
    strict: true
    adaptive:
      enabled: false
    budget:
      maxCalls: 32
      maxLatencyMs: 45000
      maxCallsPerOperation: 64
    progressTracking:
      enabled: false
- id: verifier-observer
  name: 'dsh-llm-as-verifier/observer'
```

让 Harness 凭据提供商能够读取 `DEEPSEEK_API_KEY`，然后运行。显式 `baseURL` 的优先级高于 `VERIFIER_BASE_URL`，后者又高于 `https://api.deepseek.com`；这些值都不会改变 agent 端点：

```sh
pnpm dsh --profile headless --patch examples/headless-agent/verifier.cordis.yml \
  "Fix the failing tests in this repository."
```

官方原生 transport 将仅验证器的 `reasoningEffort`（`off`、`low` 或 `high`）作为请求字段应用。持久 worker 使用操作级策略，在并发评分任务运行时不会修改 `DEEPSEEK_EFFORT` 或其他进程全局设置。通用 transport 发送固定模型以及标准 OpenAI 兼容字段 `messages`、`logprobs=True` 和 `top_logprobs=20`，不会启用 DeepSeek reasoning 字段。只有端点需要另一种行为时，才覆盖自动解析结果。

第一次执行验证器操作前，持久 Python worker 会发送一个简短的 `<score_A>` 能力探针，输出预算为 1024 个 token。如果 DSV4 只返回推理 token，消耗至少 90% 的预算，并且在生成答复内容前以 `finish_reason: length` 结束，worker 会用 2048 个 token 重试一次。第二次仍耗尽预算时，系统抛出带有 `OUTPUT_BUDGET_EXHAUSTED` 的 `VerifierProbeInconclusive`，而不会断定端点缺少 logprobs。正常完成的响应如果生成评分 token，却未提供可用的评分位置 logprobs，系统会抛出带有确切提取原因和安全评分证据的 `VerifierCapabilityError`。只有 chosen-token 流包含评分载荷位置，并且该位置提供可用 A–T alternative 时，token 级 logprobs 才表示能力受支持。成功检测结果在进程内按无凭据端点标识、模型、transport、固定 logprob 请求设置和探针预算缓存。改变任一设置都会重新探测；凭据值不会进入缓存键。

通用 OpenAI 兼容评分使用上游评分标签 prefill 路径。`scorePrefillMaxTokens` 会替换上游仅一个 token 的 prefill 预算，使 DSV4 能够在生成评分 token 前完成推理；其默认值为 2048，并且只影响验证器 prefill 请求。

选择过程用带 phase 的条目分别保留 ring 与 pivot 结果。同一个有向候选对如果在两个 phase 中都被调度，仍是两次独立评估；自适应阶段只复用同一 phase、pair occurrence、criterion 和 repetition 的选择级缓存。聚合时缺少内部条目会抛出记账错误，不会变成合成的 0.5 平局。

验证结果的 details 为每个评分任务保留一条有界记录。稳定 comparison id 标识 phase、pair occurrence、criterion、repetition、候选索引和提示词槽位顺序。每个评分位置保留端点返回的原始 alternatives、严格 A–T 归一化、保留和丢弃的已返回概率质量、原始、已映射、唯一 scale 与已丢弃 alternative 计数、`scale_mass`、期望奖励、原始 reward 差、Bradley–Terry 偏好、结束原因、仅验证器 token 用量和延迟。能力诊断还包含有界 chosen-token 窗口、评分载荷 span 候选、tokenization 分类、message/token 流一致性和各 alternative 的丢弃原因。提取失败会区分 top-logprobs 缺失或为空、没有完整有效的 scale token、logprobs 格式错误、评分位置缺失和 chosen-token 流不完整；默认不保留完整轨迹或验证器分析正文。`scale_mass` 在提取器为每个 A–T 字母只保留最高 logprob token 形式后求和，与未改变的期望奖励重复项策略一致，不会重复计算 `A` 与 `>A` 等形式。

候选分数是 tournament 偏好信号，不是任务正确率。选择结果因此会报告相对 `confidence`：最高分、次高分、分差、`low`／`medium`／`high` 等级，以及是否建议继续验证以达到所配置目标。`mediumGap` 默认值为 0.03，`highGap` 为 0.10，`targetLevel` 为 `high`。

省略 `adaptive` 或设置 `adaptive.enabled: false` 时，系统保留使用已配置 `nEvaluations`、criteria、pivots 和 reasoning effort 的一次选择操作。`adaptive.strategy: staged` 保留依次对全部 criteria 执行 K=1、K=2 和 K=4 的累积计划。阶段可以指定 criteria 子集，但后续阶段必须保留之前所有 criterion／repetition 工作。

`adaptive.strategy: top-two` 在榜首两名分差达到 `top2GapThreshold` 时保留基线 PPT 排序。分差更小时，系统仅针对榜首两名按两个槽位方向执行 `additionalEvaluations` 轮追加比较，再把这些独立 Bradley–Terry 结果加入既有 ring 与 pivot 总量。它不会因为低排名候选接近而升级，也不会生成新轨迹。`maxExtraCalls` 限制追加工作；`escalationReasoningEffort` 只提高新增请求的推理量。此模式仍需显式启用：

```yaml
reasoningEffort: low
adaptive:
  enabled: true
  strategy: top-two
  top2GapThreshold: 0.08
  additionalEvaluations: 1
  maxExtraCalls: 8
  escalationReasoningEffort: high
```

每次自适应选择使用一个临时的 phase-qualified 评分缓存。累积阶段只增加缺失的 criteria 或 repetitions。Top-two 升级要求基线条目已经完成，并且只新增 `adaptive` phase；基线条目缺失属于内部错误，不会触发重跑或合成平局。两种策略结束后都会删除缓存。

自适应验证只在开始下一阶段前检查预算。固定与自适应 worker 操作还可设置 `maxCallsPerOperation` 或 `maxComparisons`；这一保守预检使用不考虑选择缓存的计划，并在能力探针或评分调用前拒绝超限工作。`maxCalls` 默认值为 32，`maxLatencyMs` 为 45000；可选的 `maxInputTokens`、`maxOutputTokens` 和 `maxReasoningTokens` 限制使用后端用量报告。下一阶段估算按新增 criterion／repetition 工作单元扩展已观察到的累计成本。系统不会中断进行中的阶段，因此单个阶段可能在完成时超过限制，但不会再开始后续阶段。部分排序仍然可用，并通过 `verification.stoppedReason` 报告 `max_calls`、`max_latency`、`stages_exhausted` 或 `verifier_error` 等原因。

在仓库根目录手动运行可选的真实端点诊断。它用一个 correctness criterion 和 K=1 对明显的反转字符串候选执行两个相反槽位顺序的直接比较，不运行 PPT、选择或自适应升级。输出包含每个原始和归一化评分分布、候选 reward、原始差值、Bradley–Terry 偏好、结束原因、token 用量、延迟，以及语义成功、语义失败、槽位偏差或槽位敏感性分类：

```sh
DEEPSEEK_API_KEY=... python3 scripts/smoke-dsv4-verifier.py
```

使用 `--capability-only` 可以只运行有界的首次探针。输出包含模型、结束原因、输入／输出／推理 token 数、评分 token 和 logprob 是否存在、有界评分位置 token 证据、失败原因、延迟与重试次数，不包含任务轨迹或凭据。

验证成本随 PPT comparisons × criteria × `nEvaluations` 增长；较长的规范轨迹通常主导输入 token 成本。建议从一个 overall criterion、`nEvaluations: 1`、`pivots: 2` 和仅验证器 `maxWorkers: 4` 开始。

运行 `python3 scripts/benchmark-dsv4-verifier.py --matrix 4:1 --reasoning-effort low --tasks arithmetic,reverse,logic --output /tmp/dsv4-adaptive-benchmark.json`，可执行小型确定性策略基准。加入 `--adaptive-top-two --top2-gap-threshold 0.08 --escalation-reasoning-effort high` 可测量选择性升级。此付费可选工具会在调用前打印计划的基线工作与最大追加工作，持久化每个已完成结果，并报告 ranking、scores、基线与升级用量、延迟、能力缓存复用和离线阈值判断。它不会修改生产配置或 Worker 设置。

`strict: true` 是生产默认值。设置 `strict: false` 可保留失败开放行为。缺失凭据、后端错误、速率限制、超时、无法得出结论的能力探针、响应格式错误、任一必需 `<score_A>`、`<score_B>` 或 `<cN>` 位置缺失或不可用的 A–T token logprobs 和序列化失败只会产生警告与失败元数据，原始轨迹仍然保留。直接调用在 `strict: true` 时会继续抛出错误。提交后观察者始终隔离错误，因为测量无法回滚已经提交的 session 事件。

结构化操作遥测记录无凭据端点标识、候选和 criterion 数、K、pivots、仅验证器 `maxWorkers`、reasoning effort、计划和实际逻辑 comparisons、计划和实际 API calls、耗时、输入、缓存、未缓存、输出与推理 token、token 缓存命中率、ranking、scores，以及能力探针执行或缓存复用。Top-two 选择还会分别记录基线与升级的延迟、comparisons、calls、token 用量、reasoning effort、触发原因、预算跳过原因和排序变化。操作 token 增量不包含单独报告的能力探针成本。日志不包含任务或轨迹正文。Worker stderr 和响应大小均受限制，诊断信息会净化已配置的凭据值。

## Best-of-N

将 `dsh-llm-as-verifier/core` 的 `runBestOfN()` 与 `ctx.verifier` 一起使用。当调用方需要会话级 verifier 模式时，在 `context` 中传入所属 `Session`。选择会经过通用运行时及其数据最小化观察事件。调用方负责独立运行 Harness 并适配结果；验证器不会读取或改变其 worker 策略；此提供商只接收规范候选文本，并返回选中索引、分数、排序和元数据，通用辅助函数则保留原始候选对象身份。

## 模型体验

### 智能体模型请求

#### 模型看到的内容

提供商不会向智能体请求添加验证提示词、工具、请求头、推理设置或流字段。验证在已提交的 `session/event` 边界之后运行。

#### Token 影响

提供商不增加智能体模型 token。

#### KV 缓存影响

提供商不会改变智能体模型的请求前缀或 KV 缓存复用。

### 验证模型请求

#### 模型看到的内容

任务与有界规范证据：可见答案、工具交互、已提交观察、错误和结果。独立验证器客户端始终用 `logprobs=True` 和 `top_logprobs=20` 请求 `deepseek-v4-flash`，以便提供商对每个准确评分位置的 A–T 概率计算期望奖励。原生 transport 保留上游 DeepSeek 请求参数；通用 transport 省略 DeepSeek reasoning 字段。不包含 agent 传输数据或私有推理。

#### Token 影响

每个 Python worker 的第一次验证器操作会增加一次简短的能力请求；只有推理耗尽第一次探针预算时，才会再重试至多一次。每个被观察轮次执行一次最终验证操作。启用进度后，每个已提交步骤增加一次操作；固定模式下的 `nEvaluations` 和 Best-of-N 候选数量会倍增验证侧工作。自适应 Best-of-N 从第一阶段开始，只在相对置信度低于配置目标且预算允许时增加后续阶段调用。

#### KV 缓存影响

验证请求是独立评估。插件不保证检查点、候选或评估调用之间共享前缀或复用 KV 缓存。

## 已知限制和后续工作

- `llm_verifier` 0.2 没有独立的最终 `score` 函数，因此最终评分采用 `track` 返回的最后一个检查点。
- 每个配置的验证器端点都必须返回可用的 A–T token 级 logprob 分布。有界探针在生成评分 token 前结束时无法得出结论；只有正常完成的探针生成了评分 token，但评分位置 logprobs 缺失或格式错误时，才报告 `VerifierCapabilityError`。两条路径都不会降级为纯文本分数；除严格直接调用外均按失败开放处理。
- `nEvaluations` 默认值为一，`maxWorkers` 是验证器调用并发，默认值为四。它既不继承 rollout 并发，也不改变 rollout 并发。
- 自适应选择默认关闭；启用后只在阶段边界执行预算判断，不会取消已经开始的后端请求。
- `reasoningEffort` 默认为 `high`。在真实基准证明不同生产默认值之前，`low` 与 top-two 升级仍是显式策略。
- Python 必须与发布的 `worker.py` 位于同一文件系统环境；远程 subprocess 提供商需要在相同路径挂载该文件。
- 验证不会停止、重试、重新采样或剪枝智能体工作；独立消费者以后可以对测量应用策略。
