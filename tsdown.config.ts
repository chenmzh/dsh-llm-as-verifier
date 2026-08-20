import type { UserConfig } from 'tsdown'

const external = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-timeout',
  '@deepseek-ai/schemastery',
] as const

export default {
  entry: {
    core: 'src/verifier/index.ts',
    'core-invariant': 'src/verifier/invariant.ts',
    provider: 'src/provider/index.ts',
    'provider-invariant': 'src/provider/invariant.ts',
    observer: 'src/observer/index.ts',
    'observer-invariant': 'src/observer/invariant.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: { neverBundle: [...external] },
} satisfies UserConfig
