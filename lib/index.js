/**
 * dsh-which — what actually runs when a command is typed.
 *
 * The harness runs commands through a shell, and a shell answers "what does
 * `node` mean" with a rule that is longer than people remember: PATH order,
 * then PATHEXT on Windows or the executable bit elsewhere, with shell builtins
 * short-circuiting the whole thing. Every one of those rules can produce a
 * surprise, and every surprise looks the same from the outside — a command
 * runs, and it is not the one you meant.
 *
 * The failures this exists to name, all of which are silent:
 *
 * - A tool is installed twice, and the older copy is earlier on PATH. The
 *   version you see in your terminal is not the version the agent runs.
 * - An installer prepended itself to PATH on every upgrade, so one directory
 *   now appears three times and editing "the" entry leaves two behind.
 * - An uninstalled toolchain left a dead PATH entry. Shells skip those without
 *   a word, so the hole only surfaces when the command that lived there fails.
 * - A PATH entry contains a literal `%USERPROFILE%` that nothing ever expands,
 *   so it can never resolve.
 * - On Windows, a `.cmd` shim sits in front of a real binary, or a `.ps1`
 *   exists that `cmd` will never run — same name, different behaviour per
 *   shell.
 * - A file exists, has the right name, and is not executable. `ls` shows it;
 *   the shell walks past it to a later PATH entry, or fails.
 *
 * Each of those is a fact about the machine, and none of them is visible from
 * a plain `which`. This plugin reports the resolution *and* what it shadowed,
 * the shape of PATH itself, and — on request — what each copy reports as its
 * version.
 *
 * ## Design commitments
 *
 * 1. **Resolution is reimplemented, not shelled out to `which`.** Shelling out
 *    would inherit the very rules under investigation, and `which` does not
 *    exist on Windows. The rules live in `lib/resolve.js` as pure functions
 *    over an injected filesystem, so they can be tested against fixtures.
 * 2. **Shadowed copies are first-class output.** "What runs" is one line; "what
 *    else answers to this name" is the diagnosis. A report that omits the
 *    shadowed copies cannot explain a version mismatch.
 * 3. **Probing runs only what resolution already chose.** No arbitrary command
 *    execution, only a known version flag, a short timeout, and a bounded
 *    amount of output.
 * 4. **Nothing is changed.** There is no PATH-editing tool here. Reporting is
 *    the whole job; a plugin that silently rewrites PATH is a plugin that
 *    breaks a machine.
 *
 * @module dsh-which
 */

import { join as joinPath, resolve as resolvePath } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import {
  renderEnv,
  renderPath,
  renderProbe,
  renderProblem,
  renderResolve,
  renderSweep,
} from './format.js'
import {
  RUNTIME_CANDIDATES,
  detectShell,
  listDirectory,
  readPath,
  readPathExt,
  statFile,
} from './host.js'
import { analyzePath, foldCase } from './pathlist.js'
import { probeResolution } from './probe.js'
import { isPathCommand, resolveCommand, shadowGroups } from './resolve.js'

/** Plugin name, as the profile's patch file refers to it. */
export const name = 'dsh-which'

/**
 * Services this plugin needs.
 *
 * A static array, not a function: the harness disables a whole bundle whose
 * `inject` is a function, and the failure is silent. Everything else this
 * plugin wants (`workspaceRegistry`) is optional and reached through `ctx.get`.
 */
export const inject = ['tools', 'commands']

/**
 * Per-profile configuration.
 *
 * Every knob that could reasonably differ between machines lives here rather
 * than in a constant, so tuning a profile never means editing code.
 */
export const Config = Schema.object({
  probeTimeoutMs: Schema.number()
    .description('How long a version probe may take before it is abandoned.')
    .default(4000),
  probeByDefault: Schema.boolean()
    .description('Run a version probe on every resolve, without asking. Slower, but the report explains more.')
    .default(false),
  probeShadowedByDefault: Schema.boolean()
    .description('Probe every shadowed copy too, not just the winner. Multiplies the process spawns.')
    .default(false),
  maxSweepFiles: Schema.number()
    .description('Files examined in one sweep of a directory, so a huge directory cannot stall a session.')
    .default(400),
  runtimes: Schema.array(Schema.string())
    .description('Commands the environment report resolves.')
    .default([...RUNTIME_CANDIDATES]),
})

/**
 * Resolve one command against the live machine.
 *
 * @param {string} command - command name or path.
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, platform?: string, pathExt?: string[] }} [options] - environment inputs.
 * @returns {object} the resolution.
 */
export function resolveOnHost(command, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const path = readPath(env, { platform })
  const pathExt = options.pathExt ?? readPathExt(env, { platform })

  return resolveCommand(command, {
    entries: path.entries,
    pathExt,
    platform,
    statFile: (candidate) => statFile(qualify(candidate, options.cwd)),
  })
}

/**
 * Make a relative candidate absolute against the working directory.
 *
 * @param {string} candidate - possibly relative path.
 * @param {string} [cwd] - working directory.
 * @returns {string} absolute path.
 */
function qualify(candidate, cwd) {
  if (cwd === undefined) return candidate
  if (/^([a-zA-Z]:[\\/]|[\\/])/u.test(candidate)) return candidate
  return resolvePath(cwd, candidate)
}

/**
 * Analyse the live PATH.
 *
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [options] - environment inputs.
 * @returns {object} the analysis.
 */
export function analyzeHostPath(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  const raw = key === undefined ? '' : env[key] ?? ''
  return analyzePath(raw, { env, platform, exists: (path) => statFile(path) !== undefined })
}

/**
 * Build the environment report.
 *
 * @param {object} config - resolved plugin config.
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, platform?: string }} [options] - environment inputs.
 * @returns {object} the report.
 */
export function buildEnvReport(config, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const shell = detectShell(env, { platform })
  const pathAnalysis = analyzeHostPath({ env, platform })

  const runtimes = []
  for (const runtime of config.runtimes ?? []) {
    const resolution = resolveOnHost(runtime, { cwd: options.cwd, env, platform })
    const groups = shadowGroups(resolution)
    runtimes.push({
      name: runtime,
      winner: resolution.winner?.path,
      shadowCount: groups.reduce((total, group) => total + group.entries.length, 0),
    })
  }

  return {
    platform,
    arch: process.arch,
    node: process.version,
    shell: shell.name,
    shellPath: shell.path,
    shellKind: shell.kind,
    cwd: options.cwd ?? process.cwd(),
    path: pathAnalysis,
    ...(platform === 'win32' ? { pathext: readPathExt(env, { platform }) } : {}),
    runtimes,
  }
}

/**
 * Sweep a directory: for each file that looks like a command, where does the
 * name resolve to?
 *
 * The question this answers is the one that comes up whenever a repository
 * ships scripts next to a global install: `./build` and `build` are different
 * programs, and nothing warns you.
 *
 * @param {string} directory - directory to sweep.
 * @param {object} config - resolved plugin config.
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, platform?: string }} [options] - environment inputs.
 * @returns {{ directory: string, rows: object[] }} the sweep.
 */
export function sweepDirectory(directory, config, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const absolute = qualify(directory, options.cwd)
  const names = listDirectory(absolute).slice(0, config.maxSweepFiles ?? 400)
  const rows = []

  for (const entry of names) {
    if (entry.startsWith('.')) continue
    const facts = statFile(joinPath(absolute, entry))
    if (facts === undefined || facts.directory) continue
    /* Only files that carry an extension Windows would run, or that are
     * executable elsewhere, look like commands at all. */
    const looksRunnable = platform === 'win32'
      ? /\.(exe|com|cmd|bat|ps1)$/iu.test(entry)
      : facts.executable
    if (!looksRunnable) continue

    const resolution = resolveOnHost(entry, { cwd: options.cwd, env, platform })
    const here = joinPath(absolute, entry)
    const winnerPath = resolution.winner?.path
    /* The sweep answers one question per file: if this directory is on PATH,
     * does its own copy run, or does something earlier win? A row is marked
     * only when the answer is "something earlier" — which is why the test is
     * against this directory, not merely "a winner exists". Comparing folded
     * paths keeps Windows, where case does not distinguish files, honest. */
    const resolvesElsewhere = winnerPath !== undefined
      && foldCase(winnerPath, platform) !== foldCase(here, platform)
    rows.push({
      name: entry,
      winner: winnerPath,
      shadowedBy: resolvesElsewhere ? winnerPath : undefined,
      note: resolution.note,
    })
  }

  return { directory: absolute, rows }
}

/**
 * Run one version probe with the plugin's timeout.
 *
 * @param {object} resolution - a resolution.
 * @param {object} config - resolved plugin config.
 * @param {{ includeShadowed?: boolean, signal?: AbortSignal, platform?: string }} [options] - probe options.
 * @returns {Promise<object>} the probe outcome.
 */
function probeWith(resolution, config, options = {}) {
  return probeResolution(resolution, {
    includeShadowed: options.includeShadowed ?? config.probeShadowedByDefault === true,
    timeoutMs: config.probeTimeoutMs,
    signal: options.signal,
    platform: options.platform,
  })
}

/**
 * Read the session's working directory, when the harness exposes one.
 *
 * Optional service: a deployment without a workspace registry still resolves
 * commands, it just cannot resolve a relative path against the session's root.
 *
 * @param {object} ctx - plugin context.
 * @param {object} exec - tool execution.
 * @returns {string | undefined} the working directory.
 */
function workspaceRootFor(ctx, exec) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (registry === undefined) return undefined
    const session = exec?.agent?.session
    if (session !== undefined && typeof registry.forSession === 'function') {
      const root = registry.forSession(session)
      if (typeof root === 'string' && root !== '') return root
    }
    if (typeof registry.current === 'function') {
      const current = registry.current()
      if (typeof current === 'string' && current !== '') return current
    }
    if (typeof registry.defaultRoot === 'function') {
      const root = registry.defaultRoot()
      if (typeof root === 'string' && root !== '') return root
    }
  } catch {
    /* An optional service that throws is the same as one that is absent. */
  }
  return undefined
}

/**
 * Register the tools and the command.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved config.
 */
export function apply(ctx, config) {
  const cwdFor = (exec) => workspaceRootFor(ctx, exec)

  ctx.tools.register(
    defineTool({
      name: 'which_resolve',
      description:
        'Resolve a command name the way a shell would and report what actually runs: which PATH entry wins, what kind of file it is, and every other copy of the same name that is being shadowed. Use it when a command behaves differently than expected, when a version disagrees between a terminal and the agent, or before telling the user a tool is missing. Pass probe: true to also run each copy with a version flag and compare what they report.',
      parameters: {
        command: { type: 'string', required: true, description: 'Command name, or a path to a specific file.' },
        probe: { type: 'boolean', description: 'Also run the winner (and with probeShadowed, every copy) with a version flag.' },
        probeShadowed: { type: 'boolean', description: 'Probe shadowed copies too, so versions can be compared.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderResolve(value.resolution, { probe: value.probe }) }]
            : [{ type: 'text', text: renderProblem(value.command ?? 'resolve', value.error) }],
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (command === '') return { ok: false, command, error: 'a command name is required' }
        const platform = process.platform
        const resolution = resolveOnHost(command, { cwd: cwdFor(exec), platform })
        const wantProbe = args.probe === true || config.probeByDefault === true
        const probe = wantProbe && resolution.winner !== null
          ? await probeWith(resolution, config, { includeShadowed: args.probeShadowed, signal: exec.signal, platform })
          : undefined
        return { ok: true, command, resolution, ...(probe === undefined ? {} : { probe }) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'which_path',
      description:
        'Report the shape of PATH itself: every entry in resolution order, with duplicates, entries whose directory no longer exists, and entries containing an unexpanded %VAR% or $VAR that can therefore never resolve. Use it when a tool is installed but not found, when an install seems to have had no effect, or when two installs of the same toolchain disagree about which is active.',
      parameters: {
        showNoise: { type: 'boolean', description: 'Include the standard /usr/bin and /bin entries, which are omitted by default as uninformative.' },
        limit: { type: 'number', description: 'Maximum entries listed. Defaults to 40.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderPath(value, { showNoise: _args.showNoise, limit: _args.limit }) }],
      },
      timeoutMs: 30_000,
      execute(args) {
        return analyzeHostPath({ platform: process.platform })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'which_env',
      description:
        'Summarise the command environment: platform, shell, working directory, PATH findings, PATHEXT on Windows, and where each common runtime (node, npm, python, git, ...) resolves from — plus which of them exist in more than one place on PATH. Use it at the start of a session that will run build or install commands, or when a command works for the user but not for the agent.',
      parameters: {
        limit: { type: 'number', description: 'Maximum runtimes listed. Defaults to 30.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: renderEnv(value, { limit: _args.limit }) }],
      },
      timeoutMs: 30_000,
      execute(_args, exec) {
        return buildEnvReport(config, { cwd: cwdFor(exec), platform: process.platform })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'which_sweep',
      description:
        'Sweep a directory of scripts and report, for each name that looks like a command, whether the copy in that directory is the one that would run. Use it before invoking a repository script by bare name, or when a script works when called by path but not by name.',
      parameters: {
        directory: { type: 'string', required: true, description: 'Directory to sweep. Absolute, or relative to the workspace.' },
        limit: { type: 'number', description: 'Maximum rows listed. Defaults to 60.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderSweep(value.directory, value.rows, { limit: _args.limit }) }]
            : [{ type: 'text', text: renderProblem(value.directory ?? 'sweep', value.error) }],
      },
      timeoutMs: 60_000,
      execute(args, exec) {
        const directory = typeof args.directory === 'string' ? args.directory.trim() : ''
        if (directory === '') return { ok: false, directory, error: 'a directory is required' }
        const facts = statFile(qualify(directory, cwdFor(exec)))
        if (facts === undefined) return { ok: false, directory, error: `no such path: ${directory}` }
        if (!facts.directory) return { ok: false, directory, error: `not a directory: ${directory}` }
        const sweep = sweepDirectory(directory, config, { cwd: cwdFor(exec), platform: process.platform })
        return { ok: true, directory: sweep.directory, rows: sweep.rows }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'which_probe',
      description:
        'Run every copy of a command that resolution can find with a version flag, and report whether they agree. Use it to settle "which version is actually running" when a tool is installed in more than one place, or when a version check contradicts the version a command reports.',
      parameters: {
        command: { type: 'string', required: true, description: 'Command name to probe.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: renderProbe(value.command, value.probe) }]
            : [{ type: 'text', text: renderProblem(value.command ?? 'probe', value.error) }],
      },
      timeoutMs: 120_000,
      async execute(args, exec) {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        if (command === '') return { ok: false, command, error: 'a command name is required' }
        const platform = process.platform
        const resolution = resolveOnHost(command, { cwd: cwdFor(exec), platform })
        if (resolution.winner === null) {
          return { ok: false, command, error: `nothing named "${command}" resolves on PATH` }
        }
        /* Comparing copies only means something for a name looked up on PATH;
         * an explicit path has exactly one file behind it. */
        const includeShadowed = !isPathCommand(command)
        const probe = await probeWith(resolution, config, { includeShadowed, signal: exec.signal, platform })
        return { ok: true, command, probe }
      },
    }),
  )

  ctx.commands.register({
    name: 'which',
    description: 'Show what a command resolves to, the shape of PATH, or the command environment.',
    input: { hint: '[<command>] [--probe] [--path] [--env] [--sweep <dir>]' },
    async handler(invocation) {
      const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
      const tokens = raw.split(/\s+/u).filter((token) => token !== '')
      const flags = new Set(tokens.filter((token) => token.startsWith('--')))
      const positional = tokens.filter((token) => !token.startsWith('--'))
      const exec = { agent: invocation.agent, signal: invocation.signal }

      try {
        if (flags.has('--path')) {
          return { kind: 'success', text: renderPath(analyzeHostPath({ platform: process.platform })) }
        }
        if (flags.has('--env')) {
          return { kind: 'success', text: renderEnv(buildEnvReport(config, { cwd: cwdFor(exec), platform: process.platform })) }
        }
        if (flags.has('--sweep')) {
          const directory = positional[0] ?? '.'
          const facts = statFile(qualify(directory, cwdFor(exec)))
          if (facts === undefined || !facts.directory) {
            return { kind: 'error', text: `not a directory: ${directory}` }
          }
          const sweep = sweepDirectory(directory, config, { cwd: cwdFor(exec), platform: process.platform })
          return { kind: 'success', text: renderSweep(sweep.directory, sweep.rows) }
        }
        if (positional.length === 0) {
          return { kind: 'success', text: renderEnv(buildEnvReport(config, { cwd: cwdFor(exec), platform: process.platform })) }
        }

        const command = positional[0]
        const platform = process.platform
        const resolution = resolveOnHost(command, { cwd: cwdFor(exec), platform })
        const wantProbe = flags.has('--probe') || config.probeByDefault === true
        const probe = wantProbe && resolution.winner !== null
          ? await probeWith(resolution, config, { includeShadowed: flags.has('--probe'), signal: invocation.signal, platform })
          : undefined
        return { kind: 'success', text: renderResolve(resolution, { probe }) }
      } catch (error) {
        return { kind: 'error', text: `which failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}

export { analyzePath, resolveCommand, shadowGroups, probeResolution }
