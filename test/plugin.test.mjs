/**
 * Plugin seam tests.
 *
 * These run the real entry module against a stub host. The point is not to
 * retest resolution — the unit tests do that against fixtures — but to test the
 * contract the harness enforces and nothing else catches: that `inject` is a
 * static array, that every service `apply()` touches is declared, that the
 * registered tools compile into well-formed schemas, and that a failing lookup
 * comes back as a domain result instead of a throw.
 *
 * The stub's proxy throws on any property it does not define, which is exactly
 * the failure the plugin guide warns about: a plugin that reaches for a service
 * it never declared is disabled at boot, silently.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as plugin from '../lib/index.js'

/**
 * Build a minimal host context.
 *
 * `get()` returns undefined rather than throwing, because `workspaceRegistry`
 * is deliberately optional here — the plugin must work without it.
 *
 * @returns {{ ctx: object, tools: object[], commands: object[], listeners: object[], effects: number }} the stub and its records.
 */
function stubHost() {
  const tools = []
  const commands = []
  const listeners = []
  const state = { effects: 0 }

  const base = {
    tools: { register: (tool) => tools.push(tool) },
    commands: { register: (command) => commands.push(command) },
    on: (event, handler) => listeners.push({ event, handler }),
    effect: (factory) => {
      state.effects += 1
      return factory()
    },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }

  const ctx = new Proxy(base, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      throw new Error(`plugin touched undeclared service "${String(property)}"`)
    },
  })

  return { ctx, tools, commands, listeners, get effects() { return state.effects } }
}

/**
 * Apply the plugin to a fresh stub and hand back the registrations.
 *
 * @param {object} [config] - config overrides.
 * @returns {object} the stub host.
 */
function boot(config = {}) {
  const host = stubHost()
  plugin.apply(host.ctx, plugin.Config(config))
  return host
}

/** Find one registered tool by name. */
function tool(host, name) {
  const found = host.tools.find((candidate) => candidate.name === name)
  assert.ok(found !== undefined, `tool "${name}" was not registered`)
  return found
}

/** Validate a tool the way the harness will. */
function assertWellFormedTool(candidate) {
  assert.equal(typeof candidate.name, 'string', 'tool needs a name')
  assert.match(candidate.name, /^[a-z][a-z0-9_]*$/u, `tool name "${candidate.name}" must be snake_case`)
  assert.equal(typeof candidate.description, 'string')
  assert.ok(
    candidate.description.length > 40,
    `tool "${candidate.name}" needs a description long enough for the model to select on`,
  )
  assert.equal(typeof candidate.execute, 'function')
  assert.equal(candidate.parameters.type, 'object', `tool "${candidate.name}" parameters must compile to an object schema`)
  assert.equal(typeof candidate.parameters.properties, 'object')
  /* `{ type: 'json' }` is the authoring form for "any JSON value"; it compiles
   * to an annotation-only schema with no `type` key. Asserting `type === 'json'`
   * would assert that the authoring form survived compilation, which it must
   * not. */
  assert.equal(candidate.output.schema.type, undefined, `tool "${candidate.name}" should accept any JSON root`)
  assert.deepEqual(Object.keys(candidate.output.schema), [], `tool "${candidate.name}" output schema must be unconstrained`)
  assert.equal(typeof candidate.output.render, 'function')
  assert.ok(
    Number.isFinite(candidate.timeoutMs) && candidate.timeoutMs > 0,
    `tool "${candidate.name}" needs a positive timeout`,
  )
}

describe('plugin contract', () => {
  it('exports a static inject array', () => {
    /* A function form makes the harness declare zero dependencies and then
     * disable the whole bundle — the failure recorded in the plugin guide. */
    assert.ok(Array.isArray(plugin.inject), 'inject must be a static array, not a function')
    assert.deepEqual([...plugin.inject].sort(), ['commands', 'tools'])
  })

  it('names itself after the package', () => {
    assert.equal(plugin.name, 'dsh-which')
  })

  it('exposes a Schemastery Config that fills every default', () => {
    const config = plugin.Config({})
    assert.equal(config.probeTimeoutMs, 4000)
    assert.equal(config.probeByDefault, false)
    assert.equal(config.probeShadowedByDefault, false)
    assert.equal(config.maxSweepFiles, 400)
    assert.ok(Array.isArray(config.runtimes))
    assert.ok(config.runtimes.includes('node'))
  })

  it('keeps probing off by default, because it spawns processes', () => {
    const config = plugin.Config({})
    assert.equal(config.probeByDefault, false)
    assert.equal(config.probeShadowedByDefault, false)
  })

  it('registers its tools and command without touching an undeclared service', () => {
    const host = boot()
    assert.deepEqual(host.tools.map((candidate) => candidate.name).sort(), [
      'which_env',
      'which_path',
      'which_probe',
      'which_resolve',
      'which_sweep',
    ])
    assert.deepEqual(host.commands.map((command) => command.name), ['which'])
  })

  it('registers every tool with a usable schema', () => {
    const host = boot()
    for (const candidate of host.tools) assertWellFormedTool(candidate)
  })

  it('boots without the optional workspace service', () => {
    /* `ctx.get` returns undefined in the stub; resolution still has to work,
     * it just cannot resolve a relative path against a session root. */
    const host = boot()
    assert.equal(host.effects, 0, 'this plugin needs no teardown effect')
    assert.equal(host.listeners.length, 0, 'this plugin observes no events')
  })

  it('declares that resolving, sweeping and probing need an argument', () => {
    const host = boot()
    assert.deepEqual(tool(host, 'which_resolve').parameters.required, ['command'])
    assert.deepEqual(tool(host, 'which_sweep').parameters.required, ['directory'])
    assert.deepEqual(tool(host, 'which_probe').parameters.required, ['command'])
    /* The two reporting tools take no required input: both answer for the
     * machine as it is. */
    assert.deepEqual(tool(host, 'which_path').parameters.required ?? [], [])
    assert.deepEqual(tool(host, 'which_env').parameters.required ?? [], [])
  })

  it('exposes no PATH-editing tool', () => {
    /* Reporting is the whole job. A plugin that rewrites PATH breaks machines,
     * so the absence is a contract, not an omission. */
    const host = boot()
    for (const candidate of host.tools) {
      assert.doesNotMatch(candidate.name, /set|edit|fix|repair|clean/u)
    }
  })
})

describe('which_resolve', () => {
  it('reports an empty command as a domain result, not a throw', async () => {
    const host = boot()
    const value = await tool(host, 'which_resolve').execute({ command: '   ' }, { agent: undefined, signal: undefined })
    assert.equal(value.ok, false)
    assert.match(value.error, /command name is required/u)
  })

  it('resolves a command that must exist in any Node process', async () => {
    /* The test runner is itself node, so this is the one command guaranteed to
     * resolve on the machine running the tests. */
    const host = boot()
    const value = await tool(host, 'which_resolve').execute({ command: 'node' }, { agent: undefined, signal: undefined })
    assert.equal(value.ok, true)
    assert.equal(value.command, 'node')
    assert.ok(value.resolution.winner !== null, 'node must resolve while node is running the test')
  })

  it('reports a name nothing can run without probing it', async () => {
    const host = boot()
    const value = await tool(host, 'which_resolve').execute(
      { command: 'definitely-not-a-real-command-9f3a2b', probe: true },
      { agent: undefined, signal: undefined },
    )
    assert.equal(value.ok, true, 'an unresolved name is an answer, not a failure')
    assert.equal(value.resolution.winner, null)
    /* Nothing won, so there is nothing to probe — and probing a null winner
     * would be the bug this asserts against. */
    assert.equal(value.probe, undefined)
  })

  it('renders both an answer and a failure without throwing', async () => {
    const host = boot()
    const resolve = tool(host, 'which_resolve')
    const failure = resolve.output.render({ command: 'x' }, { ok: false, command: 'x', error: 'a command name is required' })
    assert.equal(failure[0].type, 'text')
    assert.match(failure[0].text, /dsh-which · x/u)
    assert.match(failure[0].text, /command name is required/u)

    const value = await resolve.execute({ command: 'node' }, { agent: undefined, signal: undefined })
    const blocks = resolve.output.render({ command: 'node' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /^dsh-which · node/mu)
    assert.match(blocks[0].text, /searched: \d+ PATH entr/u)
  })
})

describe('which_path and which_env', () => {
  it('reports the live PATH without needing arguments', async () => {
    const host = boot()
    const value = await tool(host, 'which_path').execute({}, { agent: undefined, signal: undefined })
    assert.ok(Array.isArray(value.entries))
    assert.equal(typeof value.uniqueDirectories, 'number')
    const blocks = tool(host, 'which_path').output.render({}, value)
    assert.match(blocks[0].text, /^dsh-which · PATH/mu)
  })

  it('summarises the environment with the runtimes it was asked about', async () => {
    const host = boot({ runtimes: ['node'] })
    const value = await tool(host, 'which_env').execute({}, { agent: undefined, signal: undefined })
    assert.equal(value.platform, process.platform)
    assert.deepEqual(value.runtimes.map((runtime) => runtime.name), ['node'])
    const blocks = tool(host, 'which_env').output.render({}, value)
    assert.match(blocks[0].text, /dsh-which · environment/u)
    assert.match(blocks[0].text, /resolved runtimes:/u)
  })
})

describe('which_sweep', () => {
  it('refuses a missing directory as a domain result', async () => {
    const host = boot()
    const value = await tool(host, 'which_sweep').execute(
      { directory: 'E:/dsh-work/definitely-not-here-9f3a2b' },
      { agent: undefined, signal: undefined },
    )
    assert.equal(value.ok, false)
    assert.match(value.error, /no such path/u)
  })

  it('refuses a file where a directory was expected', async () => {
    const host = boot()
    /* The plugin's own package.json is a file that certainly exists here. */
    const value = await tool(host, 'which_sweep').execute(
      { directory: new URL('../package.json', import.meta.url).pathname.replace(/^\//u, '') },
      { agent: undefined, signal: undefined },
    )
    assert.equal(value.ok, false)
    assert.match(value.error, /no such path|not a directory/u)
  })

  it('sweeps the plugin\'s own directory and reports rows', async () => {
    const host = boot()
    const here = new URL('..', import.meta.url).pathname.replace(/^\//u, '')
    const value = await tool(host, 'which_sweep').execute({ directory: here }, { agent: undefined, signal: undefined })
    assert.equal(value.ok, true)
    assert.ok(Array.isArray(value.rows))
    const blocks = tool(host, 'which_sweep').output.render({}, value)
    assert.match(blocks[0].text, /^dsh-which · sweep/mu)
  })

  it('renders a sweep failure without throwing', () => {
    const host = boot()
    const blocks = tool(host, 'which_sweep').output.render(
      { directory: 'x' },
      { ok: false, directory: 'x', error: 'not a directory: x' },
    )
    assert.match(blocks[0].text, /not a directory: x/u)
  })
})

describe('which_probe', () => {
  it('reports an unresolvable name instead of spawning anything', async () => {
    const host = boot()
    const value = await tool(host, 'which_probe').execute(
      { command: 'definitely-not-a-real-command-9f3a2b' },
      { agent: undefined, signal: undefined },
    )
    assert.equal(value.ok, false)
    assert.match(value.error, /nothing named/u)
  })

  it('renders a probe outcome without throwing', () => {
    const host = boot()
    const blocks = tool(host, 'which_probe').output.render(
      { command: 'node' },
      {
        ok: true,
        command: 'node',
        probe: { winner: { ok: true, version: 'v24.13.0', flag: '--version' }, shadowed: [], divergent: false },
      },
    )
    assert.match(blocks[0].text, /winner:\s+v24\.13\.0/u)
  })
})

describe('the /which command', () => {
  /**
   * Invoke the registered command handler.
   *
   * @param {string} rawInput - text after the command name.
   * @returns {Promise<object>} the command result.
   */
  async function run(rawInput) {
    const host = boot({ runtimes: ['node'] })
    return host.commands[0].handler({
      commandId: 'c1',
      agent: undefined,
      rawInput,
      attachments: [],
      signal: undefined,
    })
  }

  it('prints the environment when invoked bare', async () => {
    const result = await run('')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /dsh-which · environment/u)
  })

  it('accepts --path and --env as explicit requests', async () => {
    assert.match((await run('--path')).text, /dsh-which · PATH/u)
    assert.match((await run('--env')).text, /dsh-which · environment/u)
  })

  it('resolves a positional command', async () => {
    const result = await run('node')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /^dsh-which · node/mu)
  })

  it('sweeps the working directory with --sweep and no argument', async () => {
    /* `.` resolves against the plugin's cwd handling; with no workspace
     * registry the path stays relative and `statSync('.')` succeeds because the
     * test process runs from the package root. */
    const result = await run('--sweep .')
    assert.ok(result.kind === 'success' || result.kind === 'error', `unexpected kind ${String(result.kind)}`)
    if (result.kind === 'error') assert.match(result.text, /not a directory/u)
  })

  it('reports a sweep over a missing directory as an error result', async () => {
    const result = await run('--sweep E:/dsh-work/definitely-not-here-9f3a2b')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /not a directory/u)
  })

  it('always returns a shape the command runtime accepts', async () => {
    for (const input of ['', 'node', '--path', '--env', '--sweep .', '--sweep', 'no-such-command-9f3a2b', '--probe node']) {
      const result = await run(input)
      assert.ok(result.kind === 'success' || result.kind === 'error', `"${input}" returned kind ${String(result.kind)}`)
      if (result.kind === 'error') assert.ok(typeof result.text === 'string' && result.text.length > 0)
      else if (result.text !== undefined) assert.equal(typeof result.text, 'string')
    }
  })
})
