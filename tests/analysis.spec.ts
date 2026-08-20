import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const roots: string[] = []

function record(
  id: string,
  winner: number,
  gap: number,
  outcomes: ReadonlyArray<boolean | undefined>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    record_id: id,
    run_id: `run-${id}`,
    task_id: `task-${id}`,
    timestamp: '2026-08-19T00:00:00.000Z',
    task_metadata: { task_type: 'coding', source: 'fixture', candidate_count: outcomes.length },
    verifier: { backend: 'fixture', model: 'deepseek-v4-flash' },
    selection: { ranking: outcomes.map((_, index) => index), winner_index: winner, top2_gap: gap },
    cost: {
      comparisons: 2,
      verifier_calls: 3,
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 40,
      reasoning_tokens: 30,
      latency_ms: 10,
    },
    outcome: { status: 'unknown' },
    candidates: outcomes.map((success, index) => ({
      index,
      trajectory_reference_sha256: `${index}`.repeat(64),
      outcome: success === undefined
        ? { status: 'unknown' }
        : { status: 'graded', source: 'fixture', success, score: success ? 1 : 0 },
    })),
    ...overrides,
  }
}

async function fixture(): Promise<{ root: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-analysis-'))
  roots.push(root)
  const log = join(root, 'runs.jsonl')
  const records = [
    record('one', 1, 0.02, [false, true], {
      adaptive_shadow: { policy: 'top-two', threshold: 0.05, top2_gap: 0.02, would_trigger: true },
      adaptive_actual: {
        strategy: 'top-two', stage1_winner_index: 0, stage1_gap: 0.02,
        escalation_triggered: true, extra_comparisons: 2,
        final_winner_changed: true, final_ranking_changed: true,
      },
      cost: {
        comparisons: 4, verifier_calls: 5, input_tokens: 160, cached_input_tokens: 30,
        output_tokens: 70, reasoning_tokens: 50, latency_ms: 20,
        escalation: {
          comparisons: 2, verifier_calls: 2, input_tokens: 60, cached_input_tokens: 10,
          output_tokens: 30, reasoning_tokens: 20, latency_ms: 10,
        },
      },
      trajectory_content: 'Authorization: Bearer should-never-export',
    }),
    record('two', 0, 0.09, [false, true]),
    record('three', 0, 0.04, [undefined, undefined], {
      task_metadata: {
        task_type: 'unknown', source: 'fixture', candidate_count: 2,
        raw_trajectory: 'nested private content',
      },
    }),
    record('four', 0, 0.11, [true, false]),
  ]
  await writeFile(log, `${records.map(value => JSON.stringify(value)).join('\n')}\n`)
  return { root, log }
}

async function runPython(script: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execute('python3', [script, ...args], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
  })
  return stdout
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('offline verifier evaluation tools', () => {
  it('excludes unknown outcomes and calculates regret, paired uplift, and gap calibration', async () => {
    const { log } = await fixture()
    const stdout = await runPython('scripts/analyze-verifier-runs.py', [log, '--thresholds', '0.05', '--json'])
    const result = JSON.parse(stdout) as {
      analysis: {
        runs: number
        runs_with_ground_truth: number
        verifier_winner_success: { sample_size: number; rate: number }
        paired_selection_uplift: { sample_size: number; absolute_percentage_points: number }
        regret: { sample_size: number; mean: number; median: number; max: number; zero_regret_rate: number }
        gap_buckets: Array<{ bucket: string; runs_with_outcome: number; winner_error_rate: number | null }>
        shadow_policies: Array<{
          would_escalate: number
          inside_escalated_set: { runs_with_outcome: number; errors: number }
          outside_escalated_set: { runs_with_outcome: number; errors: number }
        }>
        actual_adaptive: { corrected_winners: number; extra_reasoning_tokens_per_correction: number }
      }
    }
    const analysis = result.analysis
    expect(analysis.runs).toBe(4)
    expect(analysis.runs_with_ground_truth).toBe(3)
    expect(analysis.verifier_winner_success).toMatchObject({ sample_size: 3, rate: 2 / 3 })
    expect(analysis.paired_selection_uplift.sample_size).toBe(3)
    expect(analysis.paired_selection_uplift.absolute_percentage_points).toBeCloseTo(100 / 3)
    expect(analysis.regret).toMatchObject({ sample_size: 3, median: 0, max: 1 })
    expect(analysis.regret.mean).toBeCloseTo(1 / 3)
    expect(analysis.regret.zero_regret_rate).toBeCloseTo(2 / 3)
    expect(analysis.gap_buckets.find(bucket => bucket.bucket === '0.08-0.1'))
      .toMatchObject({ runs_with_outcome: 1, winner_error_rate: 1 })
    expect(analysis.shadow_policies[0]).toMatchObject({
      would_escalate: 2,
      inside_escalated_set: { runs_with_outcome: 1, errors: 0 },
      outside_escalated_set: { runs_with_outcome: 2, errors: 1 },
    })
    expect(analysis.actual_adaptive).toMatchObject({
      corrected_winners: 1,
      extra_reasoning_tokens_per_correction: 20,
    })
  })

  it('evaluates shadow trigger coverage without API credentials or network calls', async () => {
    const { log } = await fixture()
    const stdout = await runPython('scripts/evaluate-verifier-policy.py', [
      log, '--threshold', '0.05', '--json',
    ])
    const result = JSON.parse(stdout) as { runs: number; policies: Array<{ would_escalate: number; note: string }> }
    expect(result.runs).toBe(4)
    const policy = result.policies.at(0)
    if (policy === undefined) throw new Error('expected one shadow policy')
    expect(result.policies).toHaveLength(1)
    expect(policy.would_escalate).toBe(2)
    expect(policy.note).toContain('does not predict')
  })

  it('exports only the schema-v1 metadata and hashed trajectory references', async () => {
    const { root, log } = await fixture()
    const output = join(root, 'export.jsonl')
    await runPython('scripts/export-verifier-dataset.py', [log, '--output', output])
    const exported = await readFile(output, 'utf8')
    expect(exported).toContain('trajectory_reference_sha256')
    expect(exported).not.toContain('trajectory_content')
    expect(exported).not.toContain('raw_trajectory')
    expect(exported).not.toContain('nested private content')
    expect(exported).not.toContain('Authorization')
  })
})
