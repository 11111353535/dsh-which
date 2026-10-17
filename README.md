# dsh-which

**Command resolution forensics for DeepSeek Harness.** When you type `node`, a shell answers with a rule that is longer than people remember — PATH order, then PATHEXT on Windows or the executable bit elsewhere, with builtins short-circuiting the whole thing. `dsh-which` reports what that rule actually decided, what it shadowed, what shape PATH itself is in, and whether the copies behind one name agree on a version.

Every failure it names is silent. The command runs; it is just not the one you meant.

```
dsh-which · node
  winner:   C:\Program Files\nodejs\node.EXE
  kind:     native binary
  from:     PATH[0]  C:\Program Files\nodejs
  size:     84MB
  modified: 2025-11-03T09:14:00.000Z
  version:  v24.13.0  (--version)
  searched: 9 PATH entries

  shadowed — 1 other directory holds this name:
    PATH[6]  C:\Users\me\scoop\shims\node.EXE  native binary  84MB
      ↳ reports v20.11.1

  ⚠ the copies behind this name report different versions — the one that runs is the one at PATH[0].
```

That last block is the whole reason this exists. Two Node installations, one on PATH, and nothing anywhere tells you which one a command gets.

## Why not just run `which`

1. **`which` does not exist on Windows**, and where it does exist it answers a narrower question. It reports the file it found; it does not report the file it skipped.
2. **`which` inherits the rules under investigation.** Shelling out to a resolver to explain resolution means trusting the resolver you are debugging. The rules here are reimplemented as pure functions over an injected filesystem (`lib/resolve.js`), so they are testable against fixtures instead of against whatever is installed on the test machine.
3. **Shell builtins are not files.** `which cd` on most systems walks every PATH entry to report something that has nothing to do with what runs. This plugin says `builtin` and explains that PATH was never consulted.
4. **The interesting output is the shadowed copy.** "What runs" is one line. "What else answers to this name, and why is it not running" is the diagnosis — a stale global install behind a fresh local one, a `.cmd` shim in front of a real binary, a file that exists but was never made executable.
5. **Reporting is the whole job.** There is no PATH-editing tool here. A plugin that silently rewrites PATH is a plugin that breaks a machine.

## Install

```sh
dsh plugin add https://github.com/11111353535/dsh-which
```

From a checkout instead of a git host, pass the absolute path:

```sh
dsh plugin add /absolute/path/to/dsh-which
```

Optional configuration, in the profile's `cordis.patch.yml`:

```yaml
- id: which
  name: 'dsh-which'
  config:
    probeByDefault: false        # run a version probe on every resolve
    probeShadowedByDefault: false # probe the shadowed copies too
    probeTimeoutMs: 4000
    maxSweepFiles: 400
    runtimes: [node, npm, pnpm, python, git]
```

| key | default | what it does |
| --- | --- | --- |
| `probeTimeoutMs` | `4000` | How long a version probe may take before it is abandoned. |
| `probeByDefault` | `false` | Probe every resolve without being asked. Slower, explains more. |
| `probeShadowedByDefault` | `false` | Probe the shadowed copies too. Multiplies the process spawns. |
| `maxSweepFiles` | `400` | Files examined in one sweep, so a huge directory cannot stall a session. |
| `runtimes` | node, npm, pnpm, yarn, bun, python, python3, pip, pip3, uv, git, rg, fd, make, pwsh, bash | Commands the environment report resolves. |

Probing is off by default because it spawns processes, and a diagnostic that costs four seconds on every call is a diagnostic people turn off.

## Tools

### `which_resolve`

Resolve one command and report what runs, what it shadowed, and — on request — what each copy reports as its version.

| parameter | type | |
| --- | --- | --- |
| `command` | string, **required** | A name (`node`) or a path (`./build.sh`, `C:\tools\x.exe`). |
| `probe` | boolean | Run the winner with a version flag. |
| `probeShadowed` | boolean | Probe the shadowed copies too, so versions can be compared. |

A name that resolves to nothing is an answer, not an error:

```
dsh-which · build
  not found
  the name exists on PATH but nothing with that name is runnable
  searched: 45 PATH entries

  the name exists, but nothing with it can run:
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        build  not runnable  1KB
        … and 37 more
```

The count is the finding; the enumeration is the evidence, and past eight directories the evidence stops being read. The lines that save an hour are the second and third: the name *is* on PATH, the file simply cannot run. On POSIX that means no executable bit — a shell walks right past it into later PATH entries, or fails.

An explicit path never consults PATH, and the report says so:

```
dsh-which · /repo/scripts/build.sh
  winner:   /repo/scripts/build.sh
  kind:     script
  from:     given as a path, PATH was not consulted
  size:     2.3KB
  searched: 0 PATH entries
```

### `which_path`

The shape of PATH itself: every entry in resolution order, with duplicates, entries whose directory is gone, and entries containing an unexpanded variable.

| parameter | type | |
| --- | --- | --- |
| `showNoise` | boolean | Include `/usr/bin`, `/bin` and friends, omitted by default as uninformative. |
| `limit` | number | Maximum entries listed. Defaults to 40. |

```
dsh-which · PATH
  9 entries · 8 unique directories
  1 duplicate entry · 1 dead entry

  entries, in resolution order:
    [ 0] C:\Program Files\nodejs
    [ 1] C:\Users\me\AppData\Roaming\npm
    [ 2] C:\Windows\system32
    [ 3] C:\Windows
    [ 4] C:\tools\git\cmd
    [ 5] C:\Program Files\nodejs  — dup of [0]
    [ 6] C:\Users\me\scoop\shims
    [ 7] D:\old-python\Scripts  — missing
    [ 8] C:\Users\me\bin

  Duplicates are usually an installer that prepends itself on every run. Harmless until you edit "the" entry and two copies of it remain.

  Dead entries are skipped silently by every shell, so an uninstalled toolchain leaves a hole that only shows up when its command fails.
```

A dead entry is invisible by construction: shells skip it without a word, so the hole only surfaces later as "command not found" for something that was there yesterday. An unexpanded `%USERPROFILE%` is worse — it can never resolve, no matter what the variable is set to.

### `which_env`

One page describing the command environment: platform, shell, working directory, PATH findings, PATHEXT, and where each common runtime resolves from.

| parameter | type | |
| --- | --- | --- |
| `limit` | number | Maximum runtimes listed. Defaults to 30. |

```
dsh-which · environment
  platform: win32  arch x64  node v24.13.0
  shell:    pwsh.exe  (C:\Program Files\PowerShell\7\pwsh.exe)
  cwd:      C:\repo
  PATH:     9 entries · 8 unique
            1 duplicate · 1 dead
  PATHEXT:  .COM .EXE .BAT .CMD

  resolved runtimes:
    · node  C:\Program Files\nodejs\node.EXE
    · npm  C:\Program Files\nodejs\npm.CMD
    · pnpm  C:\Users\me\AppData\Roaming\npm\pnpm.CMD
    · git  C:\tools\git\cmd\git.EXE
    ✗ python  not found

  1 runtime(s) exist in more than one place on PATH: node
```

The shell line matters more than it looks. `pwsh` and `cmd` disagree about builtins and about `.ps1`, so a report that names the wrong shell is a report nobody should trust.

### `which_sweep`

Sweep a directory of scripts and report, for each name that looks like a command, whether the copy in *that* directory is the one that would run.

| parameter | type | |
| --- | --- | --- |
| `directory` | string, **required** | Absolute, or relative to the workspace. |
| `limit` | number | Maximum rows listed. Defaults to 60. |

```
dsh-which · sweep C:\repo\scripts
  3 command(s)
  1 resolve outside this directory (shown with ↪)
  1 do not resolve at all

  ↪ build.cmd  → C:\tools\build\build.cmd
  · deploy.cmd  C:\repo\scripts\deploy.cmd
  ✗ smoke.cmd  does not resolve

  A ↪ means a copy in this directory is not the one that runs: something earlier on PATH wins. That is the usual reason a script behaves differently when called from elsewhere.
```

`./build` and `build` are different programs and nothing warns you. That is the question this answers.

### `which_probe`

Run every copy of a name that resolution can find with a version flag, and report whether they agree.

| parameter | type | |
| --- | --- | --- |
| `command` | string, **required** | Command name to probe. |

```
dsh-which · node · version probe
  winner:   v24.13.0
  shadowed: v20.11.1  (C:\Users\me\scoop\shims\node.EXE)

  The copies report different versions. Whatever produced the other version is still installed and still on PATH.
```

Only a known version flag, only files resolution already picked, a four-second timeout, and 8 KB of output per probe. This is not a general command runner.

## Slash command

```
/which              # the environment report
/which node         # what runs
/which node --probe # and what it says its version is
/which --path       # the shape of PATH
/which --env        # the environment report
/which --sweep .    # scripts here that resolve elsewhere
```

## Behaviour

- **Resolution is reimplemented, not shelled out.** The rules live in pure functions over an injected filesystem, so they are tested against fixtures rather than against the machine running the tests.
- **A repeated PATH entry does not double-count a file.** Duplicates are reported by `which_path`; the candidate list answers "how many distinct files carry this name".
- **POSIX skips files that cannot run.** A file with the right name and no executable bit is walked past, and the search continues into later entries — which is what a shell does, and what a listing tool hides.
- **Windows PATHEXT order is honoured.** `.EXE` before `.CMD` means `npm` and `npm.cmd` can be different programs, and an explicit extension is tried before PATHEXT is walked at all.
- **Builtins are not files.** `cd`, `echo`, `dir`, `copy` are answered by the shell; PATH is never consulted.
- **Probing never throws.** A program that hangs, exits non-zero, or does not understand the flag is a result with a reason, not an error. `java -version` exits non-zero and is handled.
- **Nothing is modified.** No PATH editing, no file writes, no environment changes. Reporting is the whole job.
- **The optional workspace service is optional.** Without a workspace registry, relative paths resolve against the process directory; nothing else changes.

## Development

```sh
npm run setup:deps   # link the host's @deepseek-ai/* packages into ./node_modules
npm test             # 88 unit and seam tests
npm run test:live    # 11 checks against the real machine
node test/samples.mjs # regenerate the examples above from the plugin's own renderers
```

The unit tests drive pure modules with a fixture filesystem; the live check runs against the real PATH, the real PATHEXT and a real `node --version`, because that is the one thing fixtures cannot prove. The samples script renders the README examples from a fixed fixture with the plugin's own renderers, so an example cannot drift from the code without the regeneration showing it.

Module layout: `pathlist.js` (PATH itself), `resolve.js` (the rules), `probe.js` (version comparison), `format.js` (rendering), `units.js` (sizes and ages), `host.js` (the only module that touches the real filesystem and environment), `index.js` (tools and command).

## License

MIT
