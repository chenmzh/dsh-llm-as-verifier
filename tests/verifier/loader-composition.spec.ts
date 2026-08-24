import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import VerifierRuntime from 'dsh-llm-as-verifier/core'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('verifier real Loader composition', () => {
  it('discovers /verifier and switches only the receiving session', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-verifier-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: 'dsh-llm-as-verifier/core'",
      '  config:',
      '    enabled: true',
      '    plugin: fake',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['dsh-llm-as-verifier/core', VerifierRuntime],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    context.verifier.register({ id: 'fake' })

    const first = Session.create(SessionId('loader-verifier-first'))
    const second = Session.create(SessionId('loader-verifier-second'))
    const agent = { session: first } as unknown as Agent
    expect(context.commands.list(agent)).toContainEqual({
      name: 'verifier',
      description: 'Show or switch verifier use for this session',
      input: { hint: '[on|off|default|status]' },
    })

    const execution = await context.commands.execute(
      agent,
      '/verifier off',
      [],
      new AbortController().signal,
    )
    if (execution === undefined) throw new Error('Loader composition did not resolve /verifier')
    expect(execution.result).toEqual({
      kind: 'success',
      text: 'Verifier off for this session (mode off; plugin fake).',
    })
    expect(context.verifier.enabledFor(first)).toBe(false)
    expect(context.verifier.enabledFor(second)).toBe(true)
    expect(first.events.map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(first.events[0]).toMatchObject({ type: 'command/run', data: { name: 'verifier', args: ' off' } })
    expect(first.deriveMessages()).toEqual([])
  })
})
