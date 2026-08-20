# Agent Note: Local verifier evaluation records

Status: implemented

English | [中文](2026-08-19-local-verifier-evaluation-records.zh.md)

## Problem

Verifier rankings and costs need evidence from routine Harness workloads before confidence or adaptive policy can be calibrated. Selection telemetry alone does not establish correctness, and persisting task text or trajectories would duplicate private source code, tool output, paths, and user data outside the session store.

Observation must remain auxiliary. A storage failure cannot invalidate a completed Worker trajectory or verifier selection, and disabled verification or logging must leave normal execution unchanged.

## Decision

`VerifierRuntime.select()` emits `verifier/selection` only after a provider returns a selection. The signal contains verifier identity, candidate count, ranking fields, cost telemetry, and caller-supplied evaluation context; it excludes task text, candidate objects, and canonical trajectories. `runBestOfN()` accepts the runtime as its selection dispatcher, so ordinary candidate generation remains owned by the existing caller while selection observations pass through one generic service.

The observer's disabled-by-default `evaluationLogging` option projects each signal into schema-versioned local JSONL. Each plugin instance owns a randomly named daily file and serializes appends through one process-local queue. Files and directories use private permissions where supported. Disposal drains pending writes; an append or close failure emits a warning and does not change the selection result.

The schema stores verifier settings, ranking and score fields, planned and actual costs, adaptive baseline and escalation costs, and a zero-call top-two shadow decision. Opaque run and task identifiers and trajectory references are SHA-256 digests. Task text, raw trajectories, candidate values, provider request data, authorization fields, and credential values are not copied. Export tooling applies a schema-v1 field whitelist rather than forwarding unknown input fields.

Verifier output is a prediction. Independent overall and candidate outcomes enter only through `VerifierCallContext.evaluation`; absent evidence is explicitly `unknown`. DSH completion events describe execution termination and are not converted into correctness labels. This preserves a clean distinction between selection decision and test, CI, grader, reward, or user-acceptance evidence.

The Python analysis tools use only the standard library and never call a verifier or require credentials. They exclude unknown outcomes from accuracy calculations, report paired candidate-zero uplift, oracle accuracy, regret, score-gap buckets, adaptive-shadow trigger coverage, actual escalation yield when present, and operation cost. Shadow analysis states only which recorded Stage-1 results satisfy a rule; it does not infer the result of an escalation that did not execute.

## Alternatives considered

- **Persist complete trajectories** — rejected because the session store already owns that data and an analysis side channel would widen exposure.
- **Treat the verifier winner as ground truth** — rejected because it would measure agreement with the verifier rather than selection quality.
- **Derive success from `turn/end` completion** — rejected because successful execution termination does not prove task correctness.
- **Upload records to a managed analytics service** — rejected because local-first observation is sufficient and requires no additional network or data processor.
- **Make telemetry persistence part of selection completion** — rejected because observational storage must not delay or invalidate a valid result.

## Consequences

- Normal DSH compositions can opt into local verifier evidence without changing Worker generation, provider, endpoint, concurrency, retries, or rollout policy.
- Records support future threshold and cost analysis while their schema remains explicit and evolvable.
- Hashed references and omitted content reduce exposure but do not make records anonymous; users retain and delete the local directory according to their own data policy.
- Accuracy, uplift, regret, and correction metrics remain unavailable for runs without independent outcomes.

## Related decisions

- The provider-neutral verifier and Worker separation are defined by [Optional trajectory verification seam](2026-08-18-optional-trajectory-verification.md).
- Confidence and opt-in escalation are defined by [Adaptive verifier selection](2026-08-18-adaptive-verifier-selection.md).
