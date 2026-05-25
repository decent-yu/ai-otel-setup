#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function safeGit(args) {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
  } catch (_) {
    return "";
  }
}

function seenFile(id) {
  const digest = crypto.createHash("sha256").update(String(id || "")).digest("hex").slice(0, 32);
  return `.session-seen.${digest}`;
}

// 解析 OTLP/HTTP logs endpoint。优先级：env 覆盖 → installer 写在 hook 同目录的
// endpoint.json → localhost 兜底。原本走 shell 前缀 `AI_OTEL_LOGS_ENDPOINT=...` 注入
// env，但那是 POSIX 独有语法、cmd.exe 把它当程序名就 G 了，所以 v1.0.4 起命令行
// 不再带前缀，改让脚本自己读 endpoint.json，跨平台统一。env 留作 debug 覆盖口。
function endpoint() {
  if (process.env.AI_OTEL_LOGS_ENDPOINT) return process.env.AI_OTEL_LOGS_ENDPOINT;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "endpoint.json"), "utf8"));
    if (cfg && cfg.logsEndpoint) return cfg.logsEndpoint;
  } catch (_) { /* 文件不存在/解析失败：继续走 localhost */ }
  return "http://localhost:4318/v1/logs";
}

(async () => {
  try {
    const raw = await readStdin();
    let input = {};
    try { input = JSON.parse(raw || "{}"); } catch (_) {}
    const conversation = input.conversation || {};
    const sid = conversation.id || input.conversation_id || input.session_id || "";
    const seen = path.join(os.homedir(), ".codex", "ai-otel", seenFile(sid || "unknown"));
    if (sid && fs.existsSync(seen)) process.exit(0);
    // 注意：seen 文件必须在 OTLP 发送成功后才写——见下方 res.on("end")。
    // 之前在此处直接写盘，会导致 collector 暂时不可用时第一次失败也被记为
    // "已上报"，从此 codex resume 同一 conversation 永远跳过 hook_session_start。

    const cwd = input.cwd || process.cwd();
    const event = {
      "tool_kind": "codex",
      "event.name": "hook_session_start",
      "session.id": sid,
      "cwd": cwd,
      "project.name": path.basename(cwd),
      "git.remote": safeGit(["-C", cwd, "config", "--get", "remote.origin.url"]),
      "git.user.email": safeGit(["-C", cwd, "config", "user.email"]),
      "git.user.name": safeGit(["-C", cwd, "config", "user.name"]),
      "hostname": os.hostname() || "",
      "data_source": "hook",
    };
    const payload = JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: `${Date.now()}000000`, body: { stringValue: "hook_session_start" }, attributes: Object.entries(event).map(([key, value]) => ({ key, value: { stringValue: String(value ?? "") } })) }] }] }] });
    const url = new URL(endpoint());
    const markSeen = () => { if (sid) { try { fs.writeFileSync(seen, String(Date.now())); } catch (_) {} } };
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => {
        // 仅 2xx 才视为成功——4xx/5xx 留给下次启动重试，避免静默丢失
        if (res.statusCode >= 200 && res.statusCode < 300) markSeen();
        process.exit(0);
      });
    });
    req.on("error", () => process.exit(0));
    req.on("timeout", () => { req.destroy(); process.exit(0); });
    req.end(payload);
    setTimeout(() => process.exit(0), 2500).unref();
  } catch (_) {
    process.exit(0);
  }
})();
