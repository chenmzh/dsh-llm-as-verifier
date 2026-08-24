# dsh-llm-as-verifier/provider

English | [中文](README.zh.md)

This optional Service Provider implements the generic verifier with the Python [`llm_verifier`](https://github.com/llm-as-a-verifier/llm-as-a-verifier) package. It always evaluates with `deepseek-v4-flash`; the agent model, provider, endpoint, client, concurrency, and rollout policy remain owned by the existing Harness runtime. A managed persistent JSON-lines worker maps final scoring to `llm_verifier.track`, uses the upstream fine-grained pair scorer and PPT primitives for comparison and Best-of-N selection, and uses `ProgressTracker` for online updates.

Install the Python dependency before enabling this provider:

```sh
python3 -m pip install 'llm-verifier>=0.2,<0.3'
```

The npm package remains usable without the Python dependency until the provider is configured and called. The verifier API key is resolved through `ctx.credentials` from `apiKeyEnv`, which defaults to `DEEPSEEK_API_KEY`, copied to a scrubbed verifier-worker environment, and never stored in Cordis config. Explicit `baseURL` configures only the verifier client; otherwise `VERIFIER_BASE_URL` is read from the immutable launch environment, then `https://api.deepseek.com` is used. `transport: auto` resolves the resulting official URL (including `/v1`) to `deepseek-native` and every custom URL to `openai-compatible`; an explicit transport value overrides this resolution. An OpenCode or other Worker remains independently configured while this verifier uses the official DeepSeek endpoint.

The provider registers the live `verifier-llm-as-verifier` settings namespace and an `llm-as-a-verifier` directory descriptor. Web configuration continues to use `settings.*` and `credentials.*`; the API key is write-only and environment-owned credentials remain read-only. The Host capability action calls the same strict probe used before verifier operations and returns only a safe capability summary.

## Configuration

The runnable [headless example](../../../examples/headless-agent/verifier.cordis.yml) adds verification to the existing agent:

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

Run it with `DEEPSEEK_API_KEY` available to the Harness credential provider. An explicit `baseURL` takes precedence over `VERIFIER_BASE_URL`, which takes precedence over `https://api.deepseek.com`; none of these values changes the agent endpoint:

```sh
pnpm dsh --profile headless --patch examples/headless-agent/verifier.cordis.yml \
  "Fix the failing tests in this repository."
```

Official native transport applies the verifier-only `reasoningEffort` (`off`, `low`, or `high`) as request fields. The persistent worker owns an operation-scoped policy and never mutates `DEEPSEEK_EFFORT` or another process-global setting while concurrent scoring jobs run. Generic transport sends the fixed model plus standard OpenAI-compatible `messages`, `logprobs=True`, and `top_logprobs=20`; it does not enable DeepSeek reasoning fields. Override automatic resolution only when the endpoint requires the other behavior.

Before the first verifier operation, the persistent Python worker sends a short `<score_A>` capability probe with a 1024-token output budget. If DSV4 returns only reasoning, consumes at least 90% of that budget, and ends with `finish_reason: length` before answer content, the worker retries once with 2048 tokens. A second exhaustion raises `VerifierProbeInconclusive` with `OUTPUT_BUDGET_EXHAUSTED`; it does not claim the endpoint lacks logprobs. A normally completed response that emits the score token without usable score-position logprobs raises `VerifierCapabilityError` with the exact extraction reason and safe score evidence. Token-level logprobs count as supported only when their chosen-token stream contains the score payload position and that position exposes a usable A–T alternative. Successful detection is cached in-process by the credential-free endpoint identifier, model, transport, fixed logprob request settings, and probe budgets. Changing any of those settings runs a new probe; credential values never enter the key.

Generic OpenAI-compatible scoring uses the upstream score-tag prefill path. `scorePrefillMaxTokens` replaces upstream's one-token prefill budget so DSV4 can finish reasoning before it emits the score token; it defaults to 2048 and affects only verifier prefill requests.

Selection keeps ring and pivot results in phase-qualified entries. The same directed candidate pair scheduled in both phases remains two independent evaluations, while adaptive stages reuse the same phase, pair occurrence, criterion, and repetition from their selection-scoped cache. Missing internal entries raise a bookkeeping error instead of becoming synthetic 0.5 ties.

Verifier result details include one bounded record per scoring job. Its stable comparison id identifies phase, pair occurrence, criterion, repetition, candidate indices, and prompt slot order. Each score position retains raw endpoint alternatives, exact A–T normalization, retained and discarded returned probability mass, raw, mapped, unique-scale, and discarded alternative counts, `scale_mass`, expected reward, raw reward delta, Bradley–Terry preference, finish reasons, verifier-only token usage, and latency. Capability diagnostics add a bounded chosen-token window, score-payload span candidates, tokenization class, message/token-stream agreement, and per-alternative discard reasons. Extraction failures distinguish absent or empty top-logprobs, no valid complete scale token, malformed logprobs, missing score positions, and an incomplete chosen-token stream without retaining full trajectories or verifier analysis. `scale_mass` sums endpoint probabilities after the extractor keeps only the highest-logprob token form for each A–T letter, matching the unchanged expected-reward duplicate policy without double-counting forms such as `A` and `>A`.

Candidate scores are tournament preference signals, not probabilities of task correctness. Selection results therefore report relative `confidence`: the top score, runner-up score, score gap, `low`/`medium`/`high` level, and whether the configured target level recommends more verification. `mediumGap` defaults to 0.03, `highGap` to 0.10, and `targetLevel` to `high`.

Omitting `adaptive` or setting `adaptive.enabled: false` preserves one selection operation with the configured `nEvaluations`, criteria, pivots, and reasoning effort. `adaptive.strategy: staged` retains the cumulative K=1, K=2, then K=4 plan over all configured criteria. A stage can name a criterion subset, but every later stage must retain all earlier criterion/repetition work.

`adaptive.strategy: top-two` retains the baseline PPT ranking when its top-two gap meets `top2GapThreshold`. A smaller gap schedules only the leading pair in both slot orientations for `additionalEvaluations` rounds, then adds those independent Bradley–Terry comparison results to the existing ring and pivot totals. It does not compare close lower-ranked candidates or generate new trajectories. `maxExtraCalls` bounds that work; `escalationReasoningEffort` may raise verifier reasoning for only the added requests. This mode remains opt-in:

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

Every adaptive selection uses a temporary phase-qualified score cache. Cumulative stages add only missing criteria or repetitions. Top-two escalation requires the completed baseline entries and adds only its `adaptive` phase; a missing baseline entry is an internal error rather than a rerun or synthetic tie. The provider deletes the cache after either strategy finishes.

Adaptive verification checks its budget only before another stage starts. Fixed and adaptive worker operations may also set `maxCallsPerOperation` or `maxComparisons`; this conservative preflight uses the no-selection-cache plan and rejects oversized work before the capability probe or scoring calls. `maxCalls` defaults to 32 and `maxLatencyMs` to 45000; optional `maxInputTokens`, `maxOutputTokens`, and `maxReasoningTokens` limits use backend usage reports. The next-stage estimate scales observed cumulative cost by newly added criterion/repetition units. One in-flight stage is not interrupted, so a single stage may finish beyond a limit; no further stage begins. The partial ranking remains available with `verification.stoppedReason` such as `max_calls`, `max_latency`, `stages_exhausted`, or `verifier_error`.

Run the optional real-endpoint diagnostic manually from the repository root. It evaluates one obvious reverse-string pair directly in both slot orders with one correctness criterion and K=1; it does not run PPT, selection, or adaptive escalation. Output includes every raw and normalized score distribution, candidate rewards, raw delta, Bradley–Terry preference, finish reason, token usage, latency, and a semantic-success, semantic-failure, slot-bias, or slot-sensitivity classification:

```sh
DEEPSEEK_API_KEY=... python3 scripts/smoke-dsv4-verifier.py
```

Use `--capability-only` to run only the bounded first-use probe. Its output contains the model, finish reason, input/output/reasoning token counts, score-token and logprob presence, bounded score-position token evidence, failure reason, latency, and retry attempt without task trajectories or credentials.

Verifier cost scales with PPT comparisons × criteria × `nEvaluations`; long canonical trajectories usually dominate input-token cost. The recommended starting point is one overall criterion, `nEvaluations: 1`, `pivots: 2`, and verifier-only `maxWorkers: 4`.

Run `python3 scripts/benchmark-dsv4-verifier.py --matrix 4:1 --reasoning-effort low --tasks arithmetic,reverse,logic --output /tmp/dsv4-adaptive-benchmark.json` for the small deterministic policy suite. Add `--adaptive-top-two --top2-gap-threshold 0.08 --escalation-reasoning-effort high` to measure selective escalation. The paid opt-in utility prints planned baseline and maximum extra work before calls, persists every completed result, and reports ranking, scores, baseline and escalation usage, latency, capability-cache reuse, and offline threshold decisions. It never changes production config or Worker settings.

`strict: true` is the production default. Set `strict: false` to retain fail-open behavior. Missing credentials, backend errors, rate limits, timeouts, inconclusive capability probes, malformed responses, absent or unusable A–T token logprobs at any required `<score_A>`, `<score_B>`, or `<cN>` position, and serialization failures then produce a warning and failure metadata while preserving the original trajectory. Direct calls propagate these errors when `strict: true`. The post-commit observer always contains failures because measurement cannot roll back a committed session event.

Structured operation telemetry reports the credential-free endpoint identifier, candidate and criterion counts, K, pivots, verifier-only `maxWorkers`, reasoning effort, planned and actual logical comparisons, planned and actual API calls, wall time, input, cached, uncached, output, and reasoning tokens, token cache hit rate, ranking, scores, and capability-probe execution or cache reuse. Top-two selection additionally separates baseline and escalation latency, comparisons, calls, token usage, reasoning effort, trigger, budget skip, and ranking-change facts. The operation token delta excludes the separately reported capability-probe cost. Telemetry does not include task or trajectory bodies. Worker stderr and response sizes are bounded, and diagnostics redact configured credential values.

## Best-of-N

Use `runBestOfN()` from `dsh-llm-as-verifier/core` with `ctx.verifier`. Pass the owning `Session` in `context` when the caller needs per-session verifier mode. Selection then passes through the generic runtime and its data-minimized observation event. The caller owns independent Harness runs and adaptation; its worker strategy is not read or changed by the verifier; this provider receives only canonical candidate text and returns the selected index, scores, ranking, and metadata while the generic helper retains original candidate identity.

## Model Experience

### Agent model request

#### What the model sees

The provider adds no verifier prompt, tool, request header, reasoning setting, or stream field to the agent request. Verification runs after committed `session/event` boundaries.

#### Token effect

The provider adds no agent-model tokens.

#### KV Cache effect

The provider does not change the agent model's request prefix or KV-cache reuse.

### Verifier model request

#### What the model sees

The task and bounded canonical evidence: visible answers, tool interactions, committed observations, errors, and outcomes. The separate verifier client always requests `deepseek-v4-flash` with `logprobs=True` and `top_logprobs=20` so the provider can compute the expected reward over A–T probabilities at each exact score position. Native transport retains upstream DeepSeek request parameters; generic transport omits DeepSeek reasoning fields. Agent transport data and private reasoning are absent.

#### Token effect

The first verifier operation in one Python worker adds one short capability request, plus at most one retry only when reasoning exhausts the first probe budget. One final verifier operation runs per observed turn. Enabling progress adds one operation per committed step; fixed `nEvaluations` and Best-of-N candidate count multiply verifier-side work. Adaptive Best-of-N starts with its first stage and spends later-stage calls only while relative confidence remains below the configured target and budget allows escalation.

#### KV Cache effect

Verifier requests are independent evaluations. The plugin does not promise shared prefixes or KV-cache reuse across checkpoints, candidates, or evaluator calls.

## Known Limitations and Deferred Work

- `llm_verifier` 0.2 exposes no standalone final `score` function, so final scoring uses the last checkpoint returned by `track`.
- Every configured verifier endpoint must return a usable A–T token-level logprob distribution. A bounded probe that ends before a score token is inconclusive; only a normally completed probe with a score token and absent or malformed score-position logprobs reports `VerifierCapabilityError`. Neither path falls back to a text-only score; calls fail open unless strict direct calls are enabled.
- `nEvaluations` defaults to one, while `maxWorkers` is verifier-call concurrency and defaults to four. Neither setting inherits from or changes rollout concurrency.
- Adaptive mode is opt-in for compatibility. Its call, latency, and token limits are stage-boundary admission checks, not mid-request cancellation deadlines.
- `reasoningEffort` defaults to `high`. `low` and top-two escalation are explicit policies until real benchmark evidence supports a different production default.
- Python must run in the same filesystem environment as the published `worker.py`; remote subprocess providers need that file mounted at the same path.
- Verification does not stop, retry, resample, or prune agent work. A separate Consumer may later apply policy to emitted measurements.
