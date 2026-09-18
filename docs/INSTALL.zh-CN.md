# uco 离线安装与使用指南

> 本指南面向收到 `uco-<version>.tgz` 离线安装包的用户。整个安装过程**无需联网**，不依赖 npm 仓库、OpenUPM 或任何 Git 仓库。

## 1. uco 是什么

uco 是 Unity 的命令行副驾驶。它让你（或任意 AI 编程助手）通过普通 shell 命令驱动 Unity，覆盖两个层面：

- **编辑器 / 项目生命周期**：安装 Unity、创建项目、构建、测试等。
- **对运行中 Unity 编辑器的实时自动化**：通过纯 REST 查询工具、执行脚本、读写场景与对象。

特点：AI 只需调用 shell 命令，保持 agent 接口精简；运行时走纯 REST（`POST /api/tools/{name}`），由 Unity 插件启动的本地工具服务器承接。

## 2. 你会收到什么

一个自包含的 `uco-<version>.tgz`，内含：

| 组成 | 说明 |
|---|---|
| uco CLI | 命令行程序本体（已编译） |
| npm 依赖 | chalk / commander / kleur / yocto-spinner，已内置，安装时不再联网 |
| Node 工具服务器 | 已编译的 Node.js 服务器，跨平台，由 Unity 插件自动拉起 |
| NuGet DLL | Unity 插件运行所需的依赖库 |
| Unity 插件源 | `com.atelierai.unity.copilot`（Unity Copilot 插件） |

## 3. 环境要求

- **操作系统**：Windows / macOS / Linux（服务器为 Node.js，天然跨平台）
- **Node.js**：20 或更高（安装与运行时服务器都需要）
- **Unity**：2022.3 或更高
- 不需要 .NET SDK、Visual Studio 或任何 C++ 编译环境

检查 Node：

```bash
node --version    # 应显示 v20 或更高
```

## 4. 安装步骤

### 4.1 安装 uco 命令

```bash
npm install -g @atelierai/uco-<version>.tgz
```

完全离线，依赖已内置。完成后 `uco` 命令全局可用，验证：

```bash
uco --version
uco --help
```

### 4.2 让 AI 编程助手认识 uco（可选但推荐）

如果你打算让 AI 编程助手（默认 Claude Code）通过 uco 驱动 Unity，先把 uco 的 Skills 装进助手的 skills 目录。这是打破"鸡生蛋"的引导步骤——在还没有任何 Unity 项目、没有运行中的服务器之前，让助手先掌握 uco 的命令面。

```bash
uco init                            # 把三个 uco Skills 装进 ./.claude/skills（Claude Code）
# uco init <目录>                   # 指定别的工作目录
# uco init --agent codex            # 用别的助手的 skills 目录（codex 为 .codex/skills）
# uco init --agent claude-code,cursor  # 一次给多个助手安装
# uco init --list                   # 查看所有支持的助手（含检测路径）
```

不带 `--agent` 时，init 会自己挑助手集合：交互式终端下弹出编号多选（直接回车接受预选项），非交互模式下安装目标处已检测到的所有助手目录（都没有则回退 Claude Code）。

装完后**重启助手会话**——Claude Code 在启动时扫描 skills 目录。此后助手就能自行驱动整条流程：`uco install-unity` → `uco create-project` → `uco install` → `uco open` → `uco setup-skills`。

`uco init` 写入的是静态 Skill 模板，ownership manifest 与 `uco setup-skills` 一致，所以后续接入项目后跑 `setup-skills`（编译 live 工具目录，需要运行中的 Editor）会原地刷新这些 skill。重复运行 `uco init` 是安全的无操作。

每次成功安装都会记录到 `.uco/install-manifest.json`（选中的助手、各自的 skills 路径、以及是否安装过 Unity 工具链）。用更小的 `--agent` 集合重跑 `uco init` 会移除被取消选中助手的 uco 自有 skill 目录——绝不碰用户文件。

### 4.2.1 升级已安装目标

升级 uco 包本身之后（`npm i -g @atelierai/uco@latest`），用一条命令刷新 uco 装进目标的所有内容：

```bash
uco update [目标目录]               # 默认：当前目录
# uco update --dry-run              # 只打印计划改动，不写入
# uco update --force                # 即使内容一致也重新生成所有已记录助手
# uco update --skip-unity           # 不动 Unity 插件包与 NuGet DLL
```

`uco update` 依照 install manifest 刷新：每个已安装助手的 Skills 和共享的 `.uco/agent-runtime`（按内容差异驱动——无需运行中的 Unity Editor，且 `setup-skills` 产出的 live 工具目录不会被回退）；对 bundle 来源的安装，把 Unity 插件包与 NuGet DLL 作为**一套匹配集**整体重刷（旧 DLL 导致的 CS0246 编译错误不可能经 uco 发生）。命令幂等——紧接着再跑一次会输出 `Already up to date.`；绝不会自动安装未记录的助手（新检测到的助手目录只以提示形式出现，指向 `uco init --agent <id>`）。早于 manifest 的存量安装会在首次 update 时自动迁移。

### 4.3 接入一个 Unity 项目

把 uco 运行时（插件 + 依赖库 + 配置）装进你的 Unity 项目：

```bash
uco install "D:\YourUnityProject"
```

该命令幂等，可重复运行。它会：

- 把插件源嵌入项目 `Packages/com.atelierai.unity.copilot/`
- 拷贝 NuGet DLL 到 `Assets/Plugins/NuGet/`
- 写入初始配置 `UserSettings/uco-config.json`（含端口与随机 token）

服务器本体不在项目内暂存——Unity 插件首次启动时会自动拉起 Node 服务器。

想先看清会做哪些改动而不实际写入，加 `--dry-run`：

```bash
uco install "D:\YourUnityProject" --dry-run
```

### 4.4 启动 Unity 并验证连通

1. 用 Unity Hub 打开该项目一次（首次会编译插件脚本，请等待编译完成）。
2. 插件会自动启动本地工具服务器。
3. 在**项目目录**下验证桥接是否打通：

```bash
cd "D:\YourUnityProject"
uco ping
```

看到响应即表示 REST 桥已通，可以开始自动化操作了。

## 5. 常用命令速查

| 命令 | 作用 | 需要运行中的 Unity？ |
|---|---|:---:|
| `uco install <项目>` | 一次性接入运行时 | 否 |
| `uco ping` | 探活 REST 桥 | 是 |
| `uco list` | 列出可用工具 | 是 |
| `uco call <工具> --args '{...}'` | 调用某个工具 | 是 |
| `uco exec --code '<C# 代码>'` | 在编辑器内执行 C# 代码片段 | 是 |
| `uco install-unity` | 安装 Unity 编辑器 / 官方 CLI | 否 |
| `uco create-project <路径>` | 创建新 Unity 项目 | 否 |
| `uco editors` | 查看已安装编辑器 | 否 |
| `uco build <项目>` | 批量构建 | 否 |
| `uco test <项目>` | 批量测试 | 否 |

完整命令列表：`uco --help`；某条命令的详细选项：`uco <命令> --help`。

## 6. 配合 AI 编程助手

uco 的设计就是让 AI 调用。在项目里生成 AI skills 文件，注册到你的 agent（如 Claude Code），agent 即可通过 shell 命令驱动 Unity：

```bash
uco setup-skills "D:\YourUnityProject"
```

详见 `uco setup-skills --help`。

## 7. 常见问题

**`uco ping` 不通**

- 确认 Unity 编辑器已打开该项目，且脚本编译已完成。
- 端口与 token 存放在 `UserSettings/uco-config.json`；端口由项目路径确定性生成。务必在**项目目录**下运行 ping，或用 `--url` / `--token` 显式指定。

**想接入另一个项目**
直接对新项目再跑一次 `uco install <新项目>`，各项目互不影响。

**卸载 uco**

```bash
npm uninstall -g uco
```

已用 embed 模式接入的 Unity 项目自带插件源副本，卸载 uco 不影响这些项目。

## 8. 限制

- **目标机需装有 Node.js 20+**：服务器以 Node 进程运行（编译后的 JS，非内嵌运行时）。
- **NuGet DLL 为打包时的快照**：功能完整，但不一定包含最新源码改动。

---

*如遇本指南未覆盖的问题，请联系分发者。*
