# Agent Note: Web verifier configuration

Status: implemented

English | [中文](2026-08-19-web-verifier-configuration.zh.md)

## Problem

The optional verifier could be composed only through Cordis configuration and process credentials. A browser needed to select the verifier, manage its credential, tune a small supported settings surface, and run the existing strict DSV4 capability probe without gaining access to credential values or coupling verification to Worker execution.

## Decision

The provider-neutral verifier settings namespace owns only enabled and the selected plugin id. Its defaults are false and null, so mounting the verification packages does not change agent execution. VerifierRuntime keeps a descriptor directory keyed by plugin id; unavailable or unselected implementations cannot receive calls.

llm-as-a-verifier registers its own verifier-llm-as-verifier namespace and descriptor. Settings changes rebuild the verifier-only gateway and swap it after successful resolution, so subsequent eligible calls use the new endpoint, reasoning effort, evaluation count, pivots, verifier concurrency, strict policy, and adaptive policy without restarting the Harness. The verifier-observer namespace independently controls local evaluation logging and adaptive-shadow observation. Adaptive verification and logging remain disabled by default.

The DeepSeek credential stays at the DEEPSEEK_API_KEY credential reference. The WebUI uses credentials.describe, credentials.set, and credentials.unset; describe returns only configured, source, and writable fields. Environment-owned credentials win and remain read-only. Browser code holds a newly entered value only in the password input until the write settles, then clears it. It never persists the value or receives an existing value.

The Host adds verifier.plugins for value-free discovery and verifier.test for the privileged capability action. The action dispatches through the registered provider to the existing Python strict capability probe. The browser receives only the plugin, fixed model, endpoint origin, three capability booleans, latency, or a stable failure reason. Raw prompts, token streams, headers, backend diagnostics, and credentials are not response fields. Both methods use the existing loopback/same-origin RPC carrier.

Verification remains downstream of candidate generation. Enabling it does not create another Worker trajectory or change Worker model selection, provider, endpoint, concurrency, retries, or rollout strategy. The page states that one candidate offers no meaningful selection and that a separate Best-of-N caller must supply multiple candidates.

## Alternatives considered

**A verifier-specific configuration REST API.** Rejected because the settings and credentials domains already own persistence, live updates, redaction, ownership, and loopback authorization. A second API would duplicate those rules and create inconsistent credential behavior.

**Store the API key in verifier settings.** Rejected because settings descriptions are readable and only schema-marked secrets are redacted. The credential reference seam already provides write-only Web behavior and environment precedence.

**Hardcode the page to one implementation.** Rejected because plugin ids and descriptors let later unit-test, security, or composite verifiers join without changing the page's master selection architecture.

**Let enabling verification create Worker rollouts.** Rejected because candidate generation and selection have different owners. Coupling them would silently change cost, concurrency, retry, and Worker behavior.

## Consequences

The base bundle can mount the verifier directory, provider, and observer while remaining behaviorally inert. Three settings namespaces update independently, and the managed credential continues to live under the Harness credential provider's private storage rather than settings or browser persistence. Capability testing can incur one verifier API call but never a Worker call.

The plugin directory and credential-security decisions remain future-facing constraints, so this note stays active. The earlier optional-verification, adaptive-selection, and local-evaluation notes remain active because their scoring, budget, and privacy decisions are complementary rather than superseded.
