# verification/ — trajectory verification capability family

English | [中文](README.zh.md)

This family evaluates completed agent work without changing model generation or DeepSeek transport behavior.

| Package | Role | `ctx` key or event |
|---|---|---|
| [`verifier/`](verifier/README.md) | Defines verifier operations, canonical trajectories, and generation-independent Best-of-N orchestration | `ctx.verifier` |
| [`verifier-llm-as-verifier/`](verifier-llm-as-verifier/README.md) | Implements scoring, comparison, selection, and progress with the optional Python `llm_verifier` package | registers on `ctx.verifier` |
| [`verifier-observer/`](verifier-observer/README.md) | Measures committed steps and turns without controlling the agent | `verifier/progress`, `verifier/trajectory` |

The adapter consumes provider-neutral durable session events. It deliberately excludes private reasoning, streaming chunks, request headers, provider provenance, and tool-call wire payloads. Measurement failures do not invalidate an otherwise valid trajectory unless a caller directly enables strict provider behavior.

The [optional trajectory verification Agent Note](../../.agents/notes/implemented/feature/2026-08-18-optional-trajectory-verification.md) owns the design and limitations.
