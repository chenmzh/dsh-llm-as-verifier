# dsh-llm-as-verifier/observer

English | [中文](README.zh.md)

This Consumer listens to post-commit `session/event` notifications and invokes the optional verifier hooks. At each `step/end` it reconstructs that turn, supplies the new canonical step to `onStepEnd`, and emits `verifier/progress` when a result exists. At `turn/end` it calls `onTrajectoryEnd` and emits `verifier/trajectory`.

Tasks come from the user message admitted for the turn, with the latest earlier human prompt as an imported-session fallback. Work is serialized per session, tracker ids are stable per session turn, and plugin disposal drains queued measurements. Missing task or step evidence is logged and skipped. Any verifier or listener failure is contained after the session event commits. Sessions with a successful `/verifier off` command skip later measurements until `/verifier on` or `/verifier default` is completed; the observer supplies the owning session to the runtime for this decision.

The emitted signals are live typed events, not durable session events. Policy plugins can observe them for future early stopping, retry, resampling, pruning, or adaptive-compute decisions without adding those decisions to this measurement Consumer.

## Configuration

`maxFieldBytes` defaults to `65536`; `maxTrajectoryBytes` defaults to `524288`. Both are validated positive safe integers and are applied independently of the provider's defensive serialization bounds.

Selection evaluation logging is disabled by default. When enabled, the observer writes schema-versioned JSONL to one private daily-named file per plugin instance under the configured local directory. Appends are serialized in-process, plugin disposal drains queued records, and a persistence failure warns without replacing a valid selection.

The `verifier-observer` settings namespace applies logging changes live. Disabling logging stops new appends immediately; changing the local path opens a writer for the new path. Adaptive shadow reads completed selection metadata only and never dispatches another verifier call.

```yaml
evaluationLogging:
  enabled: true
  path: .verifier-runs
  adaptiveShadow:
    enabled: true
    top2GapThreshold: 0.08
```

Records contain verifier configuration, ranking, scores, cost telemetry, hashed run/task identifiers, hashed trajectory references, and caller-supplied independent outcomes. They exclude task text, candidate objects, raw trajectories, provider request data, authorization fields, and credentials. `adaptiveShadow` derives one zero-call top-two trigger from the completed selection; it never dispatches escalation. Verifier scores are predictions, not ground truth. Callers attach test, CI, grader, reward, or user-acceptance outcomes through `VerifierCallContext.evaluation`; absent independent evidence is stored as `unknown`.

Analyze local records without network access or an API key:

```sh
python3 scripts/analyze-verifier-runs.py .verifier-runs/
python3 scripts/evaluate-verifier-policy.py .verifier-runs/ --threshold 0.05
python3 scripts/export-verifier-dataset.py .verifier-runs/ --output /tmp/verifier-eval.jsonl
```

The analyzer excludes unknown outcomes from accuracy metrics and reports paired baseline uplift, oracle accuracy, regret, gap buckets, shadow trigger coverage, actual escalation yield when available, and verifier cost. The exporter whitelists schema-v1 metadata and hashed references; it never adds trajectory content. Delete the configured directory to remove local evaluation data. Redacted records can still describe private work and are not anonymous.

## Model Experience

### Agent model request

#### What the model sees

The observer adds no prompt section, tool schema, or request field. Verifier hooks run only after durable `session/event` step and turn boundaries.

#### Token effect

The observer adds no agent-model tokens.

#### KV Cache effect

The observer does not change the agent model's request prefix or KV-cache reuse.

## Known Limitations and Deferred Work

- Signals are process-local and are not replayed after restart.
- The observer evaluates one turn at a time; session-wide or cross-session evaluation requires another Consumer.
- Strict provider errors remain contained here because committed session history cannot be invalidated by auxiliary measurement.
- DSH has no generic correctness event; outcomes remain `unknown` unless the selection caller supplies independent evidence.
