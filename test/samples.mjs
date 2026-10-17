/**
 * Generate the samples that go into the README.
 *
 * README examples rot faster than code, because nothing runs them. These are
 * produced by the plugin's own renderers from a fixed fixture, so what the
 * README shows is what the renderers actually emit — and regenerating is one
 * command when a format changes.
 *
 * Run with `node test/samples.mjs`.
 */

import {
  renderEnv,
  renderPath,
  renderProbe,
  renderResolve,
  renderSweep,
} from '../lib/format.js'
import { resolveCommand, shadowGroups } from '../lib/resolve.js'
import { analyzePath } from '../lib/pathlist.js'

/** A small, plausible Windows PATH with the classic mistakes in it. */
const WINDOWS_PATH = [
  'C:\\Program Files\\nodejs',      // [0] wins for node
  'C:\\Users\\me\\AppData\\Roaming\\npm',
  'C:\\Windows\\system32',
  'C:\\Windows',
  'C:\\tools\\git\\cmd',
  'C:\\Program Files\\nodejs',      // duplicate: an installer prepended itself
  'C:\\Users\\me\\scoop\\shims',
  'D:\\old-python\\Scripts',        // dead: uninstalled long ago
  '%USERPROFILE%\\bin',             // unexpanded: nothing ever expands this
]

/**
 * A fixture filesystem for the Windows example.
 *
 * `node` is installed twice: once in the normal place and once in a scoop shim
 * directory that comes later on PATH, so the winner shadows a different build.
 */
const WINDOWS_FILES = {
  'C:\\Program Files\\nodejs\\node.EXE': { size: 88_336_384, mtimeMs: Date.UTC(2025, 10, 3, 9, 14) },
  'C:\\Program Files\\nodejs\\npm.CMD': { size: 5_382 },
  'C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.CMD': { size: 4_116 },
  'C:\\Windows\\system32\\where.EXE': { size: 26_112 },
  'C:\\Windows\\system32\\git.EXE': undefined,
  'C:\\tools\\git\\cmd\\git.EXE': { size: 2_244_608 },
  'C:\\Users\\me\\scoop\\shims\\node.EXE': { size: 88_336_384 },
  'C:\\Users\\me\\scoop\\shims\\python.EXE': { size: 1_024 },
}

const winStat = (path) => WINDOWS_FILES[path]
const winEntries = WINDOWS_PATH.map((path, index) => ({ index, path }))

/* ------------------------------------------------------------ resolution */

const nodeResolution = resolveCommand('node', {
  entries: winEntries,
  pathExt: ['.COM', '.EXE', '.BAT', '.CMD'],
  platform: 'win32',
  statFile: winStat,
})

/* A probe outcome that shows the version disagreement the plugin exists to
 * name: the winner is current, the shadowed copy is two majors behind. */
const nodeProbe = {
  winner: { path: 'C:\\Program Files\\nodejs\\node.EXE', flag: '--version', ok: true, version: 'v24.13.0' },
  shadowed: [
    {
      candidate: nodeResolution.candidates[1],
      probe: { path: nodeResolution.candidates[1].path, flag: '--version', ok: true, version: 'v20.11.1' },
    },
  ],
  divergent: true,
}

/* ------------------------------------------------------------- reporting */

const pathAnalysis = analyzePath(WINDOWS_PATH.join(';'), {
  platform: 'win32',
  env: { USERPROFILE: 'C:\\Users\\me' },
  exists: (path) => path !== 'D:\\old-python\\Scripts',
})

const sweepRows = [
  { name: 'build.cmd', winner: 'C:\\tools\\build\\build.cmd', shadowedBy: 'C:\\tools\\build\\build.cmd' },
  { name: 'deploy.cmd', winner: 'C:\\repo\\scripts\\deploy.cmd' },
  { name: 'smoke.cmd' },
]

/* A name that is on PATH but cannot run: present in every directory, none of
 * them executable. POSIX is where this actually happens — on Windows the
 * extension alone decides, so an unreadable "not runnable" there means the file
 * has no runnable extension at all. The report has to say this without printing
 * the same line forty-five times. */
const unusableResolution = resolveCommand('build', {
  entries: Array.from({ length: 45 }, (_, index) => ({ index, path: `/opt/bin${index}` })),
  pathExt: [''],
  platform: 'linux',
  statFile: (path) => (path.endsWith('/build') ? { size: 1024, executable: false } : undefined),
})

/* An explicit path never consults PATH, and the report has to say so — this is
 * where a reader learns that `./build.sh` and `build` are different programs. */
const explicitResolution = resolveCommand('/repo/scripts/build.sh', {
  entries: [],
  pathExt: ['.COM', '.EXE', '.BAT', '.CMD'],
  platform: 'linux',
  statFile: () => ({ size: 2400, executable: true }),
})

const envReport = {
  platform: 'win32',
  arch: 'x64',
  node: 'v24.13.0',
  shell: 'pwsh.exe',
  shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  shellKind: 'powershell',
  cwd: 'C:\\repo',
  path: pathAnalysis,
  pathext: ['.COM', '.EXE', '.BAT', '.CMD'],
  runtimes: [
    { name: 'node', winner: 'C:\\Program Files\\nodejs\\node.EXE', shadowCount: 1 },
    { name: 'npm', winner: 'C:\\Program Files\\nodejs\\npm.CMD', shadowCount: 0 },
    { name: 'pnpm', winner: 'C:\\Users\\me\\AppData\\Roaming\\npm\\pnpm.CMD', shadowCount: 0 },
    { name: 'git', winner: 'C:\\tools\\git\\cmd\\git.EXE', shadowCount: 0 },
    { name: 'python', winner: undefined, shadowCount: 0 },
  ],
}

/* ---------------------------------------------------------------- output */

const sections = [
  ['renderResolve — what runs', renderResolve(nodeResolution)],
  ['renderResolve — with a probe', renderResolve(nodeResolution, { probe: nodeProbe })],
  ['renderResolve — a name that exists but cannot run', renderResolve(unusableResolution)],
  ['renderResolve — an explicit path', renderResolve(explicitResolution)],
  ['renderPath — the shape of PATH', renderPath(pathAnalysis)],
  ['renderProbe — version comparison', renderProbe('node', nodeProbe)],
  ['renderSweep — scripts in one directory', renderSweep('C:\\repo\\scripts', sweepRows)],
  ['renderEnv — the environment report', renderEnv(envReport)],
]

/* `shadowGroups` is used by the renderers, but printing it proves the fixture
 * really has a shadowed copy rather than a rendering artefact. */
const groups = shadowGroups(nodeResolution)

for (const [title, text] of sections) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`)
  console.log(text)
}

console.log(`\n${'='.repeat(72)}\nfixture facts\n${'='.repeat(72)}`)
console.log(`winner: ${nodeResolution.winner.path} (PATH[${nodeResolution.winner.directoryIndex}])`)
console.log(`shadow groups: ${groups.length}`)
for (const group of groups) console.log(`  PATH[${group.directoryIndex}] ${group.directory} — ${group.entries.map((entry) => entry.name).join(', ')}`)
console.log(`PATH findings: ${pathAnalysis.duplicates} duplicate, ${pathAnalysis.dead} dead, ${pathAnalysis.unresolved} unexpanded, ${pathAnalysis.uniqueDirectories} unique`)
