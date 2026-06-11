#!/usr/bin/env node
/**
 * SessionStart / UserPromptSubmit 兜底 hook
 *
 * 职责：
 *   采集 CC 原生 OTel 不覆盖的字段（cwd / git_remote / git_user_email /
 *   git_user_name / hostname / ANTHROPIC_BASE_URL route snapshot），通过 OTLP/HTTP 4318 发给 Collector，
 *   与 OTel 主流合流。
 *
 * 双 hook 复用同一脚本：
 *   - SessionStart 触发：每次 claude 启动；生成 hook_kind="session_start"
 *   - UserPromptSubmit 触发：每次用户输入 prompt；生成 hook_kind="user_prompt_fallback"
 *     用于救回 SessionStart 因网络/超时丢失的 session（服务端见 entry 已存在则忽略）
 *
 * 关键约束：
 *   - 不读源代码，只读 git 元信息
 *   - 总耗时 < 3s（hooks 已设 timeout=3）
 *   - 失败静默，绝不阻塞 CC
 *   - session.id 从 stdin 读
 *
 * 节流（仅对 UserPromptSubmit）：
 *   - 在 ~/.claude/cc-otel-state/sent-<sid>.flag 写 marker
 *   - 2 分钟内同 sid 跳过 OTLP 上报，避免高频敲键狂发
 *   - 2 分钟后过期允许重试，给丢包/瞬时故障留救命窗口
 */

"use strict";

const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort; old installs may not have logging.js yet.
}

// UserPromptSubmit 节流窗口：2 分钟
const PROMPT_THROTTLE_MS = 2 * 60 * 1000;

// -------- 环境变量读取 ----------

/**
 * 推导 OTel Collector 的 OTLP/HTTP logs endpoint。
 * 优先级：
 *   1. 显式 OTEL_EXPORTER_OTLP_LOGS_ENDPOINT（用户指定 logs 端点）
 *   2. OTEL_EXPORTER_OTLP_ENDPOINT（通用端点，自动补 /v1/logs，把 4317 换成 4318）
 *   3. installer 写盘的 ~/.claude/cc-otel/endpoint.json（救 CC 父进程未传 env 的场景；
 *      v1.0.2 实测 settings.json 的 env 不一定继承到 hook 子进程，导致 fallback 到
 *      localhost 后 ECONNREFUSED 静默失败）
 *   4. fallback http://localhost:4318/v1/logs
 */
function resolveLogsEndpoint() {
  const logsEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (logsEndpoint) return logsEndpoint;

  let base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  // env 没拿到 → 读 installer 写的 endpoint.json
  if (!base) {
    try {
      const cfgPath = path.join(os.homedir(), ".claude", "cc-otel", "endpoint.json");
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg && cfg.logsEndpoint) return cfg.logsEndpoint;
      if (cfg && cfg.endpoint) base = cfg.endpoint;
    } catch (_) {
      // 文件不存在或解析失败：继续走 localhost fallback，与历史行为一致
    }
  }

  if (!base) base = "http://localhost:4317";
  const url = new URL(base);
  // gRPC 默认 4317 → OTLP/HTTP 默认 4318
  if (url.port === "4317") url.port = "4318";
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
  return url.toString();
}

function readInstallerConfig() {
  try {
    const cfgPath = path.join(os.homedir(), ".claude", "cc-otel", "endpoint.json");
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (_) {
    return {};
  }
}

// -------- 工具函数 ----------

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // 防挂死：2s 读不到 stdin 就放弃
    setTimeout(() => resolve(data), 2000);
  });
}

// 安全执行 git 命令：execFileSync 不走 shell，cwd 字符串不会被 /bin/sh 解释，
// 杜绝 cwd 含 `"` / `$(...)` / 反引号 时的命令注入（C-2 修复）
function safeGit(args) {
  try {
    return execFileSync("git", args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch (_) {
    return null;
  }
}

function normalizedOrigin(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch (_) {
    // Fall back to a conservative, query-free origin-like value so
    // path/query/userinfo are not reported.
    return value
      .replace(/^[^:]+:\/\//, (m) => m.toLowerCase())
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .slice(0, 200);
  }
}

function anthropicRouteSnapshot() {
  const anthropicBaseUrl = normalizedOrigin(process.env.ANTHROPIC_BASE_URL);
  return {
    "anthropic_base_url": anthropicBaseUrl,
  };
}

// 仅在 mongoGrayTag 灰度安装时 spawn detached git-snapshot.js，不阻塞主 hook。
// 节流、截断、POST 都在 snapshot 脚本里做。
function spawnGitSnapshot(cfg, sessionId, hookKind, cwd) {
  if (!cfg || !cfg.mongoGrayTag) return;
  const snapshotPath = path.join(__dirname, "git-snapshot.js");
  try {
    if (!fs.existsSync(snapshotPath)) return;
    const child = spawn(process.execPath, [
      snapshotPath,
      `--session-id=${sessionId}`,
      `--hook-kind=${hookKind}`,
      `--cwd=${cwd}`,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logEvent("git_snapshot_spawned", { hookKind, hasSessionId: !!sessionId });
  } catch (e) {
    logEvent("git_snapshot_spawn_failed", { error: (e && e.message) || "unknown" });
  }
}

// 全量装机默认 spawn detached local-usage-scanner.js（仅 SessionStart 触发，
// 不再放到 Stop 分支，避免每轮 turn 多次 spawn 浪费 CPU / handle）。
// 用户级 opt-out：endpoint.json.localUsageEnabled === false 时跳过。
// 节流由 scanner 自身 5min/machine_id 控制。
function spawnLocalUsageScanner(cfg) {
  if (!cfg) return;
  if (cfg.localUsageEnabled === false) return;
  if (!cfg.localUsageUrl) return;
  const scannerPath = path.join(__dirname, "local-usage-scanner.js");
  try {
    if (!fs.existsSync(scannerPath)) return;
    const child = spawn(process.execPath, [scannerPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logEvent("local_usage_spawned", {});
  } catch (e) {
    logEvent("local_usage_spawn_failed", { error: (e && e.message) || "unknown" });
  }
}

// -------- 主流程 ----------

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch (_) {
      input = {};
    }

    const cwd = input.cwd || process.cwd();
    const sessionId = input.session_id || input.sessionId || ""; // MVP 实证：stdin.session_id = OTel session.id
    // CC 在 stdin 里告诉脚本是哪个 hook 触发的；UserPromptSubmit 走"兜底"分支；Stop 仅做 git snapshot
    const hookEventName = input.hook_event_name || "";
    const isPromptFallback = hookEventName === "UserPromptSubmit";
    const isStop = hookEventName === "Stop";

    // Stop 分流：不再发主 hook_session_start（那是 SessionStart 干的事），
    // 只在 mongoGrayTag 灰度时 spawn 一次 git snapshot（hook_kind=session_end）后退出。
    // 注意：local-usage-scanner 不在 Stop 触发——Stop 是每轮 turn 都触发的高频事件，
    // 会让 detached 子进程数和 CPU 抖动放大；SessionStart 单点驱动已够覆盖每次启动。
    if (isStop) {
      const cfg = readInstallerConfig();
      spawnGitSnapshot(cfg, sessionId, "session_end", cwd);
      logEvent("cc_hook_stop_dispatched", { hasSessionId: !!sessionId });
      process.exit(0);
    }

    logEvent("cc_hook_start", {
      hookKind: isPromptFallback ? "user_prompt_fallback" : "session_start",
      hasSessionId: !!sessionId,
    });

    // 兜底路径节流：sid 维度 2 分钟最多一次（marker 文件 mtime 判断）。
    // 失败重试窗口同时由此控制：marker 过期后允许下次 prompt 再发一次。
    const stateDir = path.join(os.homedir(), ".claude", "cc-otel-state");
    const markerPath = sessionId ? path.join(stateDir, `sent-${sessionId}.flag`) : null;
    if (isPromptFallback && markerPath && fs.existsSync(markerPath)) {
      try {
        const mtime = fs.statSync(markerPath).mtimeMs;
        if (Date.now() - mtime < PROMPT_THROTTLE_MS) {
          logEvent("cc_hook_skip", { reason: "prompt_throttled" });
          process.exit(0);
        }
      } catch (_) {
        // marker 状态读不到就当作过期，继续走上报
      }
    }

    const event = {
      "tool_kind": "cc",
      "event.name": "hook_session_start",
      "event.timestamp": new Date().toISOString(),
      "session.id": sessionId,
      // 服务端按此字段分流：session_start 走原 new/resume 逻辑；
      // user_prompt_fallback 走"entry 已存在则仅补空字段"逻辑
      "hook_kind": isPromptFallback ? "user_prompt_fallback" : "session_start",
      "cwd": cwd,
      "project.name": path.basename(cwd),
      "git.remote": safeGit(["-C", cwd, "config", "--get", "remote.origin.url"]) || "",
      "git.user.email": safeGit(["-C", cwd, "config", "user.email"]) || "",
      "git.user.name": safeGit(["-C", cwd, "config", "user.name"]) || "",
      "hostname": os.hostname() || "",
      ...anthropicRouteSnapshot(),
      "data_source": "hook", // Collector 端用 insert 而非 upsert 以保留本标签
    };
    logEvent("cc_hook_payload", event);

    const logsEndpoint = resolveLogsEndpoint();
    const installerCfg = readInstallerConfig();
    const resourceAttributes = [];
    if (installerCfg.mongoGrayTag) {
      resourceAttributes.push({
        key: "ai_otel.mongo_gray",
        value: { stringValue: String(installerCfg.mongoGrayTag) },
      });
    }
    const payload = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: resourceAttributes,
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: `${Date.now()}000000`,
                  body: { stringValue: "hook_session_start" },
                  attributes: Object.entries(event).map(([k, v]) => ({
                    key: k,
                    value: { stringValue: String(v ?? "") },
                  })),
                },
              ],
            },
          ],
        },
      ],
    });

    const url = new URL(logsEndpoint);
    const lib = url.protocol === "https:" ? https : http;

    // 关键：必须等 HTTP request 真的发出并收到响应（或短时间超时）才退出，
    // 不能 req.end() 之后立刻 process.exit(0) —— 那样 TCP handshake 都
    // 还没做完进程就没了，Collector 永远收不到。
    // Hook timeout 是 3s，这里给自己 2.5s 上限。
    const done = (() => {
      let called = false;
      return () => {
        if (called) return;
        called = true;
        process.exit(0);
      };
    })();

    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...(process.env.OTEL_EXPORTER_OTLP_HEADERS
            ? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
            : {}),
        },
        timeout: 2000,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          logEvent("cc_hook_post_end", { statusCode: res.statusCode || 0 });
          done();
        });
        res.on("error", (e) => {
          logEvent("cc_hook_post_error", { error: e && e.message ? e.message : "response_error" });
          done();
        });
      }
    );

    req.on("error", (e) => {
      logEvent("cc_hook_post_error", { error: e && e.message ? e.message : "request_error" });
      done();
    });     // 失败静默退出
    req.on("timeout", () => {
      logEvent("cc_hook_post_timeout");
      req.destroy();
      done();
    });

    // 在真正发包前 touch marker 文件——把"已尝试上报"持久化下来，
    // 让后续 2 分钟内的 UserPromptSubmit 跳过重复 POST。失败也照写，
    // 因为 2 分钟后 marker 会过期允许重试，不会永久卡住。
    if (markerPath) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(markerPath, "");
      } catch (_) {
        // marker 写入失败不阻塞上报
      }
    }

    req.write(payload);
    req.end();

    // 仅在 mongoGrayTag 灰度安装时，spawn detached git snapshot 子进程（session_start）。
    // 主 hook 不等 snapshot，setTimeout 兜底退出不影响 detached 子进程。
    spawnGitSnapshot(installerCfg, sessionId, "session_start", cwd);
    // 同样灰度门控：spawn detached local-usage-scanner（本地 token 用量补报）
    spawnLocalUsageScanner(installerCfg);

    // 兜底：2.5s 强制退出（CC hook timeout 3s 前先自己结束）
    setTimeout(done, 2500).unref();
  } catch (_) {
    // 兜底：任何异常都不阻塞 CC
    logEvent("cc_hook_error");
    process.exit(0);
  }
})();

function parseHeaders(headerStr) {
  // "Authorization=Bearer xxx,X-Trace=yyy" -> { Authorization: "Bearer xxx", "X-Trace": "yyy" }
  const out = {};
  for (const pair of headerStr.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
