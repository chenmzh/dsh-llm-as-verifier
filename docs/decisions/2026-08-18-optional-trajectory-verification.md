# Agent Note: Optional trajectory verification seam

Status: implemented

English | [中文](2026-08-18-optional-trajectory-verification.zh.md)

## Problem

Agent execution and value evaluation have different responsibilities. DeepSeek Harness owns model requests, streaming, tool execution, durable events, and termination, while an evaluator needs bounded evidence and must not learn DeepSeek transport fields or control the loop by accident. Direct calls from `agent-loop` into one verifier implementation would make normal runs depend on optional infrastructure and couple future unit-test, security, human, or composite evaluators to one backend.

The integration also needs final scoring, pairwise comparison, Best-of-N selection, and optional step progress. Backend failure must normally preserve valid agent work, candidate selection must retain original result identity, and progress must remain a signal rather than an implicit stopping policy.

## Decision

Add a complete verification capability family under `packages/verification/`.

`@deepseek-ai/dsh-verifier` is the Service Definition. `VerifierPlugin` has optional `score`, `compare`, `select`, `onStepEnd`, and `onTrajectoryEnd` operations, and `ctx.verifier` publishes one effect-scoped implementation. `runBestOfN` owns no generation: a caller supplies the independent rollout and adaptation functions, then the configured verifier selects from detached candidate records. The result retains the exact original candidate object.

The global verifier setting and selected provider are prerequisites. Each session follows that state until its last successfully completed `/verifier on|off|default` command selects a mode; `off` suppresses later dispatches, while `on` and `default` remain subordinate to the global master switch. The existing durable `command/run` and successful `command/done` pair is the authoritative switch, so resume restores the mode without a second domain event and an interrupted or failed command cannot change it. `/verifier status` reports state without scheduling a model turn or changing the mode. `VerifierDispatchContext` carries the owning `Session` to the generic runtime, which resolves policy at dispatch and removes the Session before invoking a provider. The session observer always supplies it. Direct runtime and Best-of-N callers supply it when session policy applies. Already-started verifier work completes under the state resolved when it began.

`TrajectoryAdapter` projects committed `SessionEvent` records into provider-neutral `CanonicalTrajectory` values. It retains visible assistant answers, ordered tool calls and parsed inputs, committed outputs, bounded tool metadata, sanitized tool errors, and turn outcomes. It excludes reasoning blocks, raw chunks, request headers, model provenance, and provider wire data. UTF-8 field and trajectory ceilings preserve bounded evidence from both ends.

`@deepseek-ai/dsh-verifier-llm-as-verifier` is the optional Service Provider. A persistent managed Python worker imports `llm_verifier` only when configured, maps final scoring to the final `track` checkpoint, uses its fine-grained pair scorer and PPT primitives for comparison and selection, and maps progress to `ProgressTracker`. Final scoring appends the terminal answer after canonical steps. The fixed `deepseek-v4-flash` client uses native DeepSeek requests only for the official endpoint by default; custom endpoints use generic OpenAI-compatible transport unless explicitly overridden. Before its first verifier operation, the worker sends a short score-token capability probe with a configurable 1024-token budget and one 2048-token retry only after reasoning exhausts the first budget. Successful detection is cached for the worker process without credential material. Reasoning-only budget exhaustion raises `VerifierProbeInconclusive`; a normally completed response with a score token and missing or unusable score-position logprobs raises `VerifierCapabilityError`. Provider-owned extractors still compute every operation's expectations only from usable A–T `top_logprobs` at the exact `<score_A>`, `<score_B>`, or `<cN>` positions instead of using upstream text or neutral-score fallbacks. A bounded capability diagnostic compares visible response text with the chosen-token logprob stream and records score-payload span candidates, raw alternatives, discard reasons, and tokenization class without retaining the full response. Credentials resolve through `ctx.credentials` for every operation and enter a scrubbed worker environment by explicit reference. Responses, stderr, deadlines, tracker retention, and diagnostics are bounded; configured credential values are redacted.

Generic OpenAI-compatible DSV4 scoring overrides `llm_verifier` 0.2's one-token score-tag prefill budget with the verifier-only `scorePrefillMaxTokens` setting. Its 2048 default permits reasoning endpoints to emit the actual answer-position logprobs while leaving all Worker budgets unchanged.

`@deepseek-ai/dsh-verifier-observer` is the Consumer. It listens to post-commit `session/event` boundaries, serializes measurement work per session, reconstructs one turn, and emits live `verifier/progress` and `verifier/trajectory` signals. It adds no durable event and takes no stop, retry, resample, pruning, or compute-allocation action. Observer failure is always contained after commit. Direct provider calls use fail-open behavior by default and may opt into strict failure propagation.

The provider treats `maxWorkers` as verifier-only bounded concurrency and defaults it to four independently of every Worker pool. Each operation snapshots cumulative upstream usage after capability detection, so operation tokens exclude the separately reported probe cost. Result details report planned and actual logical comparisons and API calls, safe endpoint identity, token-cache accounting, scale-distribution coverage, ranking, and latency. Optional `maxCallsPerOperation` and `maxComparisons` limits reject an oversized no-selection-cache plan before any probe or scoring request.

No `agent-loop`, LLM adapter, DeepSeek protocol, session event vocabulary, generated SDK projection, or structural session-format version change is required. The existing paired command lifecycle log carries the session policy.

## Testing

Unit tests use fake verifier gateways and managed subprocess handles; no paid API is required. They cover inert operation with no provider, capability dispatch, per-session isolation, durable mode replay, mid-session off/on switches, provider context minimization, canonical evidence and exclusions, UTF-8 bounds, Best-of-N identity, scoring, comparison, selection validation, progress ordering, tracker reset, missing credentials and backend failure mapping, strict propagation, timeouts and cancellation, credential rotation, malformed and oversized worker frames, process cleanup, setup disposal, post-commit observer containment, missing task or step evidence, configuration defaults and rejection, fixed DSV4 request parameters, native and generic verifier transports, exact score-position token normalization and capability rejection, separate and fused tokenization diagnostics, incomplete chosen-token stream classification, probe completion classification, bounded retry, successful detection caching and configuration invalidation, per-operation usage deltas, separate probe cost, logical-comparison and API-call telemetry, duplicate-safe scale coverage, fixed-operation preflight budgets, diagnostic redaction, complete final-answer scoring, explicit fail-open selection logging, and unchanged GPT-, Claude-, local-, and DSV4-worker settings and client identities.

The runnable headless Cordis overlay loads the real Service Definition, Python provider, and lifecycle Consumer. A keyless Loader-composition test boots `cordis.yml`, discovers `/verifier`, and proves that one session switch does not affect another. A keyless shipped Web scaffold switches one live session off before a replayed model turn, switches it on afterward, and pins both the durable lifecycle and human command rows. External `llm_verifier` calls remain outside keyless unit tests.

## Alternatives considered

- **Call `llm_verifier` from `agent-loop`** — rejected because lifecycle events already expose committed steps and turns, and one evaluator must not become execution machinery.
- **Store verifier-specific fields in session trajectories** — rejected because the durable log already contains the evidence and backend response formats are not execution facts.
- **Reuse the worker model, endpoint, client, or concurrency for verification** — rejected because execution routing is user-owned and verifier measurement needs an independently configured DSV4 Flash client and budget.
- **Infer DeepSeek-native transport from the verifier model** — rejected because compatible gateways may serve DSV4 Flash without DeepSeek reasoning extensions; endpoint resolution and explicit transport config own request behavior.
- **Let the verifier generate Best-of-N candidates** — rejected because generation routing, retries, and resource policy belong to Harness orchestration; selection receives only completed candidates.
- **Add a dedicated `verifier/mode` event** — rejected because the paired command lifecycle already persists the accepted switch; a second record would give one fact two durable homes.
- **Make progress stop or resample automatically** — rejected because measurement and control policy need separate plugins, configuration, and lifecycle decisions.
- **Require Python verification in the base install** — rejected because normal Harness execution must not depend on evaluator credentials, availability, or Python packages.
- **Use only the process-global verifier switch** — rejected because interactive sessions need independent runtime control and a global mutable setting makes one session change every concurrent session.

## Consequences

- Verification is opt-in composition; installing the generic service alone changes neither model requests nor ordinary session execution.
- A globally enabled verifier applies to sessions by default, while each session can durably suppress or restore only its own later verifier work.
- Future verifier implementations can replace the provider without changing the adapter, observer, or execution loop.
- Candidate generation and evaluator spending are independently configurable and observable. Enabling verification cannot change the worker model, provider, endpoint, client, concurrency, or rollout strategy.
- The verifier process spends one short request on first-use capability detection and at most one larger retry after reasoning-only budget exhaustion; successful detection amortizes across later operations with the same credential-free endpoint identity, model, transport, fixed logprob settings, and probe budgets.
- Verifier concurrency, planned work, actual calls, tokens, and latency are measurable and bounded without reading or changing Worker configuration.
- A committed trajectory remains usable when auxiliary evaluation fails, while strict direct callers can require a score.

## Known limitations and deferred work

- `llm_verifier` 0.2 has no standalone final score call, so the provider uses the last `track` checkpoint.
- Every verifier endpoint must implement DSV4 Flash requests with a complete chosen-token logprob stream and usable A–T `top_logprobs` at each requested score position. A response-level score tag does not compensate for an omitted score span in the logprob stream. Reasoning-only probe budget exhaustion remains inconclusive; normal completion with a score token proves absence or malformed score-position logprobs. Text-only and neutral-score fallbacks are disabled; both failure classes fail open by default and propagate in strict direct calls.
- Live measurement signals are process-local and are not replayed from durable history.
- A direct runtime or Best-of-N caller that omits the owning Session receives process-global behavior; session-aware orchestration must pass `VerifierDispatchContext.session`.
- The worker path must be visible to the configured subprocess provider; remote execution needs an explicit mount.
- Evaluator-driven Worker stopping, retries, feedback rounds, branch pruning, rollout allocation, and goal or Ralph completion policy remain separate future Consumers. Verifier-side staged reevaluation of existing candidates is owned by [Adaptive verifier selection](2026-08-18-adaptive-verifier-selection.md).
