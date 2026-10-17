/**
 * PATH itself: what is in it, what is wrong with it, and what it implies.
 *
 * Pure functions. Existence checks are injected, so the whole module is
 * testable against a fixture filesystem and never touches a disk on its own.
 *
 * @module dsh-which/lib/pathlist
 */

import { delimiter } from 'node:path'

/** Windows resolves an unqualified command by walking PATHEXT, in order. */
export const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD']

/** Directories that are on essentially every PATH and explain nothing. */
const NOISE_ENTRIES = new Set([
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
])

/**
 * Read PATHEXT the way Windows does.
 *
 * @param {string} [raw] - the raw `PATHEXT` value.
 * @returns {string[]} extensions, each starting with a dot, upper-cased.
 */
export function parsePathExt(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [...DEFAULT_PATHEXT]
  const seen = new Set()
  const extensions = []
  for (const piece of raw.split(';')) {
    const trimmed = piece.trim()
    if (trimmed === '') continue
    const extension = (trimmed.startsWith('.') ? trimmed : `.${trimmed}`).toUpperCase()
    if (seen.has(extension)) continue
    seen.add(extension)
    extensions.push(extension)
  }
  return extensions.length === 0 ? [...DEFAULT_PATHEXT] : extensions
}

/**
 * Split a PATH string into entries, preserving order and duplicates.
 *
 * Order is the whole point: the first entry that holds the command wins. An
 * entry is kept even when it repeats, because a duplicate tells you something
 * about how the variable was assembled, and the second copy can still be the
 * one that resolves when the first is deleted mid-session.
 *
 * @param {string} raw - the raw `PATH` value.
 * @param {string} [separator] - entry separator; defaults to the platform's.
 * @returns {string[]} entries, in order, with empty ones dropped.
 */
export function splitPath(raw, separator = delimiter) {
  if (typeof raw !== 'string' || raw === '') return []
  return raw
    .split(separator)
    .map((entry) => stripQuotes(entry.trim()))
    .filter((entry) => entry !== '')
}

/**
 * Remove the quotes a Windows PATH entry is sometimes wrapped in.
 *
 * A quoted entry is a real thing people do to survive spaces, but the quotes
 * are not part of the directory name, so every consumer has to strip them.
 *
 * @param {string} value - one entry.
 * @returns {string} the entry without surrounding quotes.
 */
export function stripQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Expand `%VAR%` (Windows) and `$VAR` / `${VAR}` (POSIX) references.
 *
 * PATH entries written by installers are routinely left unexpanded, and an
 * unexpanded entry never resolves — which looks exactly like a broken tool.
 *
 * @param {string} entry - one PATH entry.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {{ platform?: string }} [options] - platform override.
 * @returns {{ value: string, unresolved: string[] }} expanded entry and the names that had no value.
 */
export function expandEntry(entry, env = {}, options = {}) {
  const platform = options.platform ?? process.platform
  const unresolved = []
  const lookup = (name) => {
    const value = env[name]
    if (value === undefined) {
      unresolved.push(name)
      return undefined
    }
    return value
  }

  let value = entry
  if (platform === 'win32') {
    /* `cmd` expands `%VAR%`. Nothing on Windows expands a bare `$NAME`, so
     * expanding it here would invent a resolution the shell never performs. */
    value = value.replace(/%([^%]+)%/gu, (match, name) => lookup(name) ?? match)
  } else {
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (match, braced, bare) => {
      const name = braced ?? bare
      return lookup(name) ?? match
    })
  }
  return { value, unresolved }
}

/**
 * Fold case the way the platform's filesystem does.
 *
 * @param {string} value - path or command name.
 * @param {string} [platform] - platform override.
 * @returns {string} comparison key.
 */
export function foldCase(value, platform = process.platform) {
  return platform === 'win32' || platform === 'darwin' ? value.toLowerCase() : value
}

/**
 * A trailing separator is not part of the directory name.
 *
 * @param {string} value - directory path.
 * @returns {string} path without a trailing separator.
 */
export function trimTrailingSeparator(value) {
  if (value.length <= 1) return value
  return value.replace(/[\\/]+$/u, '')
}

/**
 * Whether an entry is a directory everybody has, and so is worth no remark.
 *
 * @param {string} value - PATH entry.
 * @returns {boolean} true when the entry is unremarkable.
 */
export function isNoiseEntry(value) {
  return NOISE_ENTRIES.has(trimTrailingSeparator(value))
}

/**
 * Analyse a PATH string: order, duplicates, dead entries, unexpanded names.
 *
 * Three findings matter in practice, and all three are silent failures:
 *
 * - **Duplicates.** An installer prepends itself to PATH on every run, and
 *   after a few upgrades the same directory appears three times. Harmless
 *   until it is not: the entry that matters is now behind two copies of
 *   itself, and a `PATH` edit that removes "the" entry removes one of three.
 * - **Dead entries.** A directory that does not exist. `cmd` and POSIX shells
 *   both skip these without complaint, so an uninstalled toolchain leaves a
 *   hole that only shows up when the command that lived there fails.
 * - **Unexpanded variables.** An entry containing a literal `%USERPROFILE%`
 *   or `$HOME` never resolves, because nothing expands it after the fact.
 *
 * @param {string} raw - raw PATH value.
 * @param {{
 *   separator?: string,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 * }} [options] - analysis inputs.
 * @returns {{
 *   entries: { index: number, raw: string, path: string, exists: boolean, duplicateOf: number | null, unresolved: string[], noise: boolean }[],
 *   duplicates: number,
 *   dead: number,
 *   unresolved: number,
 *   uniqueDirectories: number,
 * }} the analysis.
 */
export function analyzePath(raw, options = {}) {
  const platform = options.platform ?? process.platform
  const separator = options.separator ?? delimiter
  const env = options.env ?? {}
  const exists = options.exists ?? (() => true)

  const rawEntries = splitPath(raw, separator)
  const seen = new Map()
  const entries = []
  let duplicates = 0
  let dead = 0
  let unresolved = 0

  for (const [index, entry] of rawEntries.entries()) {
    const expanded = expandEntry(entry, env, { platform })
    const path = trimTrailingSeparator(expanded.value)
    const key = foldCase(path, platform)
    const duplicateOf = seen.has(key) ? seen.get(key) : null
    if (duplicateOf !== null) duplicates += 1
    else seen.set(key, index)

    const present = exists(path)
    if (!present) dead += 1
    if (expanded.unresolved.length > 0) unresolved += 1

    entries.push({
      index,
      raw: entry,
      path,
      exists: present,
      duplicateOf,
      unresolved: expanded.unresolved,
      noise: isNoiseEntry(path),
    })
  }

  return {
    entries,
    duplicates,
    dead,
    unresolved,
    uniqueDirectories: seen.size,
  }
}

/**
 * The candidate file names a command name resolves to, in order.
 *
 * Windows walks PATHEXT for every directory; POSIX has no such notion, so the
 * bare name is the only candidate and the executable bit decides. When the
 * command already carries an extension that is in PATHEXT, Windows tries that
 * exact file first — which is why `npm.cmd` and `npm` can resolve differently.
 *
 * @param {string} command - command name, with or without an extension.
 * @param {string[]} pathExt - extensions to try, in order.
 * @param {{ platform?: string }} [options] - platform override.
 * @returns {string[]} candidate file names, in resolution order.
 */
export function candidateNames(command, pathExt, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return [command]

  const upper = command.toUpperCase()
  const names = []
  const hasKnownExtension = pathExt.some((extension) => upper.endsWith(extension))
  if (hasKnownExtension) names.push(command)
  for (const extension of pathExt) {
    const candidate = `${command}${extension}`
    if (!names.includes(candidate)) names.push(candidate)
  }
  return names
}
