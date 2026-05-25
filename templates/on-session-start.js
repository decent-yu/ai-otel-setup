#!/usr/bin/env node
/**
 * SessionStart / UserPromptSubmit 兜底 hook
 *
 * 职责：
 *   采集 CC 原生 OTel 不覆盖的 5 个字段（cwd / git_remote / git_user_email /
 *   git_user_name / hostname），通过 OTLP/HTTP 4318 发给 Collector，
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

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

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
    })
      .toString()
      .trim();
  } catch (_) {
    return null;
  }
}

function markerFile(prefix, id) {
  const digest = crypto.createHash("sha256").update(String(id || "")).digest("hex").slice(0, 32);
  return `${prefix}-${digest}.flag`;
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
    // CC 在 stdin 里告诉脚本是哪个 hook 触发的；UserPromptSubmit 走"兜底"分支
    const isPromptFallback = input.hook_event_name === "UserPromptSubmit";

    // 兜底路径节流：sid 维度 2 分钟最多一次（marker 文件 mtime 判断）。
    // 失败重试窗口同时由此控制：marker 过期后允许下次 prompt 再发一次。
    const stateDir = path.join(os.homedir(), ".claude", "cc-otel-state");
    const markerPath = sessionId ? path.join(stateDir, markerFile("sent", sessionId)) : null;
    if (isPromptFallback && markerPath && fs.existsSync(markerPath)) {
      try {
        const mtime = fs.statSync(markerPath).mtimeMs;
        if (Date.now() - mtime < PROMPT_THROTTLE_MS) {
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
      "data_source": "hook", // Collector 端用 insert 而非 upsert 以保留本标签
    };

    const logsEndpoint = resolveLogsEndpoint();
    const payload = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [],
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
        res.on("end", done);
        res.on("error", done);
      }
    );

    req.on("error", done);     // 失败静默退出
    req.on("timeout", () => { req.destroy(); done(); });

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

    // 兜底：2.5s 强制退出（CC hook timeout 3s 前先自己结束）
    setTimeout(done, 2500).unref();
  } catch (_) {
    // 兜底：任何异常都不阻塞 CC
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
