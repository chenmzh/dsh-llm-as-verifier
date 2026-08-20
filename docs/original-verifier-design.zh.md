# verification/ — 轨迹验证能力族

[English](README.md) | 中文

本能力族评估已经完成的智能体工作，不改变模型生成过程或 DeepSeek 传输行为。

| 包 | 角色 | `ctx` 键或事件 |
|---|---|---|
| [`verifier/`](verifier/README.md) | 定义验证操作、规范轨迹和与生成解耦的 Best-of-N 编排 | `ctx.verifier` |
| [`verifier-llm-as-verifier/`](verifier-llm-as-verifier/README.md) | 使用可选 Python `llm_verifier` 包实现评分、比较、选择和进度测量 | 注册到 `ctx.verifier` |
| [`verifier-observer/`](verifier-observer/README.md) | 测量已提交的步骤和轮次，不控制智能体 | `verifier/progress`、`verifier/trajectory` |

适配器读取与提供商无关的持久 session 事件，并明确排除私有推理、流式分块、请求头、提供商来源信息和工具调用线协议载荷。除非直接调用方启用严格提供商行为，否则测量失败不会使原本有效的轨迹失效。

[可选轨迹验证 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-optional-trajectory-verification.md)记录了该设计及其限制。
