/**
 * Unit tests for the pure modules.
 *
 * Everything here runs against a fixture filesystem: the resolution rules are
 * the interesting part, and they do not become more interesting when they run
 * against whatever happens to be installed on the machine running the tests.
 * The live test covers the real machine instead.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderEnv, renderPath, renderProbe, renderResolve, renderSweep } from '../lib/format.js'
import {
  DEFAULT_PATHEXT,
  analyzePath,
  candidateNames,
  expandEntry,
  foldCase,
  isNoiseEntry,
  parsePathExt,
  splitPath,
  stripQuotes,
  trimTrailingSeparator,
} from '../lib/pathlist.js'
import { extractVersion } from '../lib/probe.js'
import {
  classifyCandidate,
  isBuiltin,
  isPathCommand,
  isRunnable,
  looksDivergent,
  resolveCommand,
  shadowGroups,
  winnerDirectory,
  winnerName,
} from '../lib/resolve.js'
import { humanAge, humanBytes, shortenPath } from '../lib/units.js'

/* ---------------------------------------------------------------- fixture */

/**
 * A fixture filesystem, keyed by absolute path.
 *
 * Written as a plain object so a test can state exactly which files exist and
 * how big they are, which is what makes the shadowing and divergence rules
 * assertable.
 */
function fixture(files) {
  return (path) => files[path]
}

/**
 * A fixture filesystem that folds case, the way Windows does.
 *
 * PATHEXT is written in upper case by convention (`node.EXE`), while a fixture
 * naturally names the file as it appears on disk (`node.exe`). On a real
 * Windows filesystem those are one file; an exact-match map would pretend
 * otherwise and make the resolution tests assert something untrue.
 */
function windowsFixture(files) {
  const folded = new Map(Object.entries(files).map(([path, facts]) => [path.toLowerCase(), facts]))
  return (path) => folded.get(path.toLowerCase())
}

const WINDOWS = 'win32'
const POSIX = 'linux'

/* ------------------------------------------------------------- pathlist */

test('parsePathExt reads PATHEXT the way Windows does', () => {
  assert.deepEqual(parsePathExt('.COM;.EXE;.BAT;.CMD'), ['.COM', '.EXE', '.BAT', '.CMD'])
  /* Case is normalised and duplicates collapse, because PATHEXT is compared
   * case-insensitively and a doubled extension is a common installer bug. */
  assert.deepEqual(parsePathExt('.exe;.EXE;.cmd'), ['.EXE', '.CMD'])
  /* A missing leading dot is tolerated: some tools write `EXE;CMD`. */
  assert.deepEqual(parsePathExt('EXE;CMD'), ['.EXE', '.CMD'])
})

test('parsePathExt falls back to the default when PATHEXT is absent or empty', () => {
  assert.deepEqual(parsePathExt(undefined), [...DEFAULT_PATHEXT])
  assert.deepEqual(parsePathExt(''), [...DEFAULT_PATHEXT])
  assert.deepEqual(parsePathExt('   '), [...DEFAULT_PATHEXT])
  assert.deepEqual(parsePathExt(';;;'), [...DEFAULT_PATHEXT])
})

test('splitPath keeps order, drops empties, and strips quotes', () => {
  assert.deepEqual(splitPath('/usr/bin:/usr/local/bin', ':'), ['/usr/bin', '/usr/local/bin'])
  /* Empty entries are what a trailing separator produces; every shell ignores
   * them, and treating one as the current directory would be wrong. */
  assert.deepEqual(splitPath('/a::/b:', ':'), ['/a', '/b'])
  assert.deepEqual(splitPath('', ':'), [])
  assert.deepEqual(splitPath(undefined, ':'), [])
  /* A quoted entry is a real way to survive spaces; the quotes are not part of
   * the directory name. */
  assert.deepEqual(splitPath('"C:\\Program Files\\nodejs";C:\\tools', ';'), ['C:\\Program Files\\nodejs', 'C:\\tools'])
})

test('splitPath preserves duplicates, because the second copy still resolves', () => {
  assert.deepEqual(splitPath('/a:/b:/a', ':'), ['/a', '/b', '/a'])
})

test('stripQuotes only removes a matching pair', () => {
  assert.equal(stripQuotes('"C:\\a b"'), 'C:\\a b')
  assert.equal(stripQuotes('"unbalanced'), '"unbalanced')
  assert.equal(stripQuotes('plain'), 'plain')
  assert.equal(stripQuotes('"'), '"')
})

test('expandEntry expands %VAR% on Windows and $VAR elsewhere', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', HOME: '/home/me' }
  assert.deepEqual(
    expandEntry('%USERPROFILE%\\bin', env, { platform: WINDOWS }),
    { value: 'C:\\Users\\me\\bin', unresolved: [] },
  )
  assert.deepEqual(
    expandEntry('$HOME/bin', env, { platform: POSIX }),
    { value: '/home/me/bin', unresolved: [] },
  )
  assert.deepEqual(
    expandEntry('${HOME}/bin', env, { platform: POSIX }),
    { value: '/home/me/bin', unresolved: [] },
  )
})

test('expandEntry reports the names it could not resolve', () => {
  /* This is the finding, not an error: an entry with a literal %NOPE% in it can
   * never resolve, and the shell skips it in silence. */
  const result = expandEntry('%NOPE%\\bin', {}, { platform: WINDOWS })
  assert.equal(result.value, '%NOPE%\\bin')
  assert.deepEqual(result.unresolved, ['NOPE'])
})

test('expandEntry does not expand the other platform syntax', () => {
  const env = { HOME: '/home/me', USERPROFILE: 'C:\\Users\\me' }
  assert.equal(expandEntry('$HOME/bin', env, { platform: WINDOWS }).value, '$HOME/bin')
  assert.equal(expandEntry('%HOME%', env, { platform: POSIX }).value, '%HOME%')
})

test('foldCase folds on the platforms whose filesystems do', () => {
  assert.equal(foldCase('Node.EXE', WINDOWS), 'node.exe')
  assert.equal(foldCase('Node', 'darwin'), 'node')
  assert.equal(foldCase('Node', POSIX), 'Node')
})

test('trimTrailingSeparator keeps a root intact', () => {
  assert.equal(trimTrailingSeparator('/usr/bin/'), '/usr/bin')
  assert.equal(trimTrailingSeparator('C:\\tools\\\\'), 'C:\\tools')
  assert.equal(trimTrailingSeparator('/'), '/')
  assert.equal(trimTrailingSeparator('C:\\'), 'C:')
})

test('isNoiseEntry recognises the directories everybody has', () => {
  assert.equal(isNoiseEntry('/usr/bin'), true)
  assert.equal(isNoiseEntry('/usr/bin/'), true)
  assert.equal(isNoiseEntry('/opt/toolchain/bin'), false)
})

test('candidateNames walks PATHEXT on Windows and does nothing elsewhere', () => {
  const pathExt = ['.COM', '.EXE', '.BAT', '.CMD']
  assert.deepEqual(candidateNames('node', pathExt, { platform: WINDOWS }), [
    'node.COM', 'node.EXE', 'node.BAT', 'node.CMD',
  ])
  /* A name that already carries a known extension is tried as written first,
   * which is why `npm.cmd` and `npm` can resolve to different files. */
  assert.deepEqual(candidateNames('npm.cmd', pathExt, { platform: WINDOWS })[0], 'npm.cmd')
  assert.deepEqual(candidateNames('node', [], { platform: POSIX }), ['node'])
})

test('analyzePath finds duplicates, dead entries and unexpanded variables', () => {
  const env = { HOME: '/home/me' }
  const exists = fixture({
    '/home/me/.local/bin': { size: 0, directory: true },
    '/opt/dead': undefined,
    '/usr/bin': { size: 0, directory: true },
  })
  const analysis = analyzePath(
    `/home/me/.local/bin:/opt/dead:/home/me/.local/bin:$NOPE/bin:/usr/bin`,
    { separator: ':', env, platform: POSIX, exists: (path) => exists(path) !== undefined },
  )

  assert.equal(analysis.entries.length, 5)
  assert.equal(analysis.duplicates, 1)
  assert.equal(analysis.dead, 2, 'the unexpanded entry points nowhere, so it is dead too')
  assert.equal(analysis.unresolved, 1)
  assert.equal(analysis.uniqueDirectories, 4)
})

test('analyzePath marks the duplicate with the index it repeats', () => {
  const analysis = analyzePath('/a:/b:/a', { separator: ':', platform: POSIX, exists: () => true })
  assert.equal(analysis.entries[2].duplicateOf, 0)
  assert.equal(analysis.entries[0].duplicateOf, null)
})

test('analyzePath folds case when the platform does', () => {
  const windows = analyzePath('C:\\Tools;C:\\tools', { separator: ';', platform: WINDOWS, exists: () => true })
  assert.equal(windows.duplicates, 1)
  const linux = analyzePath('/Tools:/tools', { separator: ':', platform: POSIX, exists: () => true })
  assert.equal(linux.duplicates, 0)
})

test('analyzePath reports a clean PATH as clean', () => {
  const analysis = analyzePath('/usr/local/bin:/usr/bin', { separator: ':', platform: POSIX, exists: () => true })
  assert.equal(analysis.duplicates, 0)
  assert.equal(analysis.dead, 0)
  assert.equal(analysis.unresolved, 0)
})

/* -------------------------------------------------------------- resolve */

test('isPathCommand recognises separators on both platforms', () => {
  assert.equal(isPathCommand('./build.sh'), true)
  assert.equal(isPathCommand('tools\\x.exe'), true)
  assert.equal(isPathCommand('node'), false)
})

test('isBuiltin knows the shell handles some names itself', () => {
  assert.equal(isBuiltin('cd', { platform: POSIX }), true)
  assert.equal(isBuiltin('cd', { platform: WINDOWS }), true)
  assert.equal(isBuiltin('dir', { platform: WINDOWS, shell: 'cmd' }), true)
  assert.equal(isBuiltin('dir', { platform: POSIX }), false)
  /* `echo` is internal to every shell here, which is why `which echo` is a
   * question with no useful answer. */
  assert.equal(isBuiltin('echo', { platform: WINDOWS, shell: 'powershell' }), true)
  assert.equal(isBuiltin('node', { platform: WINDOWS }), false)
})

test('classifyCandidate separates native binaries, shims and scripts', () => {
  assert.equal(classifyCandidate('node.exe', { platform: WINDOWS }), 'executable')
  assert.equal(classifyCandidate('npm.cmd', { platform: WINDOWS }), 'shim')
  assert.equal(classifyCandidate('build.ps1', { platform: WINDOWS }), 'script')
  assert.equal(classifyCandidate('README.md', { platform: WINDOWS }), 'data')
  assert.equal(classifyCandidate('run', { platform: POSIX, executable: true }), 'executable')
  assert.equal(classifyCandidate('notes.txt', { platform: POSIX, executable: false }), 'data')
})

test('classifyCandidate calls a POSIX shell script a script, not a native binary', () => {
  /* The executable bit says a file runs; it does not say what the file is.
   * Reporting `build.sh` as a native binary is small and wrong, and small
   * wrongness is what makes a diagnostic untrustworthy. */
  assert.equal(classifyCandidate('build.sh', { platform: POSIX, executable: true }), 'script')
  assert.equal(classifyCandidate('tool.py', { platform: POSIX, executable: true }), 'script')
  assert.equal(classifyCandidate('node', { platform: POSIX, executable: true }), 'executable')
  /* An extension never makes a non-executable file runnable on POSIX. */
  assert.equal(classifyCandidate('build.sh', { platform: POSIX, executable: false }), 'data')
})

test('classifyCandidate reports a directory as a directory', () => {
  assert.equal(classifyCandidate('node.exe', { platform: WINDOWS, directory: true }), 'directory')
})

test('isRunnable requires the executable bit only where it exists', () => {
  assert.equal(isRunnable({ kind: 'executable' }, { platform: WINDOWS }), true)
  assert.equal(isRunnable({ kind: 'shim' }, { platform: WINDOWS }), true)
  assert.equal(isRunnable({ kind: 'script' }, { platform: WINDOWS }), true)
  assert.equal(isRunnable({ kind: 'data' }, { platform: WINDOWS }), false)
  assert.equal(isRunnable({ kind: 'directory' }, { platform: WINDOWS }), false)
  /* On POSIX a file with the right name and no +x is skipped; `ls` shows it,
   * the shell does not run it. */
  assert.equal(isRunnable({ kind: 'executable', executable: false }, { platform: POSIX }), false)
  assert.equal(isRunnable({ kind: 'executable', executable: true }, { platform: POSIX }), true)
})

test('resolveCommand answers a builtin without touching PATH', () => {
  const resolution = resolveCommand('cd', {
    entries: [{ index: 0, path: '/usr/bin' }],
    pathExt: [''],
    platform: POSIX,
    statFile: () => undefined,
  })
  assert.equal(resolution.kind, 'builtin')
  assert.equal(resolution.winner, null)
  assert.equal(resolution.searched, 0)
  assert.match(resolution.note, /shell/)
})

test('resolveCommand picks the first PATH entry that holds a runnable file', () => {
  const statFile = fixture({
    '/first/node': { size: 100, executable: true },
    '/second/node': { size: 200, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/first' }, { index: 1, path: '/second' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.equal(resolution.kind, 'path')
  assert.equal(resolution.winner.path, '/first/node')
  assert.equal(resolution.winner.directoryIndex, 0)
  assert.equal(resolution.candidates.length, 2)
})

test('resolveCommand walks past a file that is not executable', () => {
  const statFile = fixture({
    '/first/node': { size: 100, executable: false },
    '/second/node': { size: 200, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/first' }, { index: 1, path: '/second' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  /* The winner is the second entry, and the first is still reported — that
   * pair is the whole diagnosis. */
  assert.equal(resolution.winner.path, '/second/node')
  assert.equal(resolution.candidates.length, 2)
  assert.equal(resolution.candidates[0].executable, false)
})

test('resolveCommand reports a name that exists but can never run', () => {
  const statFile = fixture({ '/bin/build': { size: 100, executable: false } })
  const resolution = resolveCommand('build', {
    entries: [{ index: 0, path: '/bin' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.equal(resolution.kind, 'missing')
  assert.equal(resolution.winner, null)
  assert.equal(resolution.candidates.length, 1)
  assert.match(resolution.note, /not.*runnable/)
})

test('resolveCommand reports nothing found with no candidates at all', () => {
  const resolution = resolveCommand('nope', {
    entries: [{ index: 0, path: '/bin' }],
    pathExt: [''],
    platform: POSIX,
    statFile: () => undefined,
  })
  assert.equal(resolution.kind, 'missing')
  assert.equal(resolution.candidates.length, 0)
  assert.equal(resolution.searched, 1)
  assert.equal(resolution.note, undefined)
})

test('resolveCommand walks PATHEXT in order on Windows', () => {
  const statFile = windowsFixture({
    'C:\\nodejs\\node.cmd': { size: 300 },
    'C:\\nodejs\\node.exe': { size: 100 },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: 'C:\\nodejs' }],
    pathExt: ['.COM', '.EXE', '.BAT', '.CMD'],
    platform: WINDOWS,
    statFile,
  })
  /* `.EXE` comes before `.CMD` in PATHEXT, so the binary wins even though the
   * shim would also have been found. The name is the one PATHEXT spelled, so it
   * reads `node.EXE` — Windows found the file because its filesystem folds
   * case, which is exactly what the fixture models. */
  assert.match(resolution.winner.name, /^node\.exe$/iu)
  assert.equal(resolution.winner.kind, 'executable')
  assert.equal(resolution.candidates.length, 2)
})

test('resolveCommand prefers an explicit extension over PATHEXT order', () => {
  const statFile = windowsFixture({
    'C:\\nodejs\\node.cmd': { size: 300 },
    'C:\\nodejs\\node.exe': { size: 100 },
  })
  const resolution = resolveCommand('node.cmd', {
    entries: [{ index: 0, path: 'C:\\nodejs' }],
    pathExt: ['.COM', '.EXE', '.BAT', '.CMD'],
    platform: WINDOWS,
    statFile,
  })
  assert.equal(resolution.winner.name, 'node.cmd')
  assert.equal(resolution.winner.kind, 'shim')
})

test('resolveCommand uses an explicit path as written and never consults PATH', () => {
  const statFile = fixture({ '/opt/tools/run': { size: 10, executable: true } })
  const resolution = resolveCommand('/opt/tools/run', {
    entries: [{ index: 0, path: '/usr/bin' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.equal(resolution.kind, 'absolute')
  assert.equal(resolution.winner.path, '/opt/tools/run')
  assert.equal(resolution.searched, 0)
})

test('resolveCommand reports an explicit path that does not exist', () => {
  const resolution = resolveCommand('/nope', {
    entries: [],
    pathExt: [''],
    platform: POSIX,
    statFile: () => undefined,
  })
  assert.equal(resolution.kind, 'absolute')
  assert.equal(resolution.winner, null)
  assert.match(resolution.note, /no such file/)
})

test('resolveCommand reports an explicit path that is not runnable', () => {
  const statFile = fixture({ '/opt/notes.txt': { size: 10, executable: false } })
  const resolution = resolveCommand('/opt/notes.txt', {
    entries: [],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.equal(resolution.winner, null)
  assert.match(resolution.note, /not runnable/)
})

test('shadowGroups groups the copies that did not win', () => {
  const statFile = fixture({
    '/a/node': { size: 100, executable: true },
    '/b/node': { size: 200, executable: true },
    '/b/node.cmd': { size: 300 },
    '/c/node': { size: 400, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }, { index: 1, path: '/b' }, { index: 2, path: '/c' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const groups = shadowGroups(resolution)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].directory, '/b')
  assert.equal(groups[0].directoryIndex, 1)
  assert.equal(groups[1].directory, '/c')
})

test('shadowGroups is empty when only one copy exists', () => {
  const statFile = fixture({ '/a/node': { size: 100, executable: true } })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.deepEqual(shadowGroups(resolution), [])
})

test('resolveCommand lists a file once even when its PATH entry repeats', () => {
  /* An installer that prepends itself on every upgrade leaves the same
   * directory on PATH twice. That duplication is worth reporting — and
   * `which_path` does report it — but it must not inflate the candidate list,
   * which answers a different question: how many distinct files carry this
   * name. Counting one file twice would misstate the number of installed
   * copies and would make a shadowed group appear to hold itself. */
  const statFile = fixture({ '/opt/node/bin/node': { size: 100, executable: true } })
  const resolution = resolveCommand('node', {
    entries: [
      { index: 0, path: '/opt/node/bin' },
      { index: 1, path: '/usr/bin' },
      { index: 2, path: '/opt/node/bin' },
    ],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  assert.equal(resolution.candidates.length, 1)
  assert.equal(resolution.searched, 3, 'the repeated entry was still walked')
  assert.equal(resolution.winner.directoryIndex, 0)
  assert.equal(shadowGroups(resolution).length, 0, 'one file does not shadow itself')
})

test('looksDivergent reports a size difference and stays quiet without sizes', () => {
  assert.equal(looksDivergent({ size: 1 }, { size: 2 }), true)
  assert.equal(looksDivergent({ size: 2 }, { size: 2 }), false)
  assert.equal(looksDivergent({}, { size: 2 }), false)
})

test('winnerDirectory and winnerName describe the winner', () => {
  const resolution = { winner: { path: '/a/b/node.exe' } }
  assert.equal(winnerDirectory(resolution), '/a/b')
  assert.equal(winnerName(resolution), 'node.exe')
  assert.equal(winnerDirectory({ winner: null }), undefined)
})

/* ---------------------------------------------------------------- probe */

test('extractVersion prefers the first line that looks like a version', () => {
  assert.equal(extractVersion('v20.11.0\n'), 'v20.11.0')
  assert.equal(extractVersion('Some Tool\nVersion 1.2.3\nCopyright'), 'Version 1.2.3')
  /* A banner with no digits and a dot falls back to the first line, because
   * saying something is better than saying nothing. */
  assert.equal(extractVersion('Tool\nmore'), 'Tool')
  assert.equal(extractVersion(''), undefined)
  assert.equal(extractVersion(undefined), undefined)
})

test('extractVersion tolerates CRLF', () => {
  assert.equal(extractVersion('banner\r\n9.9.9\r\n'), '9.9.9')
})

/* ---------------------------------------------------------------- units */

test('humanBytes renders sizes without a trailing .0', () => {
  assert.equal(humanBytes(0), '0B')
  assert.equal(humanBytes(812), '812B')
  assert.equal(humanBytes(2048), '2KB')
  assert.equal(humanBytes(1536), '1.5KB')
  assert.equal(humanBytes(-1), '0B')
  assert.equal(humanBytes(undefined), '0B')
})

test('humanAge renders each magnitude', () => {
  assert.equal(humanAge(1), 'just now')
  assert.equal(humanAge(45), '45s')
  assert.equal(humanAge(600), '10m')
  assert.equal(humanAge(8000), '2h13m')
  assert.equal(humanAge(100000), '1d3h')
  assert.equal(humanAge(-1), 'unknown')
})

test('shortenPath keeps the tail', () => {
  assert.equal(shortenPath('/short', 72), '/short')
  const long = `/very/${'x'.repeat(100)}/node`
  assert.equal(shortenPath(long, 20).startsWith('…'), true)
  assert.equal(shortenPath(long, 20).endsWith('/node'), true)
})

/* --------------------------------------------------------------- format */

test('renderResolve puts the answer on the first line', () => {
  const statFile = fixture({
    '/first/node': { size: 100, executable: true },
    '/second/node': { size: 200, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/first' }, { index: 1, path: '/second' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const text = renderResolve(resolution)
  assert.match(text, /dsh-which · node/)
  assert.match(text, /winner:.*\/first\/node/)
  assert.match(text, /from:\s+PATH\[0\]/)
  assert.match(text, /shadowed — 1 other directory/)
  assert.match(text, /\/second\/node/)
})

test('renderResolve explains a builtin instead of reporting a file', () => {
  const resolution = resolveCommand('cd', { entries: [], pathExt: [''], platform: POSIX, statFile: () => undefined })
  const text = renderResolve(resolution)
  assert.match(text, /shell builtin/)
  assert.match(text, /never runs/)
})

test('renderResolve says what was searched when nothing resolved', () => {
  const resolution = resolveCommand('nope', {
    entries: [{ index: 0, path: '/a' }, { index: 1, path: '/b' }],
    pathExt: [''],
    platform: POSIX,
    statFile: () => undefined,
  })
  const text = renderResolve(resolution)
  assert.match(text, /not found/)
  assert.match(text, /searched: 2 PATH entries/)
})

test('renderResolve summarises a long list of unusable candidates instead of dumping it', () => {
  /* The same unusable name in every PATH directory is one fact. A machine with
   * a long PATH would otherwise turn "not found" into a wall of identical
   * lines, which is output people learn to skip. */
  const entries = Array.from({ length: 30 }, (_, index) => ({ index, path: `/opt/bin${index}` }))
  const resolution = resolveCommand('build', {
    entries,
    pathExt: [''],
    platform: POSIX,
    statFile: (path) => (path.endsWith('/build') ? { size: 1024, executable: false } : undefined),
  })
  const text = renderResolve(resolution)
  const listed = text.split('\n').filter((line) => line.includes('not runnable')).length
  assert.equal(listed, 8, 'eight candidates are listed')
  assert.match(text, /… and 22 more/)
})

test('renderResolve reports a probe result when there is one', () => {
  const statFile = fixture({ '/a/node': { size: 100, executable: true } })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const text = renderResolve(resolution, { probe: { winner: { ok: true, version: 'v20.11.0', flag: '--version' }, shadowed: [], divergent: false } })
  assert.match(text, /version:\s+v20\.11\.0/)
})

test('renderResolve reports a probe that failed', () => {
  const statFile = fixture({ '/a/node': { size: 100, executable: true } })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const text = renderResolve(resolution, { probe: { winner: { ok: false, reason: 'did not answer in time' }, shadowed: [], divergent: false } })
  assert.match(text, /version:\s+unknown — it did not answer in time/)
})

test('renderResolve warns when the copies disagree', () => {
  const statFile = fixture({
    '/a/node': { size: 100, executable: true },
    '/b/node': { size: 200, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }, { index: 1, path: '/b' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const probe = {
    winner: { ok: true, version: 'v20.11.0', flag: '--version' },
    shadowed: [{ candidate: { path: '/b/node' }, probe: { ok: true, version: 'v18.19.0' } }],
    divergent: true,
  }
  const text = renderResolve(resolution, { probe })
  assert.match(text, /report different versions/)
  assert.match(text, /↳ reports v18\.19\.0/)
})

test('renderResolve notes when the shadowed copy is a different build', () => {
  const statFile = fixture({
    '/a/node': { size: 100, executable: true },
    '/b/node': { size: 200, executable: true },
  })
  const resolution = resolveCommand('node', {
    entries: [{ index: 0, path: '/a' }, { index: 1, path: '/b' }],
    pathExt: [''],
    platform: POSIX,
    statFile,
  })
  const text = renderResolve(resolution)
  assert.match(text, /not the same build/)
})

test('renderPath leads with the findings', () => {
  const analysis = analyzePath('/a:/b:/a:/nope', {
    separator: ':',
    platform: POSIX,
    exists: (path) => path !== '/nope',
  })
  const text = renderPath(analysis)
  assert.match(text, /dsh-which · PATH/)
  assert.match(text, /4 entries · 3 unique directories/)
  assert.match(text, /1 duplicate entry · 1 dead entry/)
  assert.match(text, /dup of \[0\]/)
  assert.match(text, /— missing/)
})

test('renderPath says so when PATH is clean', () => {
  const analysis = analyzePath('/usr/bin:/usr/local/bin', { separator: ':', platform: POSIX, exists: () => true })
  const text = renderPath(analysis)
  assert.match(text, /no duplicates, no dead entries/)
})

test('renderPath hides the standard directories unless asked', () => {
  const analysis = analyzePath('/usr/bin:/opt/tools', { separator: ':', platform: POSIX, exists: () => true })
  assert.doesNotMatch(renderPath(analysis), /\/usr\/bin/)
  assert.match(renderPath(analysis, { showNoise: true }), /\/usr\/bin/)
})

test('renderPath explains the consequence of duplicates', () => {
  const analysis = analyzePath('/a:/a', { separator: ':', platform: POSIX, exists: () => true })
  assert.match(renderPath(analysis), /prepends itself/)
})

test('renderProbe compares the copies', () => {
  const text = renderProbe('node', {
    winner: { ok: true, version: 'v20.11.0' },
    shadowed: [{ candidate: { path: '/b/node' }, probe: { ok: true, version: 'v18.19.0' } }],
    divergent: true,
  })
  assert.match(text, /winner:\s+v20\.11\.0/)
  assert.match(text, /shadowed: v18\.19\.0/)
  assert.match(text, /report different versions/)
})

test('renderProbe says when every copy agrees', () => {
  const text = renderProbe('node', {
    winner: { ok: true, version: 'v20.11.0' },
    shadowed: [{ candidate: { path: '/b/node' }, probe: { ok: true, version: 'v20.11.0' } }],
    divergent: false,
  })
  assert.match(text, /same version/)
})

test('renderProbe handles a command that did not resolve', () => {
  assert.match(renderProbe('nope', { winner: null, shadowed: [], divergent: false }), /did not resolve/)
})

test('renderSweep marks the commands that resolve elsewhere', () => {
  const text = renderSweep('/repo/scripts', [
    { name: 'build', winner: '/usr/local/bin/build', shadowedBy: '/usr/local/bin/build' },
    { name: 'local', winner: '/repo/scripts/local' },
    { name: 'broken' },
  ])
  assert.match(text, /3 command\(s\)/)
  assert.match(text, /1 resolve outside this directory/)
  assert.match(text, /1 do not resolve at all/)
  assert.match(text, /↪ build/)
  assert.match(text, /· local/)
  assert.match(text, /✗ broken/)
})

test('renderSweep says so when a directory holds no commands', () => {
  assert.match(renderSweep('/repo', []), /nothing here looks like a command/)
})

test('renderEnv summarises the environment', () => {
  const report = {
    platform: 'linux',
    arch: 'x64',
    node: 'v24.13.0',
    shell: 'bash',
    shellPath: '/bin/bash',
    cwd: '/repo',
    path: { entries: [{}, {}], uniqueDirectories: 2, duplicates: 0, dead: 0, unresolved: 0 },
    runtimes: [
      { name: 'node', winner: '/usr/bin/node', shadowCount: 0 },
      { name: 'git', winner: undefined, shadowCount: 0 },
    ],
  }
  const text = renderEnv(report)
  assert.match(text, /platform: linux/)
  assert.match(text, /shell:\s+bash/)
  assert.match(text, /· node\s+\/usr\/bin\/node/)
  assert.match(text, /✗ git\s+not found/)
})

test('renderEnv reports PATH findings and duplicated runtimes', () => {
  const report = {
    platform: 'win32',
    arch: 'x64',
    node: 'v24.13.0',
    shell: 'pwsh.exe',
    cwd: 'C:\\repo',
    path: { entries: [{}, {}, {}], uniqueDirectories: 2, duplicates: 1, dead: 1, unresolved: 0 },
    pathext: ['.COM', '.EXE', '.BAT', '.CMD'],
    runtimes: [{ name: 'node', winner: 'C:\\nodejs\\node.exe', shadowCount: 2 }],
  }
  const text = renderEnv(report)
  assert.match(text, /1 duplicate · 1 dead/)
  assert.match(text, /PATHEXT:\s+\.COM \.EXE \.BAT \.CMD/)
  assert.match(text, /exist in more than one place on PATH: node/)
})
