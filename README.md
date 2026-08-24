# dsh-llm-as-verifier

[中文说明](README.zh.md)

Independent LLM-as-verifier runtime package for DeepSeek Harness. One installation exposes three Cordis plugins:

- `dsh-llm-as-verifier/core`: provider-neutral verifier runtime and Best-of-N helpers.
- `dsh-llm-as-verifier/provider`: DeepSeek/OpenAI-compatible Python worker provider.
- `dsh-llm-as-verifier/observer`: optional session lifecycle evaluation and JSONL records.

The package keeps a `cordis.patch.yml` composition fragment for clean compositions. DeepSeek Harness rc.8 already owns the three verifier row IDs and does not permit later bundles to change their package names, so rc.8 integration must replace those names in the base composition adapter. All three stay disabled by default. Verification starts only after the `verifier` settings namespace enables it and selects a provider. Each session follows that global state by default and may use `/verifier on`, `/verifier off`, or `/verifier default` to control its later verifier work independently.

## What this package does

The package separates verification policy, model access, and observation so each
part can be enabled and tested independently:

```text
DSH session/trajectory
        |
        v
verifier core  --->  llm-as-a-verifier provider  --->  DeepSeek/OpenAI API
        |
        +------> observer (optional JSONL evaluation records)
```

- The core owns provider discovery, scoring, comparison, selection, and
  trajectory adaptation.
- The provider owns credentials, endpoint selection, the managed Python worker,
  capability probing, score extraction, retries, and bounded concurrency.
- The observer can evaluate completed turns/steps and write optional local
  records without changing the agent's answer.

The provider defaults to strict mode. Set `strict: false` only when the caller
needs fail-open behavior. In fail-open mode, a verifier failure never becomes a
positive score: callers receive failure metadata and keep their configured
fallback candidate.

## Requirements and local build

Requires Node.js 22.19 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm pack:check
```

The provider also requires Python 3.9 or newer. Install its pinned runtime in an
isolated environment and configure DSH to use that interpreter:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Set `verifier-llm-as-verifier.pythonExecutable` to the absolute path of
`.venv/bin/python`. The provider reports `PYTHON_DEPENDENCY_MISSING` when the
configured interpreter cannot import a required Python package. It never
depends on packages installed implicitly in the machine-wide Python.

## DeepSeek Harness integration

Add `dsh-llm-as-verifier` to the profile dependencies, then point the rc.8 base composition rows `verifier`, `verifier-provider`, and `verifier-observer` to the package subpaths listed above. Do not add this package to the rc.8 profile bundle list: rc.8 rejects package-name replacement from a later bundle. The current Web settings and API adapter remains in the DSH fork and is being reduced to a thin external-plugin adapter.

No credentials are stored in this repository. The provider resolves the configured DSH credential reference at call time.

## Quick start

### 1. Build a release artifact

Clone the repository and build the exact source revision you intend to deploy:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

The tested tarball is written to `artifacts/dsh-llm-as-verifier-<version>.tgz`.

### 2. Install it in the target profile

```bash
cd /absolute/path/to/profile
pnpm add --save-exact /absolute/path/to/dsh-llm-as-verifier-<version>.tgz
```

Keep it as a normal profile dependency. Do **not** add it to
`dsh.profile.bundles` when using the rc.8 adapter described below.

### 3. Wire the three Cordis rows

For a composition that does not already own the verifier row IDs, merge the
shipped `cordis.patch.yml`.

For DeepSeek Harness rc.8, edit the base composition adapter instead. Keep the
existing row IDs and replace only their package names with the independent
subpaths:

```yaml
- id: verifier
  name: dsh-llm-as-verifier/core
  config:
    enabled: false
    plugin: null

- id: verifier-provider
  name: dsh-llm-as-verifier/provider

- id: verifier-observer
  name: dsh-llm-as-verifier/observer
```

All three rows should be mounted, but verification should remain disabled until
credentials and capability testing are complete.

### 4. Configure Python, credentials, and the provider

Create a dedicated Python environment for the deployed revision:

```bash
python3 -m venv /opt/dsh-runtime/llm-verifier
/opt/dsh-runtime/llm-verifier/bin/python -m pip install -r requirements.txt
```

Set the following namespaces in the DSH settings file:

```yaml
verifier:
  enabled: true
  plugin: llm-as-a-verifier

verifier-llm-as-verifier:
  pythonExecutable: /opt/dsh-runtime/llm-verifier/bin/python
  baseURL: https://api.deepseek.com
  apiKeyEnv: DEEPSEEK_API_KEY
  transport: auto
  strict: true
  criteria:
    Overall: Is this trajectory correct, complete, and adequately verified?
  capabilityProbe:
    maxTokens: 1024
    retryMaxTokens: 2048
```

Add the referenced secret to the DSH credentials store, not to this repository:

```yaml
DEEPSEEK_API_KEY: "<your key>"
```

Keep the credentials file private. DSH resolves the reference at call time; the
provider settings contain only the credential name.

### 5. Test from the Web UI

1. Open **Settings → Verification**.
2. Confirm that `llm-as-a-verifier` is listed as available.
3. Confirm that the credential and Python executable are configured.
4. Click **Test verifier capability** once.

The capability test makes a real model request. It checks response log
probabilities, score-token extraction, and output-budget behavior, so it can
consume tokens and incur provider charges.

If the test succeeds, keep the core enabled. Enable observer logging only when
you intentionally want local evaluation records.

## Configuration reference

### `verifier` core

| Key | Purpose |
| --- | --- |
| `enabled` | Master switch. Keep `false` until the provider capability test passes. |
| `plugin` | Provider directory ID. Use `llm-as-a-verifier`; use `null` while disabled. |

The core is provider-neutral. Selecting a provider does not automatically enable
observer logging or alter the agent's normal answer path. A session follows the
master switch by default; `/verifier on`, `/verifier off`, and `/verifier default`
change only that session's later dispatches and are restored from its durable
command lifecycle.

### `verifier-llm-as-verifier` provider

| Key | Purpose |
| --- | --- |
| `pythonExecutable` | Absolute path to the managed Python interpreter. |
| `model` | Fixed verifier model. The only accepted value is `deepseek-v4-flash`. |
| `baseURL` | Verifier API root; defaults to the official DeepSeek endpoint. |
| `apiKeyEnv` | Name of the DSH credential reference; defaults to `DEEPSEEK_API_KEY`. |
| `transport` | `auto`, `deepseek-native`, or `openai-compatible`. |
| `criteria` | Named scoring criteria and their natural-language instructions. |
| `strict` | Throw verifier failures instead of returning fail-open metadata. Default `true`. |
| `nEvaluations` | Repeated evaluations used for one score. |
| `pivots` | Pivot count used by multi-candidate selection. |
| `maxWorkers` | Upper bound for concurrent worker-side evaluations. |
| `timeoutMs` | Deadline for one worker request. |
| `capabilityProbe.maxTokens` / `retryMaxTokens` | Initial and one retry output budgets; retry must be larger. |
| `progressTracking.enabled` | Enable intermediate trajectory progress measurements. |
| `confidence` | Score-gap thresholds and the target selection confidence. |
| `adaptive` | Optional staged or top-two escalation policy; default disabled. |
| `budget` | Call, latency, token, and comparison ceilings for verifier-only work. |

Keep concurrency, repeated evaluations, and adaptive stages conservative at
first: all three can multiply API requests and token cost.

### `verifier-observer`

| Key | Purpose |
| --- | --- |
| `evaluationLogging.enabled` | Persist observer evaluation records locally. Default `false`. |
| `evaluationLogging.path` | JSONL output directory. Default `.verifier-runs`. |
| `evaluationLogging.adaptiveShadow.enabled` | Record adaptive-policy shadow results without changing selection. Default `false`. |
| `evaluationLogging.adaptiveShadow.top2GapThreshold` | Shadow escalation gap. Default `0.08`. |

Observer records may contain task or trajectory-derived material. Treat the
output directory as sensitive operational data and apply normal retention rules.

## Troubleshooting

| UI reason | Meaning and next action |
| --- | --- |
| `MISSING_CREDENTIAL` | The configured DSH credential reference is unresolved. Add it to the credential store and retry. |
| `PYTHON_DEPENDENCY_MISSING` | The selected interpreter cannot import `llm_verifier` or a transitive dependency. Reinstall `requirements.txt` into that exact interpreter. |
| `REQUEST_FAILED` | The worker reached a generic local/HTTP failure. Check endpoint reachability, TLS/proxy settings, and sanitized Host logs. |
| `LOGPROBS_UNAVAILABLE` | The endpoint/model did not return usable token log probabilities. Select a compatible model or transport. |
| `NO_SCORE_TOKEN` | The response did not contain a recoverable score marker. Recheck model compatibility and criteria. |
| `OUTPUT_BUDGET_EXHAUSTED` | The model exhausted both configured probe budgets. Raise the bounded probe budgets cautiously. |
| `PROBE_INCONCLUSIVE` | The response was valid but insufficient to prove the required capability. Retry once, then inspect the model/endpoint contract. |

### Safe local checks

These commands construct the client but do not make a model request:

```bash
VERIFIER_PYTHON=/absolute/path/to/managed/bin/python
VERIFIER_PACKAGE_ROOT=/absolute/path/to/dsh-llm-as-verifier

"$VERIFIER_PYTHON" -c 'import llm_verifier, openai; print("python runtime ok")'

env -u PYTHONPATH VERIFIER_BASE_URL=http://127.0.0.1:9 VERIFIER_API_KEY=validation-only \
  "$VERIFIER_PYTHON" -c 'import sys; sys.path.insert(0, sys.argv[1]); import worker; print(type(worker._client()).__name__)' \
  "$VERIFIER_PACKAGE_ROOT"
```

The second check should print `_VerifierClient`. Do not print the actual API key
or copy credential files into bug reports.

If the UI remains stale after a Host upgrade, hard-refresh the page before
changing credentials or reinstalling the plugin.

## Operational guidance

- Test a new package and Python runtime in a copied profile or staging directory.
- Keep verification disabled while changing credentials or endpoints.
- Store secrets only in the DSH credential store and restrict file permissions.
- Treat the capability button as a real, billable external request.
- Settings may apply live when the Host exposes live settings revisions; verify
  the active revision before assuming a restart is required.
- Package-code upgrades normally require an approved maintenance reload; do not
  replace a live profile dependency underneath an active process.
- Enable observer records only with an explicit retention and privacy policy.

## Development and release checks

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

Before deployment, also validate the actual tarball rather than only the source
tree:

1. Unpack the generated `.tgz` into an empty temporary directory.
2. Confirm `requirements.txt`, `worker.py`, `LICENSE`, and `NOTICE` are present.
3. Import the `core`, `provider`, and `observer` Node entrypoints.
4. Run the safe Python checks above against the unpacked package.
5. Install the tarball physically in a staged profile and inspect composition.

The workspace auto-updater performs these package and Python runtime gates and
fails closed before deployment when the managed interpreter is missing or stale.
