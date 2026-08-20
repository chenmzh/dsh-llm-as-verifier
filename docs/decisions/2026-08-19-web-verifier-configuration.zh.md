# Agent Note: Web 验证器配置

Status: implemented

[English](2026-08-19-web-verifier-configuration.md) | 中文

## Problem

可选验证器原本只能通过 Cordis 配置和进程凭据进行组合。浏览器需要选择验证器、管理其凭据、调整一组精简且受支持的设置，并运行现有严格 DSV4 能力探针，同时不能获得凭据值，也不能把验证与 Worker 执行耦合。

## Decision

提供方无关的 verifier 设置命名空间只拥有 enabled 和所选插件 id。默认值为 false 和 null，因此挂载验证包不会改变 agent 执行。VerifierRuntime 维护以插件 id 为键的描述符目录；不可用或未选择的实现不会收到调用。

llm-as-a-verifier 注册自己的 verifier-llm-as-verifier 命名空间和描述符。设置改变时会重建仅供验证器使用的网关，并在成功解析后切换，因此后续符合条件的调用无需重启 Harness 就会使用新的接口地址、推理强度、评估次数、枢轴数、验证器并发数、严格策略和自适应策略。verifier-observer 命名空间独立控制本地评估日志和自适应影子观察。自适应验证和日志默认仍为禁用。

DeepSeek 凭据仍使用 DEEPSEEK_API_KEY 凭据引用。WebUI 使用 credentials.describe、credentials.set 和 credentials.unset；describe 只返回已配置状态、来源和可写性。环境提供的凭据优先且保持只读。浏览器代码只在密码输入框中保存新输入值，直到写入结束，随后清空。它既不持久化该值，也不会接收现有值。

Host 新增 verifier.plugins 进行无值发现，并新增 verifier.test 执行特权能力操作。该操作通过已注册提供方分派到现有 Python 严格能力探针。浏览器只会收到插件、固定模型、接口地址 origin、三个能力布尔值、延迟，或稳定失败原因。原始提示词、token 流、请求头、后端诊断和凭据都不是响应字段。这两个方法使用现有 loopback／同源 RPC 载体。

验证仍位于候选生成之后。启用验证不会创建另一条 Worker 轨迹，也不会改变 Worker 模型选择、提供方、接口地址、并发数、重试或 rollout 策略。页面明确说明，一个候选无法提供有意义的选择，并且独立的 Best-of-N 调用方必须提供多个候选。

## Alternatives considered

**新增验证器专用配置 REST API。** 未采用，因为设置和凭据域已经拥有持久化、实时更新、脱敏、所有权和 loopback 授权。第二套 API 会重复这些规则，并造成不一致的凭据行为。

**把 API Key 存入验证器设置。** 未采用，因为设置描述可读，只有 schema 标记的秘密字段会被脱敏。凭据引用 seam 已经提供仅写 Web 行为和环境优先级。

**把页面硬编码到单一实现。** 未采用，因为插件 id 和描述符允许未来的单元测试、安全或组合验证器接入，而无需改变页面的主选择架构。

**启用验证时自动创建 Worker rollout。** 未采用，因为候选生成与选择归不同组件所有。将二者耦合会静默改变成本、并发、重试和 Worker 行为。

## Consequences

基础组合包可以挂载验证器目录、提供方和观察器，同时保持行为不变。三个设置命名空间独立更新，受管理凭据继续位于 Harness 凭据提供方的私有存储中，而不是设置或浏览器持久化中。能力测试可能产生一次验证器 API 调用，但不会产生 Worker 调用。

插件目录和凭据安全决策会继续约束未来变更，因此本 Agent Note 保持活跃。此前的可选验证、自适应选择和本地评估 Agent Note 也保持活跃，因为它们的评分、预算和隐私决策与本决策互补，而非被本决策取代。
