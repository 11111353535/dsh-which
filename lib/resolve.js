/**
 * Resolving a command name the way a shell actually would.
 *
 * The rules that matter, and that a bare `which` hides:
 *
 * 1. **A command with a separator never consults PATH.** `./build.sh` and
 *    `C:\tools\x.exe` are used as written; PATH is irrelevant.
 * 2. **Shell builtins and internal commands win before any lookup.** `cd`,
 *    `echo`, `dir`, `copy` are not files, so a `which` that searches PATH
 *    answers a question nobody asked.
 * 3. **On Windows, PATHEXT decides which file a bare name becomes**, and its
 *    order matters — `npm.cmd` and `npm` are different programs.
 * 4. **On POSIX, the executable bit decides.** A file with the right name and
 *    no `+x` is skipped, and the search continues into later PATH entries. A
 *    listing tool shows it; a shell does not run it.
 *
 * All filesystem access is injected, so this module is pure with respect to
 * the disk and testable against a fixture tree.
 *
 * @module dsh-which/lib/resolve
 */

import { basename, dirname, extname, isAbsolute, sep } from 'node:path'

import { candidateNames, foldCase, trimTrailingSeparator } from './pathlist.js'

/** Extensions Windows runs as a real binary. */
const NATIVE_EXTENSIONS = new Set(['.EXE', '.COM'])

/** Extensions that are a shim: a script the shell itself interprets. */
const SHIM_EXTENSIONS = new Set(['.CMD', '.BAT'])

/** Extensions that need another interpreter named explicitly. */
const SCRIPT_EXTENSIONS = new Set(['.PS1', '.VBS', '.JS', '.MJS', '.PY', '.SH', '.PL', '.RB'])

/**
 * Commands a shell handles itself, so PATH is never consulted.
 *
 * Two lists because the shells differ. Getting this wrong is the classic
 * `which cd` answer: a search that walks every PATH entry to report a file
 * that has nothing to do with what runs.
 */
const BUILTINS = {
  posix: new Set([
    'alias', 'bg', 'break', 'cd', 'command', 'continue', 'echo', 'eval', 'exec',
    'exit', 'export', 'false', 'fg', 'getopts', 'hash', 'jobs', 'kill', 'let',
    'local', 'printf', 'pwd', 'read', 'readonly', 'return', 'set', 'shift',
    'source', 'test', 'times', 'trap', 'true', 'type', 'ulimit', 'umask',
    'unalias', 'unset', 'wait',
  ]),
  cmd: new Set([
    'assoc', 'break', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date',
    'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'ftype', 'goto',
    'if', 'md', 'mkdir', 'mklink', 'move', 'path', 'pause', 'popd', 'prompt',
    'pushd', 'rd', 'rem', 'ren', 'rename', 'rmdir', 'set', 'setlocal', 'shift',
    'start', 'time', 'title', 'type', 'ver', 'verify', 'vol',
  ]),
  powershell: new Set([
    'cd', 'chdir', 'clear-host', 'copy-item', 'echo', 'foreach-object', 'get-childitem',
    'get-command', 'get-content', 'get-item', 'get-location', 'get-member',
    'invoke-command', 'measure-object', 'move-item', 'new-item', 'out-file',
    'push-location', 'pop-location', 'remove-item', 'rename-item', 'select-object',
    'set-content', 'set-location', 'sort-object', 'start-sleep', 'tee-object',
    'test-path', 'where-object', 'write-host', 'write-output',
  ]),
}

/**
 * Whether a command name is handled by the shell rather than by PATH.
 *
 * @param {string} command - command name.
 * @param {{ platform?: string, shell?: 'posix'|'cmd'|'powershell' }} [options] - platform and shell.
 * @returns {boolean} true when the shell resolves it internally.
 */
export function isBuiltin(command, options = {}) {
  const platform = options.platform ?? process.platform
  const shell = options.shell ?? (platform === 'win32' ? 'cmd' : 'posix')
  const table = BUILTINS[shell]
  if (table === undefined) return false
  const key = foldCase(command, platform)
  return table.has(key)
}

/**
 * Whether a command name contains a path separator.
 *
 * @param {string} command - command name.
 * @returns {boolean} true when the name is a path, not a lookup.
 */
export function isPathCommand(command) {
  return command.includes('/') || command.includes('\\') || command.includes(sep)
}

/**
 * Classify a candidate file by what it takes to run it.
 *
 * @param {string} file - file name.
 * @param {{ platform?: string, executable?: boolean }} [info] - stat facts.
 * @returns {string} one of `executable`, `shim`, `script`, `data`, `directory`.
 */
export function classifyCandidate(file, info = {}) {
  const platform = info.platform ?? process.platform
  if (info.directory === true) return 'directory'
  if (platform === 'win32') {
    const extension = extname(file).toUpperCase()
    if (NATIVE_EXTENSIONS.has(extension)) return 'executable'
    if (SHIM_EXTENSIONS.has(extension)) return 'shim'
    if (SCRIPT_EXTENSIONS.has(extension)) return 'script'
    return 'data'
  }
  /* On POSIX the executable bit decides whether something runs, but it says
   * nothing about what it is. A `+x` shell script and a compiled binary are
   * both "runnable" and are not the same thing to a reader — reporting a
   * `.sh` as a native binary is the kind of small wrongness that makes a
   * diagnostic untrustworthy. Extension only refines the label here; it never
   * changes whether the file can run. */
  if (info.executable !== true) return 'data'
  const extension = extname(file).toLowerCase()
  if (SCRIPT_EXTENSIONS.has(extension.toUpperCase())) return 'script'
  return 'executable'
}

/**
 * Whether a candidate could actually be the one a shell runs.
 *
 * @param {{ kind: string, executable?: boolean }} candidate - candidate.
 * @param {{ platform?: string }} [options] - platform.
 * @returns {boolean} true when the candidate is runnable.
 */
export function isRunnable(candidate, options = {}) {
  const platform = options.platform ?? process.platform
  if (candidate.kind === 'directory') return false
  if (platform === 'win32') return candidate.kind !== 'data'
  return candidate.executable === true
}

/**
 * Resolve a command name against an ordered list of PATH entries.
 *
 * The winner is the first runnable candidate in (entry, PATHEXT) order. Every
 * other candidate that exists is reported as shadowed, because the interesting
 * question is rarely "what runs" and usually "what *else* is there, and why is
 * it not running" — a stale global install behind a fresh local one, a `.cmd`
 * shim hiding a POSIX script, a file that exists but was never made
 * executable.
 *
 * @param {string} command - command name, or a path.
 * @param {{
 *   entries: { index: number, path: string }[],
 *   pathExt: string[],
 *   platform?: string,
 *   statFile: (path: string) => { size?: number, mtimeMs?: number, executable?: boolean, directory?: boolean } | undefined,
 * }} options - resolution inputs.
 * @returns {{
 *   command: string,
 *   kind: 'builtin' | 'path' | 'absolute' | 'missing',
 *   winner: object | null,
 *   candidates: object[],
 *   searched: number,
 *   note?: string,
 * }} the resolution.
 */
export function resolveCommand(command, options) {
  const platform = options.platform ?? process.platform
  const pathExt = options.pathExt ?? []
  const statFile = options.statFile
  const entries = options.entries ?? []

  if (isBuiltin(command, { platform })) {
    return { command, kind: 'builtin', winner: null, candidates: [], searched: 0, note: 'handled by the shell; PATH is never consulted' }
  }

  /* A path is used as written: no PATH, no PATHEXT. */
  if (isPathCommand(command) || isAbsolute(command)) {
    const facts = statFile(command)
    const candidate = facts === undefined ? null : buildCandidate(command, command, -1, '', facts, platform)
    const runnable = candidate !== null && isRunnable(candidate, { platform })
    return {
      command,
      kind: 'absolute',
      winner: runnable ? candidate : null,
      candidates: candidate === null ? [] : [candidate],
      searched: 0,
      ...(runnable ? {} : { note: candidate === null ? 'no such file' : 'the file exists but is not runnable' }),
    }
  }

  const names = candidateNames(command, pathExt, { platform })
  const candidates = []
  const seen = new Set()
  let searched = 0

  for (const entry of entries) {
    searched += 1
    for (const name of names) {
      const absolute = joinEntry(entry.path, name)
      const facts = statFile(absolute)
      if (facts === undefined) continue
      /* A PATH entry that appears twice yields the same file twice. The
       * duplication is worth reporting, but by `which_path`, not here: this
       * list is "every distinct file that answers to the name", and counting
       * one file twice would misreport how many copies exist. */
      if (seen.has(absolute)) continue
      seen.add(absolute)
      candidates.push(buildCandidate(absolute, name, entry.index, entry.path, facts, platform))
    }
  }

  const winner = candidates.find((candidate) => isRunnable(candidate, { platform })) ?? null
  return {
    command,
    kind: winner === null ? 'missing' : 'path',
    winner,
    candidates,
    searched,
    ...(winner === null && candidates.length > 0
      ? { note: 'the name exists on PATH but nothing with that name is runnable' }
      : {}),
  }
}

/**
 * Assemble one candidate record.
 *
 * @param {string} absolute - full path to the candidate.
 * @param {string} name - the name that matched.
 * @param {number} entryIndex - PATH entry index, or -1 for an explicit path.
 * @param {string} directory - the PATH entry, or the file's own directory.
 * @param {object} facts - injected stat facts.
 * @param {string} platform - platform.
 * @returns {object} candidate record.
 */
function buildCandidate(absolute, name, entryIndex, directory, facts, platform) {
  const kind = classifyCandidate(name, { ...facts, platform })
  return {
    path: absolute,
    name,
    directory,
    directoryIndex: entryIndex,
    kind,
    executable: facts.executable === true,
    size: facts.size,
    mtimeMs: facts.mtimeMs,
  }
}

/**
 * Join a PATH entry and a file name with the right separator.
 *
 * @param {string} directory - PATH entry.
 * @param {string} name - file name.
 * @returns {string} the joined path.
 */
function joinEntry(directory, name) {
  const trimmed = trimTrailingSeparator(directory)
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${separator}${name}`
}

/**
 * Group the shadowed candidates of a resolution by their directory.
 *
 * The output answers "where else does this name live", which is what turns a
 * resolution into a diagnosis: the same tool installed twice, once per
 * package manager, is the usual reason a version check disagrees with a
 * `--version` output.
 *
 * @param {{ candidates: object[], winner: object | null }} resolution - a resolution.
 * @returns {{ directory: string, directoryIndex: number, entries: object[] }[]} shadowed groups.
 */
export function shadowGroups(resolution) {
  const winnerPath = resolution.winner?.path
  const groups = new Map()
  for (const candidate of resolution.candidates) {
    if (candidate.path === winnerPath) continue
    const key = candidate.directory
    if (!groups.has(key)) groups.set(key, { directory: key, directoryIndex: candidate.directoryIndex, entries: [] })
    groups.get(key).entries.push(candidate)
  }
  return [...groups.values()].sort((left, right) => left.directoryIndex - right.directoryIndex)
}

/**
 * Whether a candidate looks like a different build of the same tool.
 *
 * A size difference is not proof of a version difference, but it is the
 * cheapest available signal that two files answering to one name are not the
 * same file, and it is enough to justify saying so.
 *
 * @param {object} left - one candidate.
 * @param {object} right - another candidate.
 * @returns {boolean} true when the two differ in a way worth reporting.
 */
export function looksDivergent(left, right) {
  if (left.size === undefined || right.size === undefined) return false
  return left.size !== right.size
}

/**
 * The directory a resolved command lives in.
 *
 * @param {{ winner: object | null }} resolution - a resolution.
 * @returns {string | undefined} the directory, when something won.
 */
export function winnerDirectory(resolution) {
  const path = resolution.winner?.path
  if (path === undefined) return undefined
  return dirname(path)
}

/**
 * The file name of a resolved command, as it will be executed.
 *
 * @param {{ winner: object | null }} resolution - a resolution.
 * @returns {string | undefined} the file name, when something won.
 */
export function winnerName(resolution) {
  const path = resolution.winner?.path
  if (path === undefined) return undefined
  return basename(path)
}
