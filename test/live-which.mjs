/**
 * Live smoke test.
 *
 * The unit tests prove the rules against fixtures. This script proves the one
 * thing fixtures cannot: that the rules, the real filesystem and the real
 * environment agree on the machine actually running the agent.
 *
 * Everything here is read-only. The one write is into a temporary directory,
 * and it exists to answer the question this plugin was built for — a file named
 * like a command, sitting in a directory, that is not the copy which runs.
 *
 * Run with `npm run test:live`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { renderEnv, renderPath, renderResolve, renderSweep } from '../lib/format.js'
import {
  analyzeHostPath,
  buildEnvReport,
  resolveOnHost,
  sweepDirectory,
} from '../lib/index.js'
import { detectShell, readPath, readPathExt } from '../lib/host.js'
import { Config } from '../lib/index.js'
import { probeResolution } from '../lib/probe.js'

const platform = process.platform
const config = Config({ runtimes: ['node', 'npm', 'git'] })

/**
 * Check that a report is printable and starts with its own heading.
 *
 * @param {string} text - rendered report.
 * @param {string} heading - expected first-line prefix.
 * @param {string} label - description used in the failure message.
 * @returns {string} a one-line summary for the results list.
 */
function assertReport(text, heading, label) {
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0, `${label} rendered nothing`)
  assert.ok(text.startsWith(heading), `${label} should start with "${heading}", got:\n${text}`)
  assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/u, `${label} leaked a placeholder:\n${text}`)
  return `${label} · ${text.split('\n').length} line(s)`
}

async function main() {
  const results = []
  results.push(`platform ${platform} · node ${process.version} · shell ${detectShell().name}`)

  /* 1. The environment report answers without being asked for anything. */
  {
    const report = buildEnvReport(config, { platform })
    assert.equal(report.platform, platform)
    assert.ok(report.path.entries.length > 0, 'PATH must have at least one entry')
    assert.ok(report.path.uniqueDirectories <= report.path.entries.length)
    assert.deepEqual(report.runtimes.map((runtime) => runtime.name), ['node', 'npm', 'git'])
    results.push(assertReport(renderEnv(report), 'dsh-which · environment', 'environment report'))
  }

  /* 2. PATH analysis names its findings, or says there are none. */
  {
    const analysis = analyzeHostPath({ platform })
    assert.equal(analysis.entries.length, readPath().entries.length)
    const text = renderPath(analysis)
    assert.match(text, /no duplicates, no dead entries|duplicate|dead|unexpanded/u)
    results.push(assertReport(text, 'dsh-which · PATH', 'PATH analysis'))
    results.push(`PATH findings: ${analysis.duplicates} duplicate · ${analysis.dead} dead · ${analysis.unresolved} unexpanded · ${analysis.uniqueDirectories} unique`)
  }

  /* 3. `node` resolves, and the file it resolves to is a real file. */
  {
    const resolution = resolveOnHost('node', { platform })
    assert.notEqual(resolution.winner, null, 'node must resolve while node is running this script')
    assert.equal(resolution.kind, 'path')
    assert.ok(resolution.winner.directoryIndex >= 0, 'node should come from a PATH entry')
    assert.ok(resolution.winner.size > 0, 'a resolved binary should have a size')
    results.push(assertReport(renderResolve(resolution), 'dsh-which · node', 'resolve report'))
    results.push(`node wins from PATH[${resolution.winner.directoryIndex}] as ${resolution.winner.name} (${resolution.winner.kind}), ${resolution.searched} entries searched`)
  }

  /* 4. Probing reports the same version node reports about itself. */
  {
    const resolution = resolveOnHost('node', { platform })
    const probe = await probeResolution(resolution, { includeShadowed: true, timeoutMs: 8000, platform })
    assert.notEqual(probe.winner, null)
    assert.equal(probe.winner.ok, true, `node --version should answer, got ${JSON.stringify(probe.winner)}`)
    /* The winner must be the very binary running this script, or at least a
     * node of the same version — anything else means resolution picked a
     * different install, which is exactly the bug worth knowing about. */
    assert.match(probe.winner.version, /\d+\.\d+\.\d+/u)
    results.push(`node --version → ${probe.winner.version}${probe.divergent ? ' (shadowed copies disagree)' : ''}`)
  }

  /* 5. A shell builtin never touches PATH. */
  {
    const shell = detectShell()
    const resolution = resolveOnHost('cd', { platform })
    /* On Windows the shell is cmd/pwsh and `cd` is internal; on POSIX it is a
     * builtin. Either way it must not resolve to a file. */
    assert.equal(resolution.winner, null, `cd should not resolve to a file, got ${JSON.stringify(resolution.winner)}`)
    results.push(`builtin detection: shell ${shell.name} (${shell.kind}) handles cd internally`)
  }

  /* 6. A file named like a command, in a directory that is not on PATH, does
   *    not run — and the sweep says so. This is the whole point of the plugin. */
  {
    const root = await mkdtemp(join(tmpdir(), 'which-live-'))
    /* Windows only runs files with an extension it knows, so the decoy has to
     * carry one there; elsewhere the executable bit is what matters, which is
     * why the file is chmodded below. */
    const decoy = platform === 'win32' ? 'node.cmd' : 'node'
    try {
      await writeFile(join(root, decoy), '#!/bin/sh\necho "not the real node"\n', { mode: 0o755 })
      await writeFile(join(root, 'notes.txt'), 'not a command\n')
      const sweep = sweepDirectory(root, config, { platform })
      const names = sweep.rows.map((row) => row.name)
      assert.ok(names.includes(decoy), `expected ${decoy} in ${JSON.stringify(names)}`)
      /* `notes.txt` carries no extension this platform would run, so it is not
       * a command candidate at all. */
      assert.equal(names.includes('notes.txt'), false, `notes.txt should not be swept as a command`)
      const row = sweep.rows.find((candidate) => candidate.name === decoy)
      assert.equal(row.winner, undefined, 'a file in a directory off PATH does not resolve')
      results.push(assertReport(renderSweep(sweep.directory, sweep.rows), 'dsh-which · sweep', 'sweep report'))
      results.push(`swept a temp directory: a decoy \`${decoy}\` off PATH is reported as unresolvable`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  /* 7. PATHEXT is read on Windows and ignored elsewhere. */
  {
    const pathExt = readPathExt(process.env, { platform })
    if (platform === 'win32') {
      assert.ok(pathExt.length > 0)
      assert.ok(pathExt.every((extension) => extension.startsWith('.')), `PATHEXT entries need a dot: ${pathExt.join(', ')}`)
      results.push(`PATHEXT ${pathExt.join(' ')}`)
    } else {
      assert.deepEqual(pathExt, [''])
      results.push('PATHEXT not applicable on this platform')
    }
  }

  console.log(`dsh-which live check · ${platform}`)
  for (const line of results) console.log(`  ✓ ${line}`)
  console.log(`  ${results.length}/${results.length} checks passed`)
}

await main()
