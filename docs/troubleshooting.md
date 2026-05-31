# Claude Code OTEL 本地 AI 排查手册

本文给本地 AI、桌面运维助手或支持同学使用。目标是让排查方在用户电脑上判断 `ai-otel-setup` 上报插件为什么没有数据，尤其是区分：

- hook 会话链路是否工作
- Claude Code 原生 OTel 是否工作
- 配置是否写错目录
- 网络或代理是否挡住了上报

不要第一反应要求用户重装 Claude Code。优先修复监控配置、确认 Claude Code 进程实际读取的 settings、确认上报端点可达。

## 一、插件做了什么

安装命令一般是：

```bash
npx -y ai-otel-setup url=你的服务器地址
```

安装器会把文件写到用户 Claude 配置目录下，默认是：

- macOS/Linux: `~/.claude/cc-otel/`
- Windows: `%USERPROFILE%\.claude\cc-otel\`

核心文件：

| 文件 | 作用 |
|---|---|
| `settings.json` | Claude Code 用户配置。安装器会写入 `env` 和 `hooks` |
| `cc-otel/launch-hook.js` | hook 启动器，负责启动真实 hook，并写本地诊断日志 |
| `cc-otel/on-session-start.js` | SessionStart/UserPromptSubmit hook，采集 session/cwd/git/hostname 等信息 |
| `cc-otel/endpoint.json` | hook 子进程拿不到 OTel env 时使用的端点兜底配置 |
| `cc-otel/ai-otel.log` | 本地排查日志，只保留最近几天 |

## 二、两条上报链路

这里很关键。`cc_session` 和 usage/tool/active 不是同一条链路。

| 数据 | 来源 | 触发方式 | 典型协议 |
|---|---|---|---|
| `cc_session` | 我们注入的 `SessionStart` / `UserPromptSubmit` hook | Claude Code hook 系统启动外部 Node 脚本 | OTLP/HTTP `/v1/logs` |
| `cc_api_usage` / `active_time` / `tool_result` 等 | Claude Code 原生 OTel SDK | Claude Code 主进程自己导出 logs/metrics | 由 `settings.json` 里的 `OTEL_*` 决定，当前安装器默认 `http/protobuf` |

所以：

- 有 `cc_session` 只能证明 hook 链路成功。
- 有 `cc_session` 但没有 usage/tool/active，通常说明 Claude Code 原生 OTel 没生效或被网络挡住。
- 连 `cc_session` 都没有，优先排查 hook 是否被触发、settings 是否被 Claude Code 读取。

## 三、先问用户要什么

让用户提供下面几类信息。不要让用户贴 token、密钥或完整业务代码。

### Windows PowerShell

```powershell
echo $env:USERPROFILE
echo $env:CLAUDE_CONFIG_DIR
echo $env:CLAUDE_HOME
where.exe claude
claude --version
Get-Command node
Test-Path "$env:USERPROFILE\.claude\settings.json"
Test-Path "$env:USERPROFILE\.claude\cc-otel\launch-hook.js"
Test-Path "$env:USERPROFILE\.claude\cc-otel\on-session-start.js"
Test-Path "$env:USERPROFILE\.claude\cc-otel\endpoint.json"
Get-Content "$env:USERPROFILE\.claude\settings.json" -Raw
Get-Content "$env:USERPROFILE\.claude\cc-otel\ai-otel.log" -Tail 80
```

如果用户设置了 `CLAUDE_CONFIG_DIR` 或 `CLAUDE_HOME`，还要检查实际配置目录：

```powershell
Test-Path "$env:CLAUDE_CONFIG_DIR\settings.json"
Test-Path "$env:CLAUDE_CONFIG_DIR\cc-otel\launch-hook.js"
Test-Path "$env:CLAUDE_CONFIG_DIR\cc-otel\endpoint.json"
Get-Content "$env:CLAUDE_CONFIG_DIR\settings.json" -Raw
Get-Content "$env:CLAUDE_CONFIG_DIR\cc-otel\ai-otel.log" -Tail 80
```

### macOS/Linux shell

```bash
echo "$HOME"
echo "$CLAUDE_CONFIG_DIR"
echo "$CLAUDE_HOME"
which claude
claude --version
which node
test -f "$HOME/.claude/settings.json"; echo $?
test -f "$HOME/.claude/cc-otel/launch-hook.js"; echo $?
test -f "$HOME/.claude/cc-otel/on-session-start.js"; echo $?
test -f "$HOME/.claude/cc-otel/endpoint.json"; echo $?
cat "$HOME/.claude/settings.json"
tail -n 80 "$HOME/.claude/cc-otel/ai-otel.log"
```

如果设置了 `CLAUDE_CONFIG_DIR`：

```bash
test -f "$CLAUDE_CONFIG_DIR/settings.json"; echo $?
test -f "$CLAUDE_CONFIG_DIR/cc-otel/launch-hook.js"; echo $?
test -f "$CLAUDE_CONFIG_DIR/cc-otel/endpoint.json"; echo $?
cat "$CLAUDE_CONFIG_DIR/settings.json"
tail -n 80 "$CLAUDE_CONFIG_DIR/cc-otel/ai-otel.log"
```

## 四、检查 settings.json

在 Claude Code 实际读取的 `settings.json` 中，至少应有这些字段。

### env

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://ai-otel.xfinfr.com",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://ai-otel.xfinfr.com/v1/logs",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": "http/protobuf",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT": "https://ai-otel.xfinfr.com/v1/metrics"
  }
}
```

如果是 gRPC 模式，常见关键项是：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://ai-otel.xfinfr.com:24317"
  }
}
```

以用户实际安装器版本和团队端点为准，不要凭空改域名。

### hooks

应有 `SessionStart`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/user/.claude/cc-otel/launch-hook.js\" \"C:/Users/user/.claude/cc-otel/on-session-start.js\"",
            "timeout": 3
          }
        ],
        "id": "team:session-start"
      }
    ]
  }
}
```

还可能有 `UserPromptSubmit`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/user/.claude/cc-otel/launch-hook.js\" \"C:/Users/user/.claude/cc-otel/on-session-start.js\"",
            "timeout": 3
          }
        ],
        "id": "team:user-prompt-submit"
      }
    ]
  }
}
```

Windows 上 command 以 `node "C:/Users/..."` 开头是正常的。安装器故意让 Windows 通过 PATH 找 `node`，避免 `C:\Program Files\...` 这类路径在 PowerShell/cmd/Git Bash 中被引号和空格坑到。

macOS/Linux 上 command 通常是绝对 Node 路径，例如：

```json
"command": "\"/Users/name/.nvm/versions/node/v22.18.0/bin/node\" \"/Users/name/.claude/cc-otel/launch-hook.js\" \"/Users/name/.claude/cc-otel/on-session-start.js\""
```

如果同一个 `SessionStart` 中有两条一模一样的 hook，其中一条没有 `id`，通常是旧安装残留。它不一定导致完全不上报，但会造成重复执行。建议保留带 `id: team:session-start` 的条目，清理无 id 的重复条目，或重新运行最新版安装器。

## 五、读 ai-otel.log 怎么判断

`ai-otel.log` 每行是一个 JSON。

### 只有 installer_complete

示例：

```json
{"event":"installer_complete","tool":"claude","installerVersion":"1.0.26"}
```

含义：

- 安装器运行过。
- 但从这份日志看，Claude Code 没有触发 hook。

优先排查：

1. 用户是否完全退出并重新打开 Claude Code。
2. Claude Code 实际读的是不是这份 `settings.json`。
3. 是否用了封装版、IDE 内嵌版、公司 wrapper，导致它读了另一套配置目录。
4. settings 里是否有 `hooks.SessionStart`。
5. 项目级或 managed settings 是否禁用了 hooks。

### 有 hook_launcher_start

示例字段：

```json
{
  "event": "hook_launcher_start",
  "hookEnvTelemetryEnabled": false,
  "hookEnvHasOtlpEndpoint": false,
  "settingsTelemetryEnabled": true,
  "settingsHasOtlpEndpoint": true
}
```

含义：

- Claude Code 已经触发了 hook。
- `hookEnv*` 为空不一定是问题。Claude Code 不一定会把 `OTEL_*` 环境变量传给 hook 子进程。
- 重点看 `settings*` 是否为 true，以及后续是否有 `cc_hook_start`、`cc_hook_post_end`。

### 有 cc_hook_start 但没有 cc_hook_post_end

说明 hook 脚本开始执行，但可能在读 stdin、采集 git、解析 endpoint 或网络请求中失败。继续看后续是否有：

- `cc_hook_post_error`
- `cc_hook_post_timeout`
- `cc_hook_error`
- `hook_launcher_exit`

### cc_hook_post_end statusCode 200

示例：

```json
{"event":"cc_hook_post_end","statusCode":200}
```

说明 hook 会话链路正常。若平台仍没有 usage/tool/active，则继续排查 Claude Code 原生 OTel。

### cc_hook_post_error request_error

常见原因：

- endpoint 解析到了错误地址，例如 fallback 到 `localhost:4318`
- 网络不通
- 代理影响 Node HTTPS 请求
- 公司网关拦截
- TLS/证书问题

检查 `endpoint.json`，并手动 POST `/v1/logs`。

## 六、手动执行 hook 测试

这个测试可以判断 hook 脚本本身是否能跑。

### Windows

```powershell
'{"session_id":"manual-test","cwd":"D:\test","hook_event_name":"SessionStart"}' | node "C:/Users/用户名/.claude/cc-otel/launch-hook.js" "C:/Users/用户名/.claude/cc-otel/on-session-start.js"
Get-Content "$env:USERPROFILE\.claude\cc-otel\ai-otel.log" -Tail 30
```

如果用户使用 `CLAUDE_CONFIG_DIR=D:\llm\.claude`，路径要改成实际目录：

```powershell
'{"session_id":"manual-test","cwd":"D:\test","hook_event_name":"SessionStart"}' | node "D:/llm/.claude/cc-otel/launch-hook.js" "D:/llm/.claude/cc-otel/on-session-start.js"
Get-Content "D:\llm\.claude\cc-otel\ai-otel.log" -Tail 30
```

### macOS/Linux

```bash
printf '%s' '{"session_id":"manual-test","cwd":"/tmp","hook_event_name":"SessionStart"}' | node "$HOME/.claude/cc-otel/launch-hook.js" "$HOME/.claude/cc-otel/on-session-start.js"
tail -n 30 "$HOME/.claude/cc-otel/ai-otel.log"
```

判断：

- 出现 `hook_launcher_start`、`cc_hook_start`、`cc_hook_post_end`：hook 脚本和网络基本正常。问题在 Claude Code 是否触发 hook。
- 出现 `cc_hook_post_error` 或 timeout：hook 能执行，但 endpoint/网络有问题。
- 日志仍只有 `installer_complete`：launcher/node 执行链有问题，检查 command 路径、Node、文件是否存在。

## 七、手动测试端点

### HTTP/protobuf 模式

测试 logs：

```bash
curl -v -X POST "https://ai-otel.xfinfr.com/v1/logs" \
  -H "Content-Type: application/json" \
  -d '{"resourceLogs":[]}' \
  --max-time 5
```

测试 metrics：

```bash
curl -v -X POST "https://ai-otel.xfinfr.com/v1/metrics" \
  -H "Content-Type: application/json" \
  -d '{"resourceMetrics":[]}' \
  --max-time 5
```

`200 OK` 或服务端明确返回可识别响应，说明 HTTP 端点基本可达。

### gRPC 模式

如果 settings 使用：

```json
"OTEL_EXPORTER_OTLP_PROTOCOL": "grpc"
```

则不能只用 `/v1/logs` 的 HTTP 结果证明 gRPC 可用。至少要确认目标 host:port TCP 可达。

Windows:

```powershell
Test-NetConnection ai-otel.xfinfr.com -Port 24317
```

macOS/Linux:

```bash
nc -vz ai-otel.xfinfr.com 24317
```

TCP 通也不代表 gRPC 完全可用，但 TCP 不通一定会失败。

## 八、排查决策树

### 场景 A：服务器有 session，没有 usage/tool/active

优先判断为 Claude Code 原生 OTel 没生效，hook 不是主嫌疑。

检查：

1. `settings.json` 是否有 `CLAUDE_CODE_ENABLE_TELEMETRY=1`。
2. `OTEL_LOGS_EXPORTER` 和 `OTEL_METRICS_EXPORTER` 是否为 `otlp`。
3. protocol 与 endpoint 是否匹配。
4. HTTP 模式下 `/v1/logs` 和 `/v1/metrics` 是否可达。
5. gRPC 模式下 gRPC 端口是否可达。
6. 用户是否完全退出并重新打开 Claude Code。
7. 用户是否使用封装版、IDE 内嵌版、公司启动脚本。
8. 是否存在 managed settings 覆盖了用户 settings。

结论表达：

> hook 会话链路已经成功。usage/tool/active 依赖 Claude Code 原生 OTel SDK，当前更像主进程没有读取 OTel env，或原生 OTel 出口被网络拦截。

### 场景 B：服务器连 session 都没有，日志只有 installer_complete

优先判断为 hook 没被 Claude Code 触发。

检查：

1. Claude Code 实际读取的配置目录。
2. `settings.json` 里是否有 `hooks.SessionStart`。
3. hook command 指向的 `launch-hook.js` 和 `on-session-start.js` 是否存在。
4. `node` 是否能在启动 Claude 的同一环境中找到。
5. 用户是否重启 Claude Code。
6. 是否有项目/组织配置禁用 hooks。

结论表达：

> 安装器运行过，但没有证据显示 Claude Code 触发过 hook。重点查配置目录和启动方式。

### 场景 C：日志有 cc_hook_post_error

优先判断为 hook 被触发，但 HTTP 上报失败。

检查：

1. `endpoint.json` 是否存在，内容是否为预期域名。
2. 是否 fallback 到 `localhost:4318`。
3. curl `/v1/logs` 是否成功。
4. 代理环境变量是否影响 Node 请求。
5. `NO_PROXY/no_proxy` 是否包含 collector host。
6. 公司网络是否拦截 TLS 或出站请求。

结论表达：

> hook 运行正常，失败点在 endpoint 解析或网络出站。

### 场景 D：用户把 Claude Code 装在 D 盘，cc-otel 在 C 盘

这本身不是问题。

正常情况下，Windows 上 Claude 可执行文件在 D 盘，用户配置仍然在：

```text
C:\Users\用户名\.claude\settings.json
```

hook 脚本也在：

```text
C:\Users\用户名\.claude\cc-otel\
```

只要 settings 里的 command 是绝对路径，D 盘 Claude 可以执行 C 盘 hook。

真正的问题是：Claude Code 进程到底读哪份 settings。

### 场景 E：用户迁移了 Claude 配置目录到 D 盘

如果用户设置了：

```text
CLAUDE_CONFIG_DIR=D:\llm\.claude
CLAUDE_HOME=D:\llm\.claude
```

就可能出现配置分裂：

| 路径 | 情况 |
|---|---|
| `C:\Users\用户名\.claude\settings.json` | installer 默认写入 OTel env/hooks |
| `D:\llm\.claude\settings.json` | Claude Code 实际读取 |

如果 OTel 配置在 C 盘，而 Claude 实际读 D 盘，hook 不会触发。

修复思路：

1. 把 OTel env 和 hooks 合并到 Claude 实际读取的 `settings.json`。
2. 把 `cc-otel` 目录复制或移动到实际配置目录。
3. 修改 hooks command，指向实际目录里的 `launch-hook.js` 和 `on-session-start.js`。
4. 确保实际目录中有 `endpoint.json`。
5. 如果 `on-session-start.js` 仍按 `os.homedir()/.claude/cc-otel/endpoint.json` 兜底，可在默认 home 目录保留一个 `endpoint.json` 桩文件，或使用符号链接。

Windows 桩文件示例：

```powershell
New-Item -ItemType Directory -Path "C:\Users\用户名\.claude\cc-otel" -Force | Out-Null
Copy-Item "D:\llm\.claude\cc-otel\endpoint.json" "C:\Users\用户名\.claude\cc-otel\endpoint.json" -Force
```

更稳的方式是创建目录符号链接，但可能需要管理员权限：

```powershell
Remove-Item "C:\Users\用户名\.claude\cc-otel" -Recurse -Force
New-Item -ItemType SymbolicLink `
  -Path "C:\Users\用户名\.claude\cc-otel" `
  -Target "D:\llm\.claude\cc-otel"
```

## 九、不要误判的点

1. `hookEnvHasOtlpEndpoint=false` 不必然说明配置没生效。hook 子进程可能拿不到 Claude Code 主进程的 OTel env。
2. `settingsHasOtlpEndpoint=true` 只说明 launcher 读到同目录上级的 settings，不一定说明 Claude Code 主进程读取了同一份 settings。
3. 有 session 不代表 usage/tool/active 一定有。它们来自不同链路。
4. 只有 installer 日志不代表网络失败，更常见是 hook 没触发。
5. Windows command 里使用 `node "C:/Users/..."` 是正常设计。
6. macOS command 里使用绝对 Node 路径是正常设计。
7. 重装 Claude Code 本体通常不是首选。先重跑安装器、修 settings、重启 Claude Code。

## 十、建议给用户的最短修复动作

如果确认配置在默认目录且没有迁移：

```bash
npx -y ai-otel-setup url=你的服务器地址
```

然后让用户完全退出 Claude Code，再重新打开。

如果用户使用了自定义配置目录，不能只重跑默认 installer。应把 OTel 配置写进 Claude 实际读取的 `settings.json`，并确保 hook command 指向实际存在的 `cc-otel` 目录。

## 十一、本地 AI 最终输出格式

排查结束时，请用这种结构回复用户：

```text
结论：
  当前更像是 hook 未触发 / hook 网络失败 / 原生 OTel 未生效 / 配置目录分裂。

证据：
  - ai-otel.log 中有什么事件
  - settings.json 中关键 env/hooks 是否存在
  - endpoint 测试结果
  - Claude Code 实际配置目录判断

建议修复：
  1. ...
  2. ...
  3. ...

是否需要重装 Claude Code：
  通常不需要。只有配置和网络都确认正常、仍无原生 OTel 数据时，再考虑 Claude Code 版本或特殊客户端问题。
```

