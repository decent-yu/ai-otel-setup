# AI CLI 上报工具

一键开通团队的 Claude Code / Codex CLI / Gemini CLI 使用数据上报。

`ai-otel-setup` 是一个本机安装器，用于写入 AI CLI 的 OpenTelemetry 上报配置和 hooks。Collector、Forward 服务和数据看板由团队另行部署，不包含在本仓库内。

```text
Claude Code / Codex CLI / Gemini CLI
  -> ai-otel-setup 写入的 OTel 配置和 hooks
  -> 团队提供的上报端点
  -> Collector / Forward（团队另行部署）
  -> 数据看板（团队另行部署）
```

## 配套看板示例

采集到的数据可接入团队的数据看板，用于查看 Token 用量、API 费用、代码变动、活跃会话和工作区投入等指标。

下图为脱敏后的示例效果：

![AI 助手观测平台看板示例](docs/assets/dashboard-demo.png)

## 安装

```bash
npx -y ai-otel-setup url=collector服务地址
```

> 国内网络慢可以临时切到淘宝镜像：`npm config set registry https://registry.npmmirror.com`，再执行安装命令。

把 `collector服务地址` 替换成团队提供的实际地址，例如：url=collector.example.com。具体地址请向团队负责人索取。

装好后直接运行 `claude` / `codex` / `gemini`，上报会自动开始，无需额外配置。

| 参数 | 说明 |
|---|---|
| `url`（必填） | 服务器地址。可填 IP / 域名，或完整地址。裸 IP 会按本地测试规则生成 `http://IP:4317`；裸域名会按生产规则生成 `https://域名:24317`。不能包含空格或逗号。 |
| `--http` / `http=1` | Claude Code 原生 OTel 使用 OTLP/HTTP。默认使用此模式，logs 指向 `/v1/logs`，metrics 指向 `/v1/metrics`。 |
| `--grpc` / `grpc=1` | 强制 Claude Code 原生 OTel 使用 gRPC，作为 HTTP 上报异常时的 fallback。 |

## 安装后会做什么

- 在 `~/.claude/cc-otel/` 放一个启动脚本
- 备份你原来的 `~/.claude/settings.json`（带时间戳，可随时还原）
- 把上报相关配置写进 `~/.claude/settings.json`

你原本的其他设置都会保留；重复运行不会产生重复条目，可以放心重装。

## 采集了哪些数据

| 类型 | 内容 |
|---|---|
| 会采集 | 调用了哪些工具、每次耗时、是否成功、Token 用量、当前目录、Git 信息 |
| 不采集 | 你输入的提示词、代码正文、工具入参、API 原始内容 |

## 本地日志

安装后会在本机写入排查日志，只保留最近 3 天数据：

| 工具 | 日志路径 |
|---|---|
| Claude Code | `~/.claude/cc-otel/ai-otel.log` |
| Codex CLI | `~/.codex/ai-otel/ai-otel.log` |
| Gemini CLI | `~/.gemini/ai-otel/ai-otel.log` |

## 卸载

还原安装前的备份即可：

```bash
ls ~/.claude/settings.json.bak.* | tail -1 | xargs -I{} cp {} ~/.claude/settings.json
rm -rf ~/.claude/cc-otel
```

## 排查

| 现象 | 怎么办 |
|---|---|
| 启动 `claude` 没看到上报动作 | 打开 `~/.claude/settings.json`，确认里面有一项 `id: team:session-start` |
| 服务器一直收不到数据 | 用团队提供的地址和端口做连通性检查；IP 测试地址通常检查 `4317`，生产域名通常检查团队提供的 gRPC 端口 |
| 想换服务器地址 | 直接重跑安装命令即可，会自动覆盖旧配置 |

详细排查见 [docs/troubleshooting.md](docs/troubleshooting.md)。
