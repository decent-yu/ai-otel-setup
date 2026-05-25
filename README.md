# AI CLI 上报工具

一键开通团队的 Claude Code / Codex CLI / Gemini CLI / OpenCode 使用数据上报。

## 安装

```bash
npx -y ai-otel-setup url=你的服务器地址
```

> 国内网络慢可以临时切到淘宝镜像：`npm config set registry https://registry.npmmirror.com`，再执行上面的命令。
>
> 兼容旧命令：`npx -y cc-otel-installer url=...` 仍然可用，行为完全一致。

把 `你的服务器地址` 替换成团队提供的实际地址（例如 `url=10.20.30.40`）。具体地址请向团队负责人索取。

装好后直接运行 `claude` / `codex` / `gemini` / `opencode`，上报会自动开始，无需任何额外配置。

## 参数

| 参数 | 说明 |
|---|---|
| `url`（必填） | 服务器地址。可填 IP / 域名，或完整地址。裸 IP 会按本地测试规则生成 `http://IP:4317`；裸域名会按生产规则生成 `https://域名:24317`。不能包含空格或逗号。 |

## 装好后会做什么

- 在 `~/.claude/cc-otel/` 放一个启动脚本
- 如果检测到 `~/.config/opencode`，会在 `~/.config/opencode/plugins/` 放一个 OpenCode 插件
- 备份你原来的 `~/.claude/settings.json`（带时间戳，可随时还原）
- 把上报相关配置写进 `~/.claude/settings.json`

你原本的其他设置都会保留；重复运行不会产生重复条目，可以放心重装。

## 采集了哪些数据

|  | 内容 |
|---|---|
| ✅ 会采集 | 调用了哪些工具、每次耗时、是否成功、token 用量、当前目录、Git 信息 |
| ❌ 不采集 | 你输入的提示词、代码正文、工具入参、API 原始内容 |

## 卸载

还原安装前的备份即可：

```bash
ls ~/.claude/settings.json.bak.* | tail -1 | xargs -I{} cp {} ~/.claude/settings.json
rm -rf ~/.claude/cc-otel
rm -rf ~/.config/opencode/ai-otel ~/.config/opencode/plugins/ai-otel-setup.mjs
```

## 排查

| 现象 | 怎么办 |
|---|---|
| 启动 `claude` 没看到上报动作 | 打开 `~/.claude/settings.json`，确认里面有一项 `id: team:session-start` |
| 服务器一直收不到数据 | 用团队提供的地址和端口做连通性检查；IP 测试地址通常检查 `4317`，生产域名通常检查团队提供的 gRPC 端口 |
| 想换服务器地址 | 直接重跑安装命令即可，会自动覆盖旧配置 |
