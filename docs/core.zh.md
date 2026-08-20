# dsh-llm-as-verifier/core

[English](README.md) | 中文

此服务定义通过 `ctx.verifier` 发布一个可选验证器。提供商可以实现 `score`、`compare`、`select`、`onStepEnd` 和 `onTrajectoryEnd` 的任意子集；调用不支持的必需操作会明确失败，未提供的生命周期钩子则不执行任何操作。

`verifier` 设置命名空间包含实时主开关和所选插件 id。`enabled: false` 或 `plugin: null` 会使服务保持休眠，即使提供方已经挂载。`plugins()` 为配置界面公开分离的描述符，`testCapability()` 把特权探针委托给指定提供方，不会选择该提供方，也不会改变 Worker 状态。

## 规范轨迹

`TrajectoryAdapter` 从已提交的 `SessionEvent` 记录重建 `AgentStep`。每一步保留可见的助手文本、按顺序排列的工具名称和输入、已提交的输出、受限的工具元数据、净化后的工具错误、最后一个可见答案和终止原因。它排除推理块、`assistant/chunk`、模型请求数据、提供商元数据和原始 DeepSeek 载荷。字段级和整条轨迹的 UTF-8 字节限制会保留超长文本两端的证据。

`serializeStep()` 和 `serialize()` 为验证后端生成可读且有界的文本。结构化轨迹仍可供单元测试、安全、人工或组合验证器使用。

## Best-of-N

`runBestOfN()` 并发调用所提供的 rollout 函数 `n` 次，适配每个已完成结果，并只把选择工作交给验证器。它本身不生成候选，并返回被选中的原始对象本身。

提供商可以在不改变候选所有权的前提下，为结果附加相对选择置信度和验证遥测。置信度描述排序分离程度以及是否建议继续评估，不代表选中候选正确的概率。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  runBestOfN,
  TrajectoryAdapter,
} from 'dsh-llm-as-verifier/core'

interface HarnessResult {
  readonly session: { readonly events: readonly SessionEvent[] }
}

interface Harness {
  run(task: string, options: { rollout: number }): Promise<HarnessResult>
}

export async function selectBest(
  task: string,
  harness: Harness,
  ctx: Context,
): Promise<HarnessResult> {
  const adapter = new TrajectoryAdapter({
    maxFieldBytes: 65_536,
    maxTrajectoryBytes: 524_288,
  })
  const selection = await runBestOfN({
    task,
    n: 3,
    run: index => harness.run(task, { rollout: index }),
    adapt: result => adapter.adapt(result.session.events),
    verifier: ctx.verifier,
  })
  return selection.bestCandidate
}
```

## 模型体验

### 智能体模型请求

#### 模型看到的内容

安装此服务定义不会添加提示词段、工具 schema 或请求字段。规范 `SessionEvent` 数据只会流向显式配置的验证提供商。

#### Token 影响

仅安装服务定义不会增加智能体模型 token。

#### KV 缓存影响

仅安装服务定义不会改变智能体模型的请求前缀或 KV 缓存复用。

## 已知限制和后续工作

- 内置适配器读取当前 `SessionEvent` 记录；其他 harness 结果需要调用方提供适配器。
- Best-of-N 并发运行候选，不添加重试、分支、预算或提前停止策略。
- 进度和最终分数只是测量值；此包不把它们解释为智能体控制决策。
