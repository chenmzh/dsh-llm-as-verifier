# Agent Note: Adaptive verifier selection

Status: implemented

English | [中文](2026-08-18-adaptive-verifier-selection.zh.md)

## Problem

Best-of-N selection previously ran one fixed verifier plan and returned the highest tournament score. A small top-two difference such as 0.500154 versus 0.499846 still produced a winner even though the ranking was uncertain. Always increasing evaluations or criteria would improve difficult cases at the cost of the same latency and token spend on easy cases.

Selection policy must interpret verifier ranking separately from Worker execution. It may spend additional evaluator work on already completed trajectories, but it must not launch rollouts, replace the Worker client, or change Worker model, endpoint, concurrency, retries, or budgets.

## Decision

The LLM-as-a-Verifier provider reports relative selection confidence from the top-two score gap. The result includes the top score, second score, gap, a low, medium, or high level, and whether the configured target recommends more verification. Tournament scores and confidence are preference signals, not calibrated probabilities of task correctness.

Adaptive selection is opt-in. Its stages are cumulative criterion/repetition plans: every later stage must contain all work from the previous stage. The default enabled plan evaluates K=1, K=2, then K=4 across all configured criteria, recomputes confidence after each stage, and stops when the target level is reached. Pivots remain fixed. Candidate generation remains entirely with the existing Harness caller.

The provider also offers an opt-in `top-two` strategy. It runs the configured K=1 PPT baseline, then compares only the leading pair when their score gap is below a configured threshold. Escalation schedules both candidate orientations for each added round and aggregates those comparisons with the completed ring and pivot results through the same Bradley–Terry and PPT score totals. Closeness among lower-ranked candidates does not trigger more work.

Each adaptive selection owns a temporary cache identifier. The Python worker maps it to a bounded temporary file whose entries include phase, pair occurrence, candidate indices, criterion, and repetition. Later stages add only missing criterion/repetition comparisons, while a directed pair scheduled independently in ring and pivot phases remains two evaluations. The TypeScript provider releases the cache in a finally path. Cache identifiers contain no credentials and are never shared between independent selections.

Top-two escalation requires every baseline ring and pivot entry in that cache and records added work under an independent `adaptive` phase. A missing baseline result is an internal error; escalation does not rerun the tournament or substitute a tie. Its call ceiling and the operation-wide call, comparison, latency, and token budgets are admission checks. A rejected escalation returns the valid baseline ranking with its structured budget reason.

Native DeepSeek reasoning effort is an explicit verifier request setting. The persistent Python client applies one immutable effort for the complete serialized operation, so its internal comparison threads share the same setting without mutating process environment variables. Baseline and escalation may use different efforts. Generic OpenAI-compatible transport continues to omit DeepSeek reasoning fields.

The provider owns the small selection orchestration around upstream fine-grained scoring and PPT primitives. Ring and pivot result sets remain separate through pivot discovery, then both feed final aggregation exactly once. A missing scheduled result is an internal error; only an actual verifier failure may follow the configured failure policy. This avoids llm_verifier 0.2's no-cache phase-B map replacement, where lost ring keys were read as 0.5 ties and a pivot result could stand in for a ring result.

Call and elapsed-time budgets default to 32 calls and 45 seconds when adaptive mode is enabled. Optional input, output, and reasoning token limits use verifier usage reports. Before another stage, the provider estimates incremental cost from completed work units and refuses a stage that would exceed the remaining budget. An in-flight stage is not cancelled. The current ranking remains available with a structured stop reason when confidence stays below target or a later fail-open stage fails.

Omitting adaptive configuration preserves the fixed selection plan. The provider still reports confidence and verification telemetry without changing the selected candidate or original candidate identity.

## Alternatives considered

- **Treat the winning score as confidence** — rejected because tournament scores rank candidates and are not correctness probabilities.
- **Always run the maximum evaluation count** — rejected because obvious rankings do not justify the same verifier cost as ambiguous rankings.
- **Regenerate candidates after a low-confidence stage** — rejected because rollout policy belongs to the Worker runtime, not the verifier.
- **Repeat every earlier comparison during escalation** — rejected because phase-qualified cache keys distinguish pair occurrence, candidate indices, criterion, and repetition without merging independent ring and pivot evaluations.
- **Use a one-direction top-pair tie-break** — rejected because it would reintroduce prompt-slot bias; targeted escalation always schedules both orientations.
- **Change `DEEPSEEK_EFFORT` around requests** — rejected because process-global mutation is unsafe while the verifier scores comparisons concurrently.
- **Interrupt an in-flight stage at the exact budget boundary** — deferred because the persistent gateway serializes operations and upstream calls do not expose a safe partial-stage cancellation result.
- **Return no candidate when confidence remains low** — deferred to preserve existing callers; low confidence and stop metadata state the ambiguity explicitly.

## Consequences

- Easy selections can stop after the first inexpensive stage, while ambiguous selections consume additional configured verifier budget.
- Downstream callers can distinguish the selected winner from certainty in that ranking without treating either value as task correctness probability.
- Budget enforcement occurs at stage boundaries, so a completed stage can exceed a limit; no later stage starts after that condition is observed.
- Selection-scoped caches reuse successful work during escalation, keep independent tournament phases distinct, and are deleted after completion or failure.
- Top-two results report baseline and escalation usage separately, plus the stage-one gap, trigger or budget skip, extra work, and whether the winner or ranking changed.
- Adaptive settings affect only the fixed DSV4 Flash verifier client. Worker generation and orchestration remain unchanged.

## Related decisions

- The provider-neutral capability, strict score-position logprob semantics, and Worker isolation are defined by [Optional trajectory verification seam](2026-08-18-optional-trajectory-verification.md).
