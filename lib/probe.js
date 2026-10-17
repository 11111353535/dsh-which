/**
 * Asking a resolved binary what it thinks it is.
 *
 * Resolution tells you which file wins. It does not tell you that the file is
 * a two-year-old release, or that the winner and the shadowed copy behind it
 * are different major versions of the same tool. That gap is the whole reason
 * a `--version` in one shell disagrees with a `--version` in another.
 *
 * Running a binary is not free, so the rules are narrow: only files that
 * resolution already picked, only a known-safe version flag, a short timeout,
 * and a bounded amount of output. Nothing here is a general command runner.
 *
 * @module dsh-which/lib/probe
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Flags that ask a program for its version and exit. */
export const VERSION_FLAGS = ['--version', '-v', 'version', '-V']

/** How long a probe may take before it is abandoned. */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000

/** Output cap per probe, so a chatty program cannot flood the result. */
const MAX_OUTPUT = 8 * 1024

/**
 * Pull the most version-looking line out of a program's output.
 *
 * Programs are inconsistent: some print a bare number, some a banner, some put
 * the version on stderr. A line containing a digit and a dot is the best
 * available signal, and the first such line is almost always the version.
 *
 * @param {string} text - combined output.
 * @returns {string | undefined} the version line, when one is recognisable.
 */
export function extractVersion(text) {
  if (typeof text !== 'string') return undefined
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '')
  for (const line of lines) {
    if (/\d+\.\d+/u.test(line)) return line
  }
  return lines.length > 0 ? lines[0] : undefined
}

/**
 * Run one program with a version flag.
 *
 * A probe never throws: a program that hangs, exits non-zero, or does not
 * understand the flag is a result, not an error. The only thing worth
 * distinguishing is "we learned its version" from "we did not", and why.
 *
 * @param {string} file - absolute path to the program.
 * @param {{
 *   flag?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   platform?: string,
 *   run?: typeof run,
 * }} [options] - probe inputs.
 * @returns {Promise<{ path: string, flag: string, ok: boolean, version?: string, exitCode?: number, reason?: string, output?: string }>} the probe result.
 */
export async function probeVersion(file, options = {}) {
  const flag = options.flag ?? VERSION_FLAGS[0]
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const platform = options.platform ?? process.platform
  const runner = options.run ?? run

  try {
    const { stdout, stderr } = await runner(file, [flag], {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const combined = `${stdout ?? ''}${stderr ?? ''}`
    const version = extractVersion(combined)
    return version === undefined
      ? { path: file, flag, ok: false, reason: 'ran, but printed nothing that looks like a version' }
      : { path: file, flag, ok: true, version }
  } catch (error) {
    return { path: file, flag, ok: false, ...describeFailure(error, platform) }
  }
}

/**
 * Turn a failed probe into a reason a person can act on.
 *
 * @param {unknown} error - the thrown error.
 * @param {string} platform - platform.
 * @returns {{ reason: string, exitCode?: number, output?: string }} the description.
 */
function describeFailure(error, platform) {
  const code = error?.code
  const killed = error?.killed === true
  const timedOut = error?.signal === 'SIGTERM' && killed

  if (timedOut || code === 'ETIMEDOUT') {
    return { reason: 'did not answer in time' }
  }
  if (code === 'ENOENT') {
    return { reason: 'no such file' }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { reason: 'not permitted to run it' }
  }

  /* A program that prints its version and exits non-zero is common enough
   * (`java -version` does it) that its output still counts. */
  const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  const output = `${stdout}${stderr}`
  const version = extractVersion(output)
  const numeric = typeof code === 'number' ? code : Number.parseInt(String(code ?? ''), 10)
  const exitCode = Number.isFinite(numeric) ? numeric : undefined

  if (version !== undefined && output.trim() !== '') {
    return { reason: `exited non-zero but printed a version`, exitCode, output: version }
  }
  if (exitCode !== undefined) {
    return { reason: `exited with status ${exitCode}`, exitCode }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { reason: platform === 'win32' ? `could not run it: ${message}` : `could not run it: ${message}` }
}

/**
 * Probe the winner of a resolution and, optionally, everything behind it.
 *
 * The comparison is the point: two files answering to one name and reporting
 * different versions is the concrete form of "my terminal and my agent are
 * running different tools".
 *
 * @param {{ winner: object | null, candidates: object[] }} resolution - a resolution.
 * @param {{
 *   includeShadowed?: boolean,
 *   flag?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   platform?: string,
 *   run?: typeof run,
 * } } [options] - probe options.
 * @returns {Promise<{ winner: object | null, shadowed: object[], divergent: boolean }>} probe outcome.
 */
export async function probeResolution(resolution, options = {}) {
  const shared = {
    flag: options.flag,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    platform: options.platform,
    run: options.run,
  }

  const winner = resolution.winner === null ? null : await probeVersion(resolution.winner.path, shared)

  const shadowed = []
  if (options.includeShadowed === true) {
    for (const candidate of resolution.candidates) {
      if (candidate.path === resolution.winner?.path) continue
      shadowed.push({ candidate, probe: await probeVersion(candidate.path, shared) })
    }
  }

  const versions = new Set()
  if (winner?.ok === true) versions.add(winner.version)
  for (const entry of shadowed) {
    if (entry.probe.ok === true) versions.add(entry.probe.version)
  }

  return { winner, shadowed, divergent: versions.size > 1 }
}
