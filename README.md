# AI CLI 上报工具

一键开通团队的 Claude Code / Codex CLI / Gemini CLI 使用数据上报。

## 前置条件

安装前需先配置全局 git 邮箱（用作上报的用户标识）。未配置时安装会直接报错退出：

```bash
git config --global user.email "you@example.com"
git config --global user.name "你的名字"
```

## 安装

```bash
npx -y ai-otel-setup url=你的服务器地址
```

> 国内网络慢可以临时切到淘宝镜像：`npm config set registry https://registry.npmmirror.com`，再执行上面的命令。
>
> 兼容旧命令：`npx -y cc-otel-installer url=...` 仍然可用，行为完全一致。

把 `你的服务器地址` 替换成团队提供的实际地址（例如 `url=10.20.30.40`）。具体地址请向团队负责人索取。

装好后直接运行 `claude` / `codex` / `gemini`，上报会自动开始，无需任何额外配置。检测到哪个 CLI 就装哪个；没装的会自动跳过。

## 参数

| 参数 | 说明 |
|---|---|
| `url`（必填） | 服务器地址。可填 IP / 域名，或完整地址。裸 IP 会按本地测试规则生成 `http://IP:4317`；裸域名会按生产规则生成 `https://域名:24317`。不能包含空格或逗号。 |
| `--http` / `http=1` | Claude Code 原生 OTel 使用 OTLP/HTTP。默认使用此模式，logs 指向 `/v1/logs`，metrics 指向 `/v1/metrics`。 |
| `--grpc` / `grpc=1` | 强制 Claude Code 原生 OTel 使用 gRPC，作为 HTTP 上报异常时的 fallback。 |

## 装好后会做什么

按检测到的 CLI 分别写入配置（备份均为同名 `.bak`，每次覆盖只保留上一份）：

| 工具 | 改动 |
|---|---|
| Claude Code | 在 `~/.claude/cc-otel/` 放启动脚本；备份 `~/.claude/settings.json` 到 `settings.json.bak`，写入 OTel env、`SessionStart` 与 `UserPromptSubmit` 两个 hook（后者是兜底，救 SessionStart 漏发的场景），并把 collector 地址追加进 `NO_PROXY` 以绕过本地代理 |
| Codex CLI | 在 `~/.codex/ai-otel/` 放启动脚本；备份 `~/.codex/config.toml` 到 `config.toml.bak`，在 `# >>> ai-otel-setup managed >>>` 标记块内写入 `[otel]` 与 SessionStart hook |
| Gemini CLI | 在 `~/.gemini/ai-otel/` 放启动脚本；备份 `~/.gemini/settings.json` 到 `settings.json.bak`，写入 `telemetry` 与 SessionStart hook |

安装时还会发一条注册记录（git 邮箱 / 姓名、机器名、OS、Node 版本）到 collector，用于识别装机情况。

你原本的其他设置都会保留；重复运行不会产生重复条目（按 hook id 与 managed 标记块去重），可以放心重装。安装的版本不会自动升级，需要更新时重跑安装命令即可。

## 本地日志

安装后会在本机写入排查日志，只保留最近 3 天数据：

| 工具 | 日志路径 |
|---|---|
| Claude Code | `~/.claude/cc-otel/ai-otel.log` |
| Codex CLI | `~/.codex/ai-otel/ai-otel.log` |
| Gemini CLI | `~/.gemini/ai-otel/ai-otel.log` |

## 采集了哪些数据

|  | 内容 |
|---|---|
| ✅ 会采集 | 调用了哪些工具、每次耗时、是否成功、token 用量、当前目录、Git 信息；安装时另上报一次 git 邮箱/姓名、机器名、OS、Node 版本 |
| ❌ 不采集 | 你输入的提示词、代码正文、工具入参、API 原始内容 |

> 工具入参默认关闭（`OTEL_LOG_TOOL_DETAILS=0`），客户端只上报工具名与耗时等元数据，不会发送入参内容。

## 卸载

还原安装前的备份，并删掉 hook 目录即可。按你装过的 CLI 分别执行：

```bash
# Claude Code
cp ~/.claude/settings.json.bak ~/.claude/settings.json   # 若有备份
rm -rf ~/.claude/cc-otel

# Codex CLI
cp ~/.codex/config.toml.bak ~/.codex/config.toml         # 若有备份
rm -rf ~/.codex/ai-otel

# Gemini CLI
cp ~/.gemini/settings.json.bak ~/.gemini/settings.json   # 若有备份
rm -rf ~/.gemini/ai-otel
```

> 备份是固定的 `.bak` 文件（非时间戳），每次安装会覆盖。若没有 `.bak`（首次安装前没有配置文件），手动从对应配置里删掉 OTel 相关 env、`telemetry`/`[otel]` 段，以及 `id` 为 `team:session-start` / `team:user-prompt-submit` 的 hook 条目即可。

## 排查

| 现象 | 怎么办 |
|---|---|
| 启动 `claude` 没看到上报动作 | 打开 `~/.claude/settings.json`，确认里面有一项 `id: team:session-start` |
| 服务器一直收不到数据 | 用团队提供的地址和端口做连通性检查；IP 测试地址通常检查 `4317`，生产域名通常检查团队提供的 gRPC 端口 |
| 想换服务器地址 | 直接重跑安装命令即可，会自动覆盖旧配置 |
