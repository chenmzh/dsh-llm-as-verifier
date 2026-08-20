# dsh-llm-as-verifier

Independent LLM-as-verifier bundle for DeepSeek Harness. One installation exposes three Cordis plugins:

- `dsh-llm-as-verifier/core`: provider-neutral verifier runtime and Best-of-N helpers.
- `dsh-llm-as-verifier/provider`: DeepSeek/OpenAI-compatible Python worker provider.
- `dsh-llm-as-verifier/observer`: optional session lifecycle evaluation and JSONL records.

The bundled `cordis.patch.yml` replaces the three rc.8 base verifier rows with this package's standalone entries. All three stay disabled by default. Verification starts only after the `verifier` settings namespace enables it and selects a provider.

## Development

Requires Node.js 22.19 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm pack:check
```

## DeepSeek Harness integration

Add `dsh-llm-as-verifier` to the profile dependencies. DSH discovers the bundle patch through the package's `dsh.bundle.patch` metadata. The current rc.8 Web settings and API integration remains documented under `integration/deepseek-harness/` while it is being reduced to a thin external-plugin adapter.

No credentials are stored in this repository. The provider resolves the configured DSH credential reference at call time.
