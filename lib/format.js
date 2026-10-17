/**
 * Rendering: everything the human and the model actually read.
 *
 * Pure string work. The same renderers serve every tool, so a resolution looks
 * the same whether it was asked for by name or found by a sweep.
 *
 * @module dsh-which/lib/format
 */

import { humanAge, humanBytes, shortenPath } from './units.js'
import { looksDivergent, shadowGroups } from './resolve.js'

/** How each candidate kind reads to a person. */
const KIND_LABELS = {
  executable: 'native binary',
  shim: 'shell shim',
  script: 'script',
  data: 'not runnable',
  directory: 'directory',
}

/** Candidates listed before the report switches to "and N more". */
const CANDIDATE_LIMIT = 8

/** Shadowed directories enumerated before the rest are counted only. */
const SHADOW_GROUP_LIMIT = 8

/**
 * Render one candidate as a single line.
 *
 * @param {object} candidate - candidate record.
 * @param {{ prefix?: string, marker?: string }} [options] - rendering options.
 * @returns {string} the line.
 */
export function renderCandidate(candidate, options = {}) {
  const prefix = options.prefix ?? '      '
  const marker = options.marker ?? ' '
  const size = candidate.size === undefined ? '' : `  ${humanBytes(candidate.size)}`
  const label = KIND_LABELS[candidate.kind] ?? candidate.kind
  return `${prefix}${marker} ${candidate.name}  ${label}${size}`
}

/**
 * Render a resolution: what wins, where it came from, what it shadowed.
 *
 * The first line carries the answer, because that is what a reader who is not
 * going to read the rest needs.
 *
 * @param {object} resolution - a resolution.
 * @param {{ probe?: object, note?: string }} [options] - optional probe outcome.
 * @returns {string} report text.
 */
export function renderResolve(resolution, options = {}) {
  const { command, kind, winner, candidates, searched } = resolution

  if (kind === 'builtin') {
    return [
      `dsh-which · ${command}`,
      `  kind:     shell builtin`,
      `  ${resolution.note ?? 'handled by the shell; PATH is never consulted'}`,
      '',
      'Nothing on PATH decides this command — the shell does. A file with the same name, if one exists, never runs.',
    ].join('\n')
  }

  if (winner === null) {
    const lines = [`dsh-which · ${command}`, `  not found`]
    if (resolution.note !== undefined) lines.push(`  ${resolution.note}`)
    lines.push(`  searched: ${searched} PATH entr${searched === 1 ? 'y' : 'ies'}`)
    if (candidates.length > 0) {
      /* The same unusable name in every PATH directory is one fact, not forty
       * five. Without a cap a machine with a long PATH turns "not found" into
       * a wall of identical lines, which is exactly the sort of output people
       * learn to skip. */
      const shown = candidates.slice(0, CANDIDATE_LIMIT)
      lines.push('', '  the name exists, but nothing with it can run:')
      for (const candidate of shown) lines.push(renderCandidate(candidate))
      if (candidates.length > shown.length) {
        lines.push(`        … and ${candidates.length - shown.length} more`)
      }
    }
    return lines.join('\n')
  }

  const lines = [
    `dsh-which · ${command}`,
    `  winner:   ${shortenPath(winner.path, 100)}`,
    `  kind:     ${KIND_LABELS[winner.kind] ?? winner.kind}`,
  ]
  if (winner.directoryIndex >= 0) {
    lines.push(`  from:     PATH[${winner.directoryIndex}]  ${shortenPath(winner.directory, 80)}`)
  } else {
    lines.push(`  from:     given as a path, PATH was not consulted`)
  }
  if (winner.size !== undefined) lines.push(`  size:     ${humanBytes(winner.size)}`)
  if (winner.mtimeMs !== undefined) lines.push(`  modified: ${new Date(winner.mtimeMs).toISOString()}`)

  const probe = options.probe
  if (probe?.winner !== undefined && probe.winner !== null) {
    lines.push(probe.winner.ok === true
      ? `  version:  ${probe.winner.version}  (${probe.winner.flag})`
      : `  version:  unknown — it ${probe.winner.reason}`)
  }
  lines.push(`  searched: ${searched} PATH entr${searched === 1 ? 'y' : 'ies'}`)

  const groups = shadowGroups(resolution)
  if (groups.length > 0) {
    lines.push('', `  shadowed — ${groups.length} other director${groups.length === 1 ? 'y holds' : 'ies hold'} this name:`)
    /* Same reason as the candidate list: the count is the finding, the
     * enumeration is the evidence. Past a handful of directories the evidence
     * stops being read, so it is summarised instead of dumped. */
    for (const group of groups.slice(0, SHADOW_GROUP_LIMIT)) {
      /* One candidate per directory is the common case, and there the whole
       * line can carry the path, which is what a reader wants to copy. Only a
       * directory holding several candidates for one name (`node.exe` next to
       * `node.cmd`) needs the header-then-list shape. */
      if (group.entries.length === 1) {
        const only = group.entries[0]
        const size = only.size === undefined ? '' : `  ${humanBytes(only.size)}`
        const label = KIND_LABELS[only.kind] ?? only.kind
        lines.push(`    PATH[${group.directoryIndex}]  ${shortenPath(only.path, 84)}  ${label}${size}`)
      } else {
        lines.push(`    PATH[${group.directoryIndex}]  ${shortenPath(group.directory, 80)}`)
        for (const candidate of group.entries.slice(0, CANDIDATE_LIMIT)) lines.push(renderCandidate(candidate))
        if (group.entries.length > CANDIDATE_LIMIT) {
          lines.push(`        … and ${group.entries.length - CANDIDATE_LIMIT} more here`)
        }
      }
      const probed = probe?.shadowed?.find((entry) => entry.candidate.path === group.entries[0].path)
      if (probed !== undefined) {
        lines.push(probed.probe.ok === true
          ? `      ↳ reports ${probed.probe.version}`
          : `      ↳ ${probed.probe.reason}`)
      }
    }
    if (groups.length > SHADOW_GROUP_LIMIT) {
      lines.push(`    … and ${groups.length - SHADOW_GROUP_LIMIT} more directories`)
    }
    const first = groups[0].entries[0]
    if (winner.size !== undefined && looksDivergent(winner, first)) {
      lines.push('', `  The winner and the shadowed copy differ in size, so they are not the same build.`)
    }
  }

  if (probe?.divergent === true) {
    lines.push('', `  ⚠ the copies behind this name report different versions — the one that runs is the one at PATH[${winner.directoryIndex}].`)
  }
  if (typeof options.note === 'string' && options.note !== '') lines.push('', `  ${options.note}`)
  return lines.join('\n')
}

/**
 * Render a PATH analysis: the findings first, then the entries.
 *
 * @param {object} analysis - an analysis from `analyzePath`.
 * @param {{ raw?: string, limit?: number, showNoise?: boolean }} [options] - rendering options.
 * @returns {string} report text.
 */
export function renderPath(analysis, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 40
  const findings = []
  if (analysis.duplicates > 0) findings.push(`${analysis.duplicates} duplicate entr${analysis.duplicates === 1 ? 'y' : 'ies'}`)
  if (analysis.dead > 0) findings.push(`${analysis.dead} dead entr${analysis.dead === 1 ? 'y' : 'ies'}`)
  if (analysis.unresolved > 0) findings.push(`${analysis.unresolved} entr${analysis.unresolved === 1 ? 'y' : 'ies'} with an unexpanded variable`)

  const lines = [
    `dsh-which · PATH`,
    `  ${analysis.entries.length} entries · ${analysis.uniqueDirectories} unique director${analysis.uniqueDirectories === 1 ? 'y' : 'ies'}`,
  ]
  lines.push(findings.length === 0
    ? `  no duplicates, no dead entries, nothing unexpanded`
    : `  ${findings.join(' · ')}`)

  const shown = analysis.entries
    .filter((entry) => options.showNoise === true || !entry.noise)
    .slice(0, limit)

  if (shown.length > 0) {
    lines.push('', '  entries, in resolution order:')
    for (const entry of shown) {
      const marks = []
      if (entry.duplicateOf !== null) marks.push(`dup of [${entry.duplicateOf}]`)
      if (!entry.exists) marks.push('missing')
      if (entry.unresolved.length > 0) marks.push(`unexpanded ${entry.unresolved.join(', ')}`)
      const suffix = marks.length === 0 ? '' : `  — ${marks.join('; ')}`
      lines.push(`    [${String(entry.index).padStart(2)}] ${shortenPath(entry.path, 84)}${suffix}`)
    }
  }

  const hidden = analysis.entries.length - shown.length
  if (hidden > 0) lines.push(`    … and ${hidden} more`)

  if (analysis.duplicates > 0) {
    lines.push('', '  Duplicates are usually an installer that prepends itself on every run. Harmless until you edit "the" entry and two copies of it remain.')
  }
  if (analysis.dead > 0) {
    lines.push('', '  Dead entries are skipped silently by every shell, so an uninstalled toolchain leaves a hole that only shows up when its command fails.')
  }
  return lines.join('\n')
}

/**
 * Render a version comparison across every copy of a name.
 *
 * @param {string} command - the command name.
 * @param {object} probe - a probe outcome.
 * @returns {string} report text.
 */
export function renderProbe(command, probe) {
  const lines = [`dsh-which · ${command} · version probe`]
  if (probe.winner === null) {
    lines.push('  nothing to probe: the command did not resolve')
    return lines.join('\n')
  }
  lines.push(probe.winner.ok === true
    ? `  winner:   ${probe.winner.version}`
    : `  winner:   unknown — it ${probe.winner.reason}`)
  for (const entry of probe.shadowed) {
    const label = shortenPath(entry.candidate.path, 84)
    lines.push(entry.probe.ok === true
      ? `  shadowed: ${entry.probe.version}  (${label})`
      : `  shadowed: ${entry.probe.reason}  (${label})`)
  }
  if (probe.divergent) {
    lines.push('', '  The copies report different versions. Whatever produced the other version is still installed and still on PATH.')
  } else if (probe.shadowed.length > 0) {
    lines.push('', '  Every copy that answered reports the same version.')
  }
  return lines.join('\n')
}

/**
 * Render a sweep: the commands in a directory that resolve elsewhere.
 *
 * @param {string} directory - the directory that was swept.
 * @param {object[]} rows - one row per command.
 * @param {{ now?: number, limit?: number }} [options] - rendering options.
 * @returns {string} report text.
 */
export function renderSweep(directory, rows, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 60
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const lines = [`dsh-which · sweep ${shortenPath(directory, 80)}`, `  ${rows.length} command(s)`]
  const hijacked = rows.filter((row) => row.winner !== undefined && row.shadowedBy !== undefined)
  const broken = rows.filter((row) => row.winner === undefined)

  if (hijacked.length > 0) lines.push(`  ${hijacked.length} resolve outside this directory (shown with ↪)`)
  if (broken.length > 0) lines.push(`  ${broken.length} do not resolve at all`)

  if (rows.length === 0) {
    lines.push('', '  nothing here looks like a command')
    return lines.join('\n')
  }

  lines.push('')
  for (const row of rows.slice(0, limit)) {
    if (row.winner === undefined) {
      lines.push(`  ✗ ${row.name}  does not resolve`)
    } else if (row.shadowedBy !== undefined) {
      lines.push(`  ↪ ${row.name}  → ${shortenPath(row.winner, 72)}`)
    } else {
      lines.push(`  · ${row.name}  ${shortenPath(row.winner, 72)}`)
    }
  }
  if (rows.length > limit) lines.push(`  … and ${rows.length - limit} more`)

  if (hijacked.length > 0) {
    lines.push('', '  A ↪ means a copy in this directory is not the one that runs: something earlier on PATH wins. That is the usual reason a script behaves differently when called from elsewhere.')
  }
  return lines.join('\n')
}

/**
 * Render a full environment report.
 *
 * @param {object} report - the report from the plugin.
 * @param {{ limit?: number }} [options] - rendering options.
 * @returns {string} report text.
 */
export function renderEnv(report, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 30
  const lines = [
    `dsh-which · environment`,
    `  platform: ${report.platform}  arch ${report.arch}  node ${report.node}`,
    `  shell:    ${report.shell}${report.shellPath === undefined ? '' : `  (${shortenPath(report.shellPath, 70)})`}`,
    `  cwd:      ${shortenPath(report.cwd, 80)}`,
    `  PATH:     ${report.path.entries.length} entries · ${report.path.uniqueDirectories} unique`,
  ]
  const findings = []
  if (report.path.duplicates > 0) findings.push(`${report.path.duplicates} duplicate`)
  if (report.path.dead > 0) findings.push(`${report.path.dead} dead`)
  if (report.path.unresolved > 0) findings.push(`${report.path.unresolved} unexpanded`)
  if (findings.length > 0) lines.push(`            ${findings.join(' · ')}`)

  if (report.pathext !== undefined) {
    lines.push(`  PATHEXT:  ${report.pathext.join(' ')}`)
  }
  lines.push('', '  resolved runtimes:')
  if (report.runtimes.length === 0) {
    lines.push('    none of the common runtimes are on PATH')
  }
  for (const runtime of report.runtimes.slice(0, limit)) {
    lines.push(runtime.winner === undefined
      ? `    ✗ ${runtime.name}  not found`
      : `    · ${runtime.name}  ${shortenPath(runtime.winner, 68)}${runtime.version === undefined ? '' : `  ${runtime.version}`}`)
  }

  const diverging = report.runtimes.filter((runtime) => runtime.shadowCount > 0)
  if (diverging.length > 0) {
    lines.push('', `  ${diverging.length} runtime(s) exist in more than one place on PATH: ${diverging.map((runtime) => runtime.name).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Render a problem.
 *
 * @param {string} subject - what was being done.
 * @param {string} message - the problem.
 * @returns {string} report text.
 */
export function renderProblem(subject, message) {
  return `dsh-which · ${subject}\n  ${message}`
}

export { humanAge, humanBytes, shortenPath }
