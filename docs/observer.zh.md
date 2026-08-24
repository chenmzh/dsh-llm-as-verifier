# dsh-llm-as-verifier/observer

[English](README.md) | 中文

此消费者监听提交后的 `session/event` 通知并调用可选验证器钩子。每次 `step/end` 时，它重建当前轮次，把新的规范步骤传给 `onStepEnd`，并在存在结果时发出 `verifier/progress`。在 `turn/end` 时，它调用 `onTrajectoryEnd` 并发出 `verifier/trajectory`。

任务取自当前轮次接纳的用户消息；导入 session 缺少该消息时，回退到最近的较早人工提示。每个 session 的工作串行执行，tracker id 在每个 session 轮次内稳定，插件卸载会排空已排队测量。缺失任务或步骤证据会记录警告并跳过。session 事件提交之后，任何验证器或监听器失败都会被隔离。成功完成 `/verifier off` 的会话会跳过之后的测量，直到完成 `/verifier on` 或 `/verifier default`；观察者会把所属 session 传给 runtime 参与这个决定。

发出的信号是实时类型化事件，不是持久 session 事件。策略插件以后可以监听它们以实现提前停止、重试、重新采样、剪枝或自适应计算，而无需把这些决策加入此测量消费者。

## 配置

`maxFieldBytes` 默认为 `65536`；`maxTrajectoryBytes` 默认为 `524288`。两者都必须是正安全整数，并与提供商自己的防御性序列化限制独立应用。

选择评估日志默认关闭。启用后，观察者会在配置的本地目录下，为每个插件实例写入一个带 schema 版本、按日期命名的私有 JSONL 文件。追加操作在进程内串行执行，插件卸载会排空排队记录，持久化失败只产生警告，不会替换有效选择。

`verifier-observer` 设置命名空间会实时应用日志变更。关闭日志会立即停止新的追加；更改本地路径会为新路径打开写入器。自适应影子只读取已完成选择的元数据，绝不分派另一次验证器调用。

```yaml
evaluationLogging:
  enabled: true
  path: .verifier-runs
  adaptiveShadow:
    enabled: true
    top2GapThreshold: 0.08
```

记录包含验证器配置、ranking、scores、成本遥测、哈希后的运行／任务标识、哈希后的轨迹引用，以及调用方提供的独立 outcome。记录排除任务文本、候选对象、原始轨迹、提供商请求数据、authorization 字段和凭据。`adaptiveShadow` 从已完成选择推导一次零调用的 top-two 触发判断；它绝不发起升级。验证器分数是预测，不是 ground truth。调用方通过 `VerifierCallContext.evaluation` 附加测试、CI、grader、reward 或用户验收结果；没有独立证据时存储为 `unknown`。

无需网络或 API key 即可分析本地记录：

```sh
python3 scripts/analyze-verifier-runs.py .verifier-runs/
python3 scripts/evaluate-verifier-policy.py .verifier-runs/ --threshold 0.05
python3 scripts/export-verifier-dataset.py .verifier-runs/ --output /tmp/verifier-eval.jsonl
```

分析器会从准确率指标中排除未知 outcome，并报告配对 baseline uplift、oracle accuracy、regret、gap buckets、shadow 触发覆盖、存在实际升级数据时的升级 yield，以及验证成本。导出器只允许 schema-v1 元数据和哈希引用，不会添加轨迹正文。删除配置目录即可移除本地评估数据。经过净化的记录仍可能描述私有工作，并非匿名数据。

## 模型体验

### 智能体模型请求

#### 模型看到的内容

观察者不添加提示词段、工具 schema 或请求字段。验证器钩子只在持久 `session/event` 步骤和轮次边界之后运行。

#### Token 影响

观察者不增加智能体模型 token。

#### KV 缓存影响

观察者不会改变智能体模型的请求前缀或 KV 缓存复用。

## 已知限制和后续工作

- 信号仅存在于当前进程，重启后不会重放。
- 观察者一次评估一个轮次；整个 session 或跨 session 评估需要另一个消费者。
- 严格提供商错误在这里仍会被隔离，因为辅助测量不能使已提交的 session 历史失效。
- DSH 没有通用正确性事件；除非选择调用方提供独立证据，否则 outcome 保持 `unknown`。
