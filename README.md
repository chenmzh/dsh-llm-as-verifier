# dsh-llm-as-verifier

Independent LLM-as-verifier runtime package for DeepSeek Harness. One installation exposes three Cordis plugins:

- `dsh-llm-as-verifier/core`: provider-neutral verifier runtime and Best-of-N helpers.
- `dsh-llm-as-verifier/provider`: DeepSeek/OpenAI-compatible Python worker provider.
- `dsh-llm-as-verifier/observer`: optional session lifecycle evaluation and JSONL records.

The package keeps a `cordis.patch.yml` composition fragment for clean compositions. DeepSeek Harness rc.8 already owns the three verifier row IDs and does not permit later bundles to change their package names, so rc.8 integration must replace those names in the base composition adapter. All three stay disabled by default. Verification starts only after the `verifier` settings namespace enables it and selects a provider.

## Development

Requires Node.js 22.19 or newer and pnpm 11.

```bash
pnpm install
pnpm check
pnpm pack:check
```

## DeepSeek Harness integration

Add `dsh-llm-as-verifier` to the profile dependencies, then point the rc.8 base composition rows `verifier`, `verifier-provider`, and `verifier-observer` to the package subpaths listed above. Do not add this package to the rc.8 profile bundle list: rc.8 rejects package-name replacement from a later bundle. The current Web settings and API adapter remains in the DSH fork and is being reduced to a thin external-plugin adapter.

No credentials are stored in this repository. The provider resolves the configured DSH credential reference at call time.
