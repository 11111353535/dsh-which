# dsh-which

**DeepSeek Harness 的命令解析取证。** 你在终端敲 `node`，shell 给出的答案遵循一条比多数人记得住的规则更长的规则：先按 PATH 顺序找，Windows 上再按 PATHEXT，其他平台看可执行位，而内建命令会把这一切短路掉。`dsh-which` 报告这条规则到底判了什么、它遮蔽了谁、PATH 本身是什么形状，以及同一个名字背后的几份副本报的版本是否一致。

它点名的每一种失败都是静默的：命令跑起来了，只是不是你想要的哪一个。

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

最后那一段就是它存在的全部理由。两套 Node 装在机器上，一套在 PATH 里，而没有任何地方会告诉你一条命令拿到的是哪一套。

## 为什么不是直接用 `which`

1. **Windows 上根本没有 `which`**；有它的地方，它回答的也是一个更窄的问题——它报告找到了哪个文件，不报告它跳过了哪个文件。
2. **`which` 继承的正是你要查的那套规则。** 为了解释解析过程而调起一个解析器，等于信任你正在调试的那个东西。这里的规则被重写成跑在注入式文件系统上的纯函数（`lib/resolve.js`），因此可以拿固定夹具测试，而不是拿跑测试那台机器上碰巧装了什么来测。
3. **内建命令不是文件。** 多数系统上 `which cd` 会把每个 PATH 条目走一遍，最后报告一个跟实际运行毫无关系的文件。这个插件说 `builtin`，并说明 PATH 从未参与。
4. **真正有价值的输出是被遮蔽的那份。** 「哪个在跑」只是一行；「这个名字还存在于哪里、它为什么不跑」才是诊断——旧的全局安装挡在新的本地安装后面、`.cmd` shim 挡在真二进制前面、文件存在但从来没有被赋予可执行位。
5. **报告就是全部工作。** 这里没有任何编辑 PATH 的工具。一个偷偷改写 PATH 的插件，就是一个会把机器搞坏的插件。

## 安装

```sh
dsh plugin add https://github.com/11111353535/dsh-which
```

想从本地检出装，就直接给绝对路径：

```sh
dsh plugin add /absolute/path/to/dsh-which
```

可选配置，写在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: which
  name: 'dsh-which'
  config:
    probeByDefault: false         # 每次解析都跑一次版本探测
    probeShadowedByDefault: false # 被遮蔽的副本也探
    probeTimeoutMs: 4000
    maxSweepFiles: 400
    runtimes: [node, npm, pnpm, python, git]
```

| 配置键 | 默认 | 作用 |
| --- | --- | --- |
| `probeTimeoutMs` | `4000` | 一次版本探测最多等多久。 |
| `probeByDefault` | `false` | 不等人开口，每次解析都探测。更慢，但解释得更多。 |
| `probeShadowedByDefault` | `false` | 被遮蔽的副本也探测。进程数会翻倍。 |
| `maxSweepFiles` | `400` | 一次扫描最多看多少个文件，免得大目录把会话卡住。 |
| `runtimes` | node、npm、pnpm、yarn、bun、python、python3、pip、pip3、uv、git、rg、fd、make、pwsh、bash | 环境报告要去解析的命令。 |

探测默认关闭，因为它要起进程；一个每次调用都要四秒钟的诊断工具，最后一定会被人关掉。

## 工具

### `which_resolve`

解析一条命令，报告哪个在跑、它遮蔽了谁，以及（按需）每一份副本自己报的版本。

| 参数 | 类型 | |
| --- | --- | --- |
| `command` | string，**必填** | 名字（`node`）或路径（`./build.sh`、`C:\tools\x.exe`）。 |
| `probe` | boolean | 用版本旗标跑一下胜出者。 |
| `probeShadowed` | boolean | 被遮蔽的副本也探，这样才能比版本。 |

解析不到名字是一个答案，不是错误：

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

数量是结论，罗列是证据，而超过八个目录之后证据就没人读了。真正能省下一小时的是第二、三行：这个名字**确实**在 PATH 上，文件只是跑不了。在 POSIX 上这意味着没有可执行位——shell 会径直走过它，继续往后面的 PATH 条目里找，或者干脆失败。

显式路径从不查 PATH，报告会明说：

```
dsh-which · /repo/scripts/build.sh
  winner:   /repo/scripts/build.sh
  kind:     script
  from:     given as a path, PATH was not consulted
  size:     2.3KB
  searched: 0 PATH entries
```

### `which_path`

PATH 本身的形状：按解析顺序列出每一条，标出重复的、目录已经没了的、以及含有永远展不开的变量的那些。

| 参数 | 类型 | |
| --- | --- | --- |
| `showNoise` | boolean | 把 `/usr/bin`、`/bin` 之类也列出来，默认省略，因为它们不携带信息。 |
| `limit` | number | 最多列几条。默认 40。 |

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

死条目天生不可见：所有 shell 都会一声不响地跳过它，于是这个洞要等到某天「昨天还在的命令今天找不到」时才浮出水面。没展开的 `%USERPROFILE%` 更糟——无论变量设成什么，它都永远解析不了。

### `which_env`

一页纸说清命令环境：平台、shell、工作目录、PATH 发现的问题、PATHEXT，以及每个常见运行时从哪儿解析到。

| 参数 | 类型 | |
| --- | --- | --- |
| `limit` | number | 最多列几个运行时。默认 30。 |

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

shell 那一行比看上去重要。`pwsh` 和 `cmd` 对内建命令、对 `.ps1` 的处理并不一致，所以一个把 shell 说错的报告，是没人该信的报告。

### `which_sweep`

扫一个装着脚本的目录，对每个看起来像命令的名字，报告**这个目录里**的那份到底是不是会跑的那份。

| 参数 | 类型 | |
| --- | --- | --- |
| `directory` | string，**必填** | 绝对路径，或相对工作区。 |
| `limit` | number | 最多列几行。默认 60。 |

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

`./build` 和 `build` 是两个不同的程序，而没有任何东西会提醒你。这就是它回答的问题。

### `which_probe`

把解析能找到的每一份副本都用版本旗标跑一遍，报告它们是否一致。

| 参数 | 类型 | |
| --- | --- | --- |
| `command` | string，**必填** | 要探测的命令名。 |

```
dsh-which · node · version probe
  winner:   v24.13.0
  shadowed: v20.11.1  (C:\Users\me\scoop\shims\node.EXE)

  The copies report different versions. Whatever produced the other version is still installed and still on PATH.
```

只用已知的版本旗标，只跑解析已经选出来的文件，四秒超时，每次探测最多 8 KB 输出。这不是通用命令执行器。

## 斜杠命令

```
/which              # 环境报告
/which node         # 哪个在跑
/which node --probe # 以及它自称的版本
/which --path       # PATH 的形状
/which --env        # 环境报告
/which --sweep .    # 这个目录里哪些脚本会解析到别处
```

## 行为说明

- **解析是重写的，不是调起 `which`。** 规则是跑在注入式文件系统上的纯函数，因此拿固定夹具测，而不是拿跑测试那台机器测。
- **重复的 PATH 条目不会把同一个文件数两遍。** 重复由 `which_path` 报告；候选列表回答的是另一个问题——有多少个**不同**的文件叫这个名字。
- **POSIX 会跳过跑不了的文件。** 名字对、但没有可执行位的文件会被走过，搜索继续进入后面的条目——这正是 shell 的行为，也正是列目录工具藏起来的部分。
- **Windows 尊重 PATHEXT 顺序。** `.EXE` 排在 `.CMD` 前面，意味着 `npm` 和 `npm.cmd` 可能是两个不同的程序；而显式写了扩展名时，会先试原名，根本不会去走 PATHEXT。
- **内建命令不是文件。** `cd`、`echo`、`dir`、`copy` 由 shell 自己处理，PATH 从不参与。
- **探测永不抛错。** 挂住、非零退出、不认识旗标的程序，都是一个带原因的结果，不是错误。`java -version` 就是非零退出，它被正确处理了。
- **什么都不改。** 不编辑 PATH，不写文件，不动环境变量。报告就是全部工作。
- **可选的工作区服务是可选的。** 没有 workspace registry 时，相对路径按进程目录解析，别的什么都不变。

## 开发

```sh
npm run setup:deps    # 把宿主机的 @deepseek-ai/* 包 link 进 ./node_modules
npm test              # 88 个单测与接缝测试
npm run test:live     # 11 项针对真机的检查
node test/samples.mjs # 用插件自己的渲染函数重新生成本文中的样例
```

单测用固定文件系统驱动纯模块；live 检查跑真实 PATH、真实 PATHEXT 和真实的 `node --version`，因为那恰恰是夹具证明不了的东西。样例脚本用插件自己的渲染函数从固定夹具生成上面那些示例，所以示例不可能与代码脱节而不被发现。

模块划分：`pathlist.js`（PATH 本身）、`resolve.js`（规则）、`probe.js`（版本比对）、`format.js`（渲染）、`units.js`（大小与时长）、`host.js`（唯一触碰真实文件系统与环境的模块）、`index.js`（工具与命令）。

## 许可

MIT
