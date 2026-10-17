/**
 * The only module that touches the real filesystem and the real environment.
 *
 * Everything else is pure and injected, so the resolution rules can be tested
 * against a fixture tree instead of whatever happens to be installed on the
 * machine running the tests. Keeping the boundary in one file is what makes
 * that possible.
 *
 * @module dsh-which/lib/host
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

import { DEFAULT_PATHEXT, parsePathExt, splitPath, trimTrailingSeparator } from './pathlist.js'

/**
 * Stat one path, reporting only what resolution needs.
 *
 * A failure is not an error here: "this candidate does not exist" is the
 * common case, and throwing for it would make every lookup a try/catch.
 *
 * @param {string} path - path to stat.
 * @returns {{ size: number, mtimeMs: number, executable: boolean, directory: boolean } | undefined} facts, when the path exists.
 */
export function statFile(path) {
  try {
    const stats = statSync(path)
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      directory: stats.isDirectory(),
      /* Windows has no executable bit; resolution there is decided by
       * extension instead, so this only matters on POSIX. */
      executable: process.platform === 'win32' ? true : (stats.mode & 0o111) !== 0,
    }
  } catch {
    return undefined
  }
}

/**
 * List the files in a directory, tolerating a failure.
 *
 * @param {string} directory - directory to list.
 * @returns {string[]} entry names, sorted.
 */
export function listDirectory(directory) {
  try {
    return readdirSync(directory).sort()
  } catch {
    return []
  }
}

/**
 * Read the current PATH, split and annotated.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {{ platform?: string, separator?: string }} [options] - platform overrides.
 * @returns {{ raw: string, entries: { index: number, path: string }[] }} the PATH entries.
 */
export function readPath(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform
  const separator = options.separator ?? delimiter
  /* Windows environment variables are case-insensitive; Node's `process.env`
   * is not, so a `Path=` entry would be missed by a literal lookup. */
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  const raw = key === undefined ? '' : env[key] ?? ''
  return {
    raw,
    entries: splitPath(raw, separator).map((path, index) => ({ index, path: trimTrailingSeparator(path) })),
  }
}

/**
 * Read PATHEXT, or the platform default.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {{ platform?: string }} [options] - platform override.
 * @returns {string[]} extensions to try.
 */
export function readPathExt(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return ['']
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATHEXT')
  return parsePathExt(key === undefined ? undefined : env[key]) ?? [...DEFAULT_PATHEXT]
}

/**
 * Work out which shell the session is actually running commands through.
 *
 * Worth reporting because it explains resolution differences: `pwsh` and `cmd`
 * disagree about builtins and about `.ps1`, and a plugin that reports one
 * while the commands run in the other produces a report nobody can trust.
 *
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {{ platform?: string }} [options] - platform override.
 * @returns {{ name: string, path: string | undefined, kind: 'posix'|'cmd'|'powershell' }} the shell.
 */
export function detectShell(env = process.env, options = {}) {
  const platform = options.platform ?? process.platform
  const candidates = platform === 'win32'
    ? ['PWSH', 'POWERSHELL', 'COMSPEC']
    : ['SHELL']

  for (const name of candidates) {
    const key = Object.keys(env).find((entry) => entry.toUpperCase() === name)
    const value = key === undefined ? undefined : env[key]
    if (typeof value !== 'string' || value === '') continue
    return { name: basename(value), path: value, kind: kindOfShell(value, platform) }
  }

  return platform === 'win32'
    ? { name: 'cmd.exe', path: undefined, kind: 'cmd' }
    : { name: '/bin/sh', path: undefined, kind: 'posix' }
}

/**
 * Classify a shell by its executable name.
 *
 * @param {string} path - shell path.
 * @param {string} platform - platform.
 * @returns {'posix'|'cmd'|'powershell'} the shell family.
 */
function kindOfShell(path, platform) {
  const name = basename(path).toLowerCase()
  if (name.includes('powershell') || name.includes('pwsh')) return 'powershell'
  if (name === 'cmd.exe' || name === 'cmd') return 'cmd'
  return platform === 'win32' ? 'cmd' : 'posix'
}

/**
 * Join a directory and a name for the platform of the directory.
 *
 * @param {string} directory - directory.
 * @param {string} name - file name.
 * @returns {string} joined path.
 */
export function joinEntry(directory, name) {
  const trimmed = trimTrailingSeparator(directory)
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${separator}${name}`
}

/**
 * Commands that make up a usable toolchain, for the environment report.
 *
 * Deliberately short: a report that lists forty runtimes buries the one that
 * is broken. These are the ones whose absence or duplication actually breaks a
 * session.
 */
export const RUNTIME_CANDIDATES = [
  'node', 'npm', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'pip', 'pip3', 'uv',
  'git', 'rg', 'fd', 'make',
  'pwsh', 'bash',
]

export { DEFAULT_PATHEXT, parsePathExt, splitPath, join }
