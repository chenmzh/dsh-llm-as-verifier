# dsh-llm-as-verifier/core

English | [中文](README.zh.md)

This Service Definition publishes one optional verifier through `ctx.verifier`. A provider may implement any subset of `score`, `compare`, `select`, `onStepEnd`, and `onTrajectoryEnd`; unsupported required operations fail explicitly, while absent lifecycle hooks are no-ops.

The `verifier` settings namespace contains the live master switch and selected plugin id. `enabled: false` or `plugin: null` makes the service inert even while providers are mounted. `plugins()` exposes detached descriptors for configuration surfaces, and `testCapability()` delegates a privileged probe to the named provider without selecting it or changing Worker state.

## Canonical trajectories

`TrajectoryAdapter` reconstructs `AgentStep` values from committed `SessionEvent` records. Each step retains visible assistant text, ordered tool names and inputs, committed outputs, bounded tool metadata, sanitized tool errors, the last visible answer, and the terminal turn reason. It excludes reasoning blocks, `assistant/chunk`, model request data, provider metadata, and raw DeepSeek payloads. Per-field and whole-trajectory UTF-8 byte limits retain evidence from both ends of oversized text.

`serializeStep()` and `serialize()` produce readable, bounded text for verifier backends. The structured trajectory remains available to unit-test, security, human, or composite verifier implementations.

## Best-of-N

`runBestOfN()` calls the supplied rollout function `n` times concurrently, adapts each completed result, and delegates only selection to the verifier. It never generates candidates itself and returns the exact selected original object.

A provider may attach relative selection confidence and verification telemetry to the result without changing candidate ownership. Confidence describes ranking separation and whether more evaluation is recommended; it is not a probability that the selected candidate is correct.

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

## Model Experience

### Agent model request

#### What the model sees

Installing this Service Definition adds no prompt section, tool schema, or request field. Canonical `SessionEvent` data flows only to an explicitly configured verifier provider.

#### Token effect

Installing the Service Definition alone adds no agent-model tokens.

#### KV Cache effect

Installing the Service Definition alone does not change the agent model's request prefix or KV-cache reuse.

## Known Limitations and Deferred Work

- The built-in adapter consumes current `SessionEvent` records; foreign harness results need a caller-supplied adapter.
- Best-of-N runs candidates concurrently and does not add retry, branching, budget, or early-stop policy.
- Progress and final scores are measurements. This package does not interpret them as agent-control decisions.
