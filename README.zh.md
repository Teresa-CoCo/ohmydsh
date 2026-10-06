# ohmydsh

ohmydsh 是一个**围绕** DeepSeek Harness（`dsh`）的发行套件（distribution），而不是它的分支（fork）。它在一个未经修改的 dsh 之上只加两样东西：一个 **bundle**，通过补丁为 dsh profile 叠加一层 OMP 能力（人设、推理强度、权限预设和 OMP 工作模式）；以及一个**启动器 CLI**，在同一个共享后端之上，为两个界面管理 dsh profile——默认是终端界面（TUI），另有桌面（Web）界面。所有 dsh 侧的能力都是复用而非重新实现：TUI 来自 `@deepseek-harness-tui/dsh-tui`，桌面界面来自内置的 `@deepseek-ai/dsh-web-app`，agents、tools、sessions 与沙箱来自 `@deepseek-ai/dsh-base`。上游 dsh 版本固定在 `upstream.json` 中，并由 CI 持续跟踪。

更详细的文档：[docs/architecture.md](docs/architecture.md)、
[docs/modes.md](docs/modes.md)、[docs/upstream.md](docs/upstream.md)、
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 一览

| 界面 | Profile | 命令 | 复用的组件 |
|---|---|---|---|
| TUI（默认） | `ohmydsh-tui` | `ohmydsh`（或 `ohmydsh tui`） | `@deepseek-harness-tui/dsh-tui` |
| 桌面（Web） | `ohmydsh-desktop` | `ohmydsh desktop`（或 `ohmydsh web`） | 内置 `@deepseek-ai/dsh-web-app` |
| 两者共用 | — | — | 共享后端 `@deepseek-ai/dsh-base` |

两个界面运行在同一个 `$DSH_HOME` 下，因此共用同一套会话、设置和凭据。

## 安装与快速开始

需要 Node.js `^22.19.0 || >=24.0.0`，以及一个可访问的 `dsh` CLI：位于 `PATH`
上，或通过 `DSH_REAL`（或 `--dsh` 参数）指定。

```sh
npm i -g ohmydsh
```

```sh
ohmydsh           # TUI（默认）
ohmydsh desktop   # 桌面（Web）界面
```

首次运行时，bootstrap 会初始化 `$DSH_HOME/profiles/ohmydsh-tui` 和
`$DSH_HOME/profiles/ohmydsh-desktop`（`$DSH_HOME` 默认为 `~/.dsh`）。传入
`--no-bootstrap` 可跳过 bootstrap。

从代码检出（checkout）直接运行启动器，子命令相同：

```sh
node packages/ohmydsh/bin/ohmydsh.js           # TUI
node packages/ohmydsh/bin/ohmydsh.js desktop   # 桌面
```

## OMP 模式

由 `packages/ohmydsh/modes.json` 生成：

| id | label | 沙箱 | 审批 | 摘要 | 默认 |
|---|---|---|---|---|---|
| `plan` | Plan | `read-only` | `ask` | 以一份可决策的完整计划结束的只读调查。 |  |
| `build` | Build | `workspace-write` | `ask` | 完整的 OMP 编码智能体，运行在工作区之内。 | 是 |
| `yolo` | YOLO | `danger-full-access` | `never` | 完整的 OMP 编码智能体，没有限制、也不弹出询问。 |  |

`--mode <id>` 以生成的 `--patch` 叠加层（overlay）形式应用在 profile 之上。由于
dsh 补丁会整体替换目标行的配置，该叠加层会重新声明全部三个权限预设，并把该模式
对应的预设设为 `defaultPreset`——确切的 YAML 见
[docs/modes.md](docs/modes.md)。`plan` 模式还会在启动时提示会话内的操作：dsh 在
各模式之间保持工具目录（tool catalog）稳定，因此 plan 模式是一个会话内开关——
在会话中按 `/plan`，由只读沙箱支撑。

## 命令行参考

### 命令

| 命令 | 作用 |
|---|---|
| `ohmydsh` / `ohmydsh tui` | 在 `ohmydsh-tui` profile 上启动 TUI 界面。这是默认命令。 |
| `ohmydsh desktop` / `ohmydsh web` | 在 `ohmydsh-desktop` profile 上启动桌面（Web）界面。 |
| `ohmydsh modes [--json]` | 打印 `modes.json` 中的 OMP 模式（`--json` 输出机器可读格式）。 |
| `ohmydsh doctor [--json]` | 诊断报告（`--json` 输出机器可读格式）。检查 Node 版本范围、`upstream.json`、TUI 插件固定版本、`modes.json`、`dsh` 可执行文件及其 `--version` 与固定版本是否一致、两个 profile 是否已登记我们的 bundle，以及对每个已存在的 profile 执行 `dsh --profile <p> --dump-config`（退出码 0、stderr 为空）。它只报告、不修复；任一检查失败时退出码为 1。 |
| `ohmydsh update` | 把两个 profile 刷新到固定的 bundle 版本：先执行仍然缺失的 bootstrap 步骤，然后执行 `dsh plugin --profile <p> update`，并重新添加固定的 bundle。固定版本提升发布后，已有安装即通过该命令跟上，无需手动 bootstrap。 |
| `ohmydsh version` | 打印 ohmydsh 版本，以及固定的 dsh 与 TUI 插件版本。 |
| `ohmydsh help` | 打印用法。 |

### 参数

| 参数 | 作用 |
|---|---|
| `--mode <id>` | 以生成的 `--patch` 叠加层形式，把指定的 OMP 模式应用在 profile 之上。 |
| `--profile <name>` | 使用指定的 dsh profile，而不是界面默认的 profile（TUI 为 `ohmydsh-tui`，桌面为 `ohmydsh-desktop`）。 |
| `--dsh <path>` | 使用指定的 `dsh` CLI。优先级：`--dsh` > `DSH_REAL` > `PATH` 中的 `dsh`。 |
| `--dry-run` | 只打印本次调用将执行的每条命令（形如 `ohmydsh: would run: <argv>`），不执行任何操作。 |
| `--no-bootstrap` | profile 缺失时直接失败，不进行初始化。 |
| `--json` | 为 `modes` 与 `doctor` 输出机器可读格式。 |

### 环境变量

| 变量 | 作用 |
|---|---|
| `OHMYDSH_HOME` | 覆盖 `modes.json` 与 `upstream.json` 的读取根目录；默认取包含本包的代码检出根目录，已安装副本则取包根目录。 |
| `DSH_HOME` | dsh home；默认为 `~/.dsh`，profile 位于 `$DSH_HOME/profiles/<name>`。ohmydsh 只读取它，不会直接写入——它由 `dsh` 拥有。 |
| `DSH_REAL` | 当未提供 `--dsh` 时使用的 `dsh` CLI 路径。 |

退出码：`0` 成功，`1` 检查失败或 bootstrap 失败，`2` 用法错误。启动界面时透传 dsh
进程自身的退出码。

## 上游跟踪

`upstream.json` 固定上游 `dsh`（`@deepseek-ai/dsh`）：channel 为 `latest`，当前版本
`0.2.0-rc.2`；并固定 TUI 插件 `@deepseek-harness-tui/dsh-tui` `0.13.0`，以及
`compat.verified` 兼容记录。`scripts/upstream-sync.mjs` 解析更新的上游版本并重写固定
版本；`scripts/verify-composition.mjs` 组合真实的 dsh 树，并断言我们的行（rows）仍然
存在。在 CI 中，`.github/workflows/upstream-watch.yml` 以 `chore/upstream-<version>`
分支的 pull request 形式提出更新；验证失败时创建 `upstream-break` issue。详见
[docs/upstream.md](docs/upstream.md)。

## 验证

从代码检出运行：

```sh
node --test                                            # 单元测试，无网络
pnpm typecheck                                         # 对 packages/** + scripts/** 运行 tsc checkJs
node scripts/verify-composition.mjs --profile tui      # 真实 dsh，隔离的 DSH_HOME
node scripts/verify-composition.mjs --profile desktop
node scripts/upstream-sync.mjs --check --json          # 需要网络：npm + GitHub
node packages/ohmydsh/bin/ohmydsh.js modes
```

## 仓库结构

```
ohmydsh/
├── .editorconfig
├── .github/workflows/
│   ├── ci.yml
│   ├── release.yml
│   └── upstream-watch.yml
├── .gitignore
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh.md
├── docs/
│   ├── architecture.md
│   ├── contracts.md
│   ├── modes.md
│   └── upstream.md
├── packages/ohmydsh/
│   ├── bin/                 # 启动器入口：bin/ohmydsh.js
│   ├── presets/             # presets/omp.patch.yml（OMP agent preset）
│   ├── src/                 # 启动器模块
│   ├── tests/
│   ├── cordis.patch.yml     # OMP 层补丁
│   ├── modes.json           # OMP 模式的唯一事实来源
│   ├── package.json         # bin、exports、dsh.bundle.patch
│   └── README.md
├── package.json
├── pnpm-workspace.yaml
├── scripts/
│   ├── lib/
│   ├── upstream-sync.mjs
│   └── verify-composition.mjs
├── tsconfig.json
└── upstream.json
```

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。预设组合改编自 MIT 许可的上游
`packages/bundle/web-app/presets/*.patch.yml`；TUI 插件
（`@deepseek-harness-tui/dsh-tui`）版权归其各自作者所有。
