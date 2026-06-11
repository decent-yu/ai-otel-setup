#!/usr/bin/env node
/**
 * local-usage-scanner.js
 *
 * 从 ~/.claude/projects/<encoded-cwd>/*.jsonl 计算近 7 天 token 用量按
 * (day, session_id, model) 汇总，POST 到 forwarder /v1/local-usage。
 *
 * 关键约束：
 *   - 由 on-session-start.js spawn 出来的 detached 子进程，主 hook 不阻塞
 *   - 全量装机默认运行；endpoint.json.localUsageEnabled === false 时 skip（用户级 opt-out）
 *   - 5 分钟同 machine_id 内只跑一次（防 SessionStart 高频触发）
 *   - 历史 6 天用 lock 文件跳过；今天总是重算并 upsert
 *   - 失败不冒泡：任何异常都不阻塞主 hook
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const readline = require("readline");
const { URL } = require("url");

let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging best effort
}

const WINDOW_DAYS = 7;
const THROTTLE_MS = 5 * 60 * 1000;
const POST_TIMEOUT_MS = 8000;
const MAX_RUNTIME_MS = 20 * 1000; // 单次扫总耗时上限；watchdog 兜底 60s
const WATCHDOG_MS = 60 * 1000;
const MAX_ROLLS_PER_POST = 500; // 与服务端 maxRolls 对齐，超过本地切批

// 降优先级：扫 jsonl 不与 CC 主进程争 IO/CPU。POSIX setPriority 在 Windows 上会 throw
// （EPERM/ENOSYS），try/catch 包一下，失败也不影响功能。
try {
  if (typeof os.setPriority === "function") os.setPriority(0, 10);
} catch (_) {}

// Watchdog：scanner 卡在 readline / mysql 读时 60s 强退；保护用户机器
const watchdog = setTimeout(() => {
  logEvent("local_usage_watchdog_killed", {});
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

function readJSONSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return {}; }
}

function writeJSONAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

/** +08 墙钟当天 YYYY-MM-DD（与 Doris/DW 同口径） */
function shDayOf(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** 计算窗口：[today-6d ... today]，按 +08 墙钟 */
function buildWindow(nowMs) {
  const days = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    days.push(shDayOf(nowMs - i * 86400 * 1000));
  }
  return days;
}

function readStateFile(installDir) {
  return readJSONSafe(path.join(installDir, "local-usage-state.json"));
}

function writeStateFile(installDir, state) {
  writeJSONAtomic(path.join(installDir, "local-usage-state.json"), state);
}

function throttleCheck(machineId, nowMs) {
  const markerPath = path.join(os.homedir(), ".claude", "cc-otel-state", `local-usage-${machineId}.flag`);
  try {
    const mtime = fs.statSync(markerPath).mtimeMs;
    if (nowMs - mtime < THROTTLE_MS) return false;
  } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, "");
  } catch (_) {}
  return true;
}

async function* walkProjectFiles(root) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(root, e.name);
    let files;
    try { files = await fs.promises.readdir(sub); } catch (_) { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) yield path.join(sub, f);
  }
}

/** 把 jsonl 一行解析为 assistant.usage 事件；非 assistant 或无 usage 返回 null */
function parseAssistantRow(line) {
  if (!line.includes('"type":"assistant"') || !line.includes("usage")) return null;
  try {
    const o = JSON.parse(line);
    if (o.type !== "assistant" || !o.message || !o.message.usage) return null;
    const ts = Date.parse(o.timestamp || "");
    if (!Number.isFinite(ts)) return null;
    return {
      ts,
      sid: o.sessionId || "",
      model: o.message.model || "unknown",
      cwd: o.cwd || "",
      input: Number(o.message.usage.input_tokens) || 0,
      output: Number(o.message.usage.output_tokens) || 0,
      cache_r: Number(o.message.usage.cache_read_input_tokens) || 0,
      cache_w: Number(o.message.usage.cache_creation_input_tokens) || 0,
    };
  } catch (_) { return null; }
}

/** 从 cwd 的 .git/config 读 origin url（best effort，不跑 git 子进程）
 *  同一 cwd 跨 buckets 调用多次，加 cache 防重复磁盘读 */
const gitRemoteCache = new Map();
function tryReadGitRemote(cwd) {
  if (!cwd) return "";
  if (gitRemoteCache.has(cwd)) return gitRemoteCache.get(cwd);
  let remote = "";
  try {
    const configPath = path.join(cwd, ".git", "config");
    const txt = fs.readFileSync(configPath, "utf8");
    const m = txt.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/);
    remote = m ? m[1].trim() : "";
  } catch (_) {}
  gitRemoteCache.set(cwd, remote);
  return remote;
}

// ===== Codex 解析 =====
// 文件：~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<uuid>.jsonl
//      ~/.codex/archived_sessions/rollout-<ts>-<uuid>.jsonl
// 关键差异（vs CC）：
//   - token_count 事件是【累计值】，需 delta = curr.total - prev.total
//   - model 在 turn_context 行里，可能跨 turn 变；逐事件跟随
//   - session_id 在 session_meta.payload.id，与文件名 uuid 一致
async function* walkCodexJsonl(root) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* walkCodexJsonl(full);
    } else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

function sidFromCodexFilename(name) {
  const m = name.match(/rollout-[\d\-T]+-([0-9a-f-]{36})\.jsonl/i);
  return m ? m[1] : "";
}

async function aggregateCodex(targetDays, roots, deadlineMs) {
  const targetSet = new Set(targetDays);
  const cutoffMs = Date.now() - (WINDOW_DAYS + 2) * 86400 * 1000;
  const buckets = new Map();
  for (const root of roots) {
    for await (const file of walkCodexJsonl(root)) {
      if (deadlineMs && Date.now() > deadlineMs) return [...buckets.values()];
      let st;
      try { st = await fs.promises.stat(file); } catch (_) { continue; }
      if (st.mtimeMs < cutoffMs) continue;
      let sessionId = sidFromCodexFilename(path.basename(file));
      let cwd = "";
      let currentModel = "";
      let prev = null;
      const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          const ts = Date.parse(o.timestamp || "");
          if (!Number.isFinite(ts)) continue;
          if (o.type === "session_meta" && o.payload) {
            sessionId = o.payload.id || sessionId;
            cwd = o.payload.cwd || cwd;
            continue;
          }
          if (o.type === "turn_context") {
            const m = o.payload?.model || o.model;
            if (m) currentModel = String(m);
            continue;
          }
          if (o.type !== "event_msg" || o.payload?.type !== "token_count") continue;
          const u = o.payload.info?.total_token_usage;
          if (!u) continue;
          const curr = {
            input: Number(u.input_tokens || 0),
            cache_r: Number(u.cached_input_tokens || 0),
            output: Number(u.output_tokens || 0),
            reasoning: Number(u.reasoning_output_tokens || 0),
          };
          // delta：第一条事件直接用累计值；之后用差值（避免负数 → 0 兜底）
          const delta = prev ? {
            input: Math.max(0, curr.input - prev.input),
            cache_r: Math.max(0, curr.cache_r - prev.cache_r),
            output: Math.max(0, curr.output - prev.output),
            reasoning: Math.max(0, curr.reasoning - prev.reasoning),
          } : curr;
          prev = curr;
          const day = shDayOf(ts);
          if (!targetSet.has(day)) continue;
          if (!sessionId) continue;
          const model = currentModel || "unknown";
          const key = `${day}|${sessionId}|${model}`;
          let b = buckets.get(key);
          if (!b) {
            b = { day, session_id: sessionId, model, cwd, messages: 0, input: 0, output: 0, cache_r: 0, cache_w: 0, first_ts: ts, last_ts: ts };
            buckets.set(key, b);
          }
          b.messages++;
          b.input += delta.input;
          b.output += delta.output + delta.reasoning; // reasoning_output 算进 output
          b.cache_r += delta.cache_r;
          // codex 无 cache_w 概念，保持 0
          if (ts < b.first_ts) b.first_ts = ts;
          if (ts > b.last_ts) b.last_ts = ts;
          if (!b.cwd) b.cwd = cwd;
        } catch (_) {}
      }
    }
  }
  return [...buckets.values()];
}

async function aggregate(targetDays, projectsRoot, deadlineMs) {
  // key: `${day}|${sid}|${model}` → bucket
  const targetSet = new Set(targetDays);
  const cutoffMs = Date.now() - (WINDOW_DAYS + 2) * 86400 * 1000; // 留 2 天 buffer 防文件 mtime 早于 message ts
  const buckets = new Map();
  for await (const file of walkProjectFiles(projectsRoot)) {
    if (deadlineMs && Date.now() > deadlineMs) return [...buckets.values()];
    let st;
    try { st = await fs.promises.stat(file); } catch (_) { continue; }
    if (st.mtimeMs < cutoffMs) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of rl) {
      const row = parseAssistantRow(line);
      if (!row) continue;
      const day = shDayOf(row.ts);
      if (!targetSet.has(day)) continue;
      const key = `${day}|${row.sid}|${row.model}`;
      let b = buckets.get(key);
      if (!b) {
        b = { day, session_id: row.sid, model: row.model, cwd: row.cwd, messages: 0, input: 0, output: 0, cache_r: 0, cache_w: 0, first_ts: row.ts, last_ts: row.ts };
        buckets.set(key, b);
      }
      b.messages++;
      b.input += row.input;
      b.output += row.output;
      b.cache_r += row.cache_r;
      b.cache_w += row.cache_w;
      if (row.ts < b.first_ts) b.first_ts = row.ts;
      if (row.ts > b.last_ts) b.last_ts = row.ts;
      if (!b.cwd) b.cwd = row.cwd;
    }
  }
  return [...buckets.values()];
}

function postJson(url, body, token, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (_) { return resolve({ status: 0, error: "bad url" }); }
    const lib = u.protocol === "https:" ? https : http;
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + (u.search || ""),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": raw.length,
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.write(raw);
    req.end();
  });
}

function readUploadToken(installDir) {
  try { return fs.readFileSync(path.join(installDir, "raw-upload-token"), "utf8").trim(); } catch (_) { return ""; }
}

/** rolls > MAX_ROLLS_PER_POST 时切批分发，所有批都 2xx 才认为成功 */
async function postRollsBatched(url, baseEnvelope, source, rolls, token, timeoutMs) {
  if (rolls.length === 0) return { ok: true, batches: 0, totalRolls: 0 };
  const batches = [];
  for (let i = 0; i < rolls.length; i += MAX_ROLLS_PER_POST) {
    batches.push(rolls.slice(i, i + MAX_ROLLS_PER_POST));
  }
  let allOk = true;
  let lastStatus = 0;
  let lastError = "";
  for (const batch of batches) {
    const res = await postJson(url, { ...baseEnvelope, source, rolls: batch }, token, timeoutMs);
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      allOk = false;
      lastStatus = res.status;
      lastError = res.error || (res.body || "").slice(0, 200);
      // 单批失败立刻停：后续批同 endpoint 多半也失败，避免浪费
      break;
    }
    lastStatus = res.status;
  }
  return { ok: allOk, batches: batches.length, totalRolls: rolls.length, status: lastStatus, error: lastError };
}

(async () => {
  try {
    const installDir = __dirname;
    const cfg = readJSONSafe(path.join(installDir, "endpoint.json"));
    // v1.0.32：去除 mongoGrayTag 门控，全量装机默认运行。
    // 用户级 opt-out：localUsageEnabled === false 时跳过；老配置无此字段视同 true。
    if (cfg.localUsageEnabled === false) {
      logEvent("local_usage_skip", { reason: "user_opted_out" });
      return;
    }
    if (!cfg.localUsageUrl) {
      logEvent("local_usage_skip", { reason: "no_localUsageUrl" });
      return;
    }
    const machineId = cfg.machineId || "";
    if (!machineId) {
      logEvent("local_usage_skip", { reason: "no_machine_id" });
      return;
    }
    const nowMs = Date.now();
    if (!throttleCheck(machineId, nowMs)) {
      logEvent("local_usage_skip", { reason: "throttled" });
      return;
    }

    const startedAt = nowMs;
    const deadlineMs = startedAt + MAX_RUNTIME_MS;

    const today = shDayOf(nowMs);
    const window = buildWindow(nowMs);
    const state = readStateFile(installDir);
    state.machine_id = machineId;
    state.locked_days = state.locked_days || {};

    // 历史天若锁住则跳过；今天必扫
    const targetDays = window.filter((d) => d === today || !state.locked_days[d]);
    logEvent("local_usage_start", {
      window: window.join(","),
      targetDays: targetDays.join(","),
      lockedCount: Object.keys(state.locked_days).length,
    });

    const token = cfg.hasUploadToken ? readUploadToken(installDir) : "";
    const baseEnvelope = {
      machine_id: machineId,
      installer_version: cfg.installerVersion || "",
      git_user_email: cfg.gitUserEmail || "",
      hostname: os.hostname() || "",
      mongo_gray: cfg.mongoGrayTag || "",
      today_local: today,
      window_days: WINDOW_DAYS,
    };

    function bucketsToRolls(buckets) {
      return buckets.map((b) => ({
        day: b.day,
        session_id: b.session_id,
        model: b.model,
        workspace_name: b.cwd ? path.basename(b.cwd) : "",
        git_remote: b.cwd ? tryReadGitRemote(b.cwd) : "",
        messages: b.messages,
        input_tokens: b.input,
        output_tokens: b.output,
        cache_read_tokens: b.cache_r,
        cache_creation_tokens: b.cache_w,
        first_msg_ts: new Date(b.first_ts).toISOString(),
        last_msg_ts: new Date(b.last_ts).toISOString(),
      }));
    }

    // ===== CC =====
    const ccBuckets = await aggregate(targetDays, path.join(os.homedir(), ".claude", "projects"), deadlineMs);
    const ccRolls = bucketsToRolls(ccBuckets);
    let ccOk = true; // 默认 ok（无 rolls 视为不需要发）
    if (ccRolls.length > 0) {
      const res = await postRollsBatched(cfg.localUsageUrl, baseEnvelope, "cc", ccRolls, token, POST_TIMEOUT_MS);
      ccOk = res.ok;
      if (ccOk) {
        logEvent("local_usage_post_ok", { source: "cc", batches: res.batches, rolls: res.totalRolls });
      } else {
        logEvent("local_usage_post_fail", { source: "cc", status: res.status, error: res.error });
      }
    } else {
      logEvent("local_usage_done", { source: "cc", reason: "no_rolls" });
    }

    // ===== Codex =====
    const codexBuckets = await aggregateCodex(targetDays, [
      path.join(os.homedir(), ".codex", "sessions"),
      path.join(os.homedir(), ".codex", "archived_sessions"),
    ], deadlineMs);
    const codexRolls = bucketsToRolls(codexBuckets);
    let codexOk = true;
    if (codexRolls.length > 0) {
      const res = await postRollsBatched(cfg.localUsageUrl, baseEnvelope, "codex", codexRolls, token, POST_TIMEOUT_MS);
      codexOk = res.ok;
      if (codexOk) {
        logEvent("local_usage_post_ok", { source: "codex", batches: res.batches, rolls: res.totalRolls });
      } else {
        logEvent("local_usage_post_fail", { source: "codex", status: res.status, error: res.error });
      }
    } else {
      logEvent("local_usage_done", { source: "codex", reason: "no_rolls" });
    }

    // 两源都 ok（或都没数据）才锁历史天
    state.last_run_at = new Date(nowMs).toISOString();
    state.last_rolls_count = ccRolls.length + codexRolls.length;
    if (ccOk && codexOk) {
      for (const d of targetDays) {
        if (d !== today) state.locked_days[d] = new Date(nowMs).toISOString();
      }
      state.last_status = "ok";
    } else {
      state.last_status = `partial:cc=${ccOk ? "ok" : "fail"},codex=${codexOk ? "ok" : "fail"}`;
    }
    writeStateFile(installDir, state);
  } catch (e) {
    logEvent("local_usage_error", { error: (e && e.message) || "unknown" });
  }
})();
