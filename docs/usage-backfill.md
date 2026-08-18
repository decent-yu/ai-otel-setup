# `usage-backfill` 命令参考

> `npx -y ai-otel-setup usage-backfill` 让你不依赖 Claude Code 的 SessionStart hook，
> 也能立刻把本地近期的 token 用量补报到团队看板。常用于：换新机器、看板缺数据、
> 第一次装机想把历史数据回补、或者只是想看一眼会发什么。
>
> 需要 ai-otel-setup ≥ **v1.0.32**。

---

## 前置条件

你必须先正常装机过一次，本地才会有 `~/.claude/cc-otel/local-usage-scanner.js`
和 `endpoint.json` 可以调用：

```bash
npx -y ai-otel-setup url=ai-otel.xfinfr.com
```

没装机直接跑 `usage-backfill` 会报错并提示先装机。

---

## 查帮助

```bash
npx -y ai-otel-setup usage-backfill --help
```

输出：

```
Usage: npx -y ai-otel-setup usage-backfill [选项]

从本地 jsonl 重新聚合最近的 token 用量并 POST 到团队上报。
默认走 7 天窗口、5 分钟节流、历史天 lock；用下面的开关可放宽。

  --window=N         扫描近 N 天（默认 7，上限 30）
  --dry-run          算 buckets 不发送，只 print 统计
  --force            等于 --ignore-throttle --ignore-lock
  --ignore-throttle  跳过 5 分钟节流
  --ignore-lock      跳过历史天 lock，强制重扫
```

---

## 单开关

| 命令 | 行为 |
|---|---|
| `npx -y ai-otel-setup usage-backfill` | 默认：扫近 7 天，受 5min 节流和历史天 lock 限制 |
| `npx -y ai-otel-setup usage-backfill --window=N` | 扫近 N 天，默认 7，上限 30 |
| `npx -y ai-otel-setup usage-backfill --dry-run` | 算 buckets 后只 print 统计，**不发 POST，不更新本地 lock，也自动跳过 5 分钟节流** |
| `npx -y ai-otel-setup usage-backfill --ignore-throttle` | 跳过 5 分钟同机节流（适合刚跑过想立刻再跑一次） |
| `npx -y ai-otel-setup usage-backfill --ignore-lock` | 跳过历史天 lock，强制重扫每个 day |
| `npx -y ai-otel-setup usage-backfill --force` | 等于 `--ignore-throttle --ignore-lock` |

不识别的参数会立刻报错退出：

```
[ai-otel-setup] usage-backfill: 未识别参数 "--bogus"
  执行 `npx -y ai-otel-setup usage-backfill --help` 查看可用开关。
```

---

## 常用组合

```bash
# 先看一眼会发什么（最稳的姿势，最常用）
npx -y ai-otel-setup usage-backfill --dry-run --window=7

# 全量回补 30 天（换新机器 / 第一次装 / 怀疑看板漏数据时）
npx -y ai-otel-setup usage-backfill --window=30 --force

# 30 天 dry-run（看完整窗口会发什么，不真发）
npx -y ai-otel-setup usage-backfill --window=30 --dry-run --force

# 5min 节流卡住了立即重跑（只发今天，不重扫历史）
npx -y ai-otel-setup usage-backfill --ignore-throttle
```

---

## 输出怎么读

`usage-backfill` 走 scanner 的 manual 模式，每条事件同步打在 stdout，最后会带一张
按日聚合表（CC / Codex / 合计 token 数）。一次有数据的 dry-run 大致是这样：

```
[09:28:13] local_usage_start window=2026-06-05,...,2026-06-11 targetDays=... lockedCount=0
[09:28:13] local_usage_dry_run source=cc rolls=4
[09:28:13] local_usage_done source=codex reason=no_rolls

=== 按日聚合（窗口 7 天）===
day         CC sess  CC tokens  Codex sess  Codex tokens  Total tokens
----------  -------  ---------  ----------  ------------  ------------
2026-06-05  0        0          0           0             0
2026-06-06  2        367K       0           0             367K
2026-06-07  0        0          0           0             0
2026-06-08  0        0          0           0             0
2026-06-09  1        2.7M       0           0             2.7M
2026-06-10  0        0          0           0             0
2026-06-11  1        514K       0           0             514K
----------  -------  ---------  ----------  ------------  ------------
total       4        3.6M       0           0             3.6M

[09:28:13] local_usage_summary mode=dry-run cc_rolls=4 codex_rolls=0 cc_status=ok codex_status=ok duration_ms=4 window_days=7 target_days=7
```

表里的列：

| 列 | 含义 |
|---|---|
| `day` | +08 墙钟日期，窗口里**全部**列出，没用 claude/codex 的日子也是 0 行 |
| `CC sess` / `Codex sess` | 该日该源里 distinct `session_id` 的数量 |
| `CC tokens` / `Codex tokens` / `Total tokens` | `input + output + cache_read + cache_creation` 求和；数字简写 K=千、M=百万、B=十亿 |
| 末行 `total` | 整个窗口的合计；`sess` 列也是 distinct，跨日同 sid 算一次 |

| 事件 | 含义 |
|---|---|
| `local_usage_start` | 起始事件，列出窗口里的 day 和已 lock 的天数 |
| `local_usage_done reason=no_rolls` | 该数据源（cc 或 codex）窗口内没有 token 使用记录 |
| `local_usage_post_ok` | 真发 POST 成功，含批次数和总 rolls 数 |
| `local_usage_post_fail` | POST 失败，含 HTTP 状态码和错误片段 |
| `local_usage_dry_run` | `--dry-run` 时算完 buckets 跳过 POST |
| `local_usage_skip` | 整体被 skip，看 `reason` 字段：`throttled` / `no_localUsageUrl` / `no_machine_id` |
| `local_usage_multiplier` | 灰度倍率不为 1 时打一次，`multiplier` 是本次上报实际使用的倍率 |
| `local_usage_summary` | manual 模式结束摘要，含 mode / multiplier / rolls / status / duration |
| `local_usage_watchdog_killed` | 跑超过 10min 被强退（manual 模式 watchdog） |
| `local_usage_error` | 异常退出，看 `error` 字段 |

---

## 工作机制

| 项 | 默认值 | 说明 |
|---|---|---|
| 扫描窗口 | 7 天 | `[今天-6d, 今天]`，按 +08 墙钟切日（与 Doris/DW 同口径） |
| 5 分钟节流 | 同 machine_id 内 5 分钟跑一次 | marker 写在 `~/.claude/cc-otel-state/local-usage-<machine_id>.flag` |
| 历史天 lock | 非今天的 day 上一次成功 POST 后会被锁住 | lock 文件 `~/.claude/cc-otel/local-usage-state.json`，里面 `locked_days` 字段 |
| 单次最长跑 | 默认 hook 模式 20s；manual 模式 5min | 超时直接返回当前已聚合的 buckets |
| Watchdog | 默认 hook 模式 60s；manual 模式 10min | 强退兜底，防 readline / network 卡死 |
| 数据源 | `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl` + `~/.codex/archived_sessions/**/*.jsonl` | Gemini 暂不参与 |
| 灰度倍率 | 1（不放大） | 见下方「灰度倍率」 |

---

## 灰度倍率

`usage-backfill` 会沿用装机时写入的灰度倍率。倍率**只在 POST 出口生效**：表里打印的按日聚合、以及 `local-usage-state.json` 的 `locked_days`，都是原始值。

```bash
# 临时用 5 倍跑一次 dry-run（不真发，也不写 lock）
AI_OTEL_USAGE_MULTIPLIER=5 npx -y ai-otel-setup usage-backfill --dry-run
```

来源优先级：环境变量 `AI_OTEL_USAGE_MULTIPLIER` → `~/.claude/cc-otel/endpoint.json` 的 `usageMultiplier` → 1。合法区间 `0 < N <= 1000`，非法值回落 1。

放大只作用于 4 个 token 字段（`input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens`），`messages` 保持原值；乘完按四舍五入收敛成整数。上报体 envelope 带 `usage_multiplier`，服务端可反解真实用量。

完整说明见 [README 的「灰度倍率开关」](../README.md#灰度倍率开关)。
| 聚合维度 | `(machine_id, source, day, session_id, model)` | 同一组合 upsert 到 MySQL `ai_assistant.local_usage_daily` |

---

## 排查

| 现象 | 怎么办 |
|---|---|
| 跑了之后没 stdout 输出 | scanner 没收到 `--manual`，说明 ai-otel-setup 版本 < 1.0.32，先升级 |
| `local_usage_skip reason=throttled` | 5min 节流命中，加 `--ignore-throttle` 或 `--force` |
| `local_usage_skip reason=no_localUsageUrl` | `endpoint.json.localUsageUrl` 没派生出来，多半是装机时 url 参数没填对，重装一次 |
| `local_usage_post_fail status=429` | 服务端 per-IP rate limit（60 req/min/IP），等一分钟再试 |
| `local_usage_post_fail status=400` | envelope 校验失败，看 `error` 字段；常见是某条 roll 的 `day` 超出 `[today-30d, today+1d]` 窗口 |
| `local_usage_post_fail status=503` | 服务端 `FORWARDER_LOCAL_USAGE_ENABLED=0`，找团队负责人开 |
| `local_usage_post_fail status=500` | MySQL 连接/写入失败，找团队负责人查 forwarder 日志 |
| `local_usage_watchdog_killed` | scanner 卡了 10min 才被强退，重跑一次；持续出现请反馈 |

详细 hook 主流程的排查见 [troubleshooting.md](troubleshooting.md)。
