#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const storage = require("./spool-storage");

let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort only.
}

const INSTALL_DIR = __dirname;
const ENDPOINT_FILE = path.join(INSTALL_DIR, "endpoint.json");
const TOKEN_FILE = path.join(INSTALL_DIR, "raw-upload-token");
const UPLOADER_DIR = path.join(INSTALL_DIR, "raw-uploader");
const STATE_FILE = path.join(UPLOADER_DIR, "state.json");
const LOCK_FILE = path.join(UPLOADER_DIR, "lock");

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RUNTIME_MS = 25 * 1000;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_STABLE_AGE_MS = 15 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeJSONAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === "--once") out.once = true;
    else if (arg.startsWith("--max-runtime=")) out.maxRuntimeSec = Number(arg.slice("--max-runtime=".length));
    else if (arg.startsWith("--max-files=")) out.maxFiles = Number(arg.slice("--max-files=".length));
    else if (arg.startsWith("--max-bytes=")) out.maxBytes = Number(arg.slice("--max-bytes=".length));
  }
  return out;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256String(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function fileBodyKind(fileName) {
  if (/\.request\.json$/i.test(fileName)) return "request";
  if (/\.response\.json$/i.test(fileName)) return "response";
  if (/\.snapshot\.bundle$/i.test(fileName)) return "snapshot"; // git-snapshot.js 落的 git bundle
  return "";
}

function fileToolKind(fileName) {
  // CC 旧文件名保持 snapshot-<session>-...；Codex 快照由通用 snapshot
  // 引擎写成 snapshot-codex-<session>-...。request/response 仍只来自 CC。
  if (/^snapshot-codex-/i.test(fileName)) return "codex";
  return "cc";
}

function isRawBodyFile(fileName) {
  return /\.request\.json$/i.test(fileName) || /\.response\.json$/i.test(fileName) || /\.snapshot\.bundle$/i.test(fileName);
}

function readUploadToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (_) {
    return "";
  }
}

function requestJson(method, targetUrl, body, token, timeoutMs) {
  return requestRaw(method, targetUrl, Buffer.from(JSON.stringify(body || {}), "utf8"), token, {
    "Content-Type": "application/json",
  }, timeoutMs).then((res) => {
    let json = {};
    try {
      json = res.body.length ? JSON.parse(res.body.toString("utf8")) : {};
    } catch (_) {
      json = {};
    }
    return { ...res, json };
  });
}

function requestRaw(method, targetUrl, body, token, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: (url.pathname || "/") + (url.search || ""),
        headers: {
          ...(headers || {}),
          "Content-Length": body.length,
          "X-AI-OTEL-Timestamp": timestamp,
          "X-AI-OTEL-Nonce": nonce,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          if ((res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300) {
            resolve({ statusCode: res.statusCode || 0, body: responseBody });
            return;
          }
          const message = responseBody.toString("utf8").slice(0, 500);
          reject(new Error(`HTTP ${res.statusCode || 0}: ${message}`));
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

function rawUploadBase(url) {
  return String(url || "").replace(/\/+$/, "");
}

function readLockInfo() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch (_) {
    return null;
  }
}

function processAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;
  try {
    process.kill(id, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function removeLockFile() {
  try {
    fs.unlinkSync(LOCK_FILE);
    return true;
  } catch (_) {
    return false;
  }
}

function maybeRecoverStaleLock() {
  const info = readLockInfo();
  const now = Date.now();
  const startedAtMs = Date.parse(info && info.startedAt ? info.startedAt : "");
  const ageMs = Number.isFinite(startedAtMs) ? now - startedAtMs : null;
  const alive = info && info.pid ? processAlive(info.pid) : false;

  if (info && info.pid && !alive) {
    if (removeLockFile()) {
      logEvent("raw_uploader_lock_recovered", {
        reason: "pid_not_alive",
        stalePid: info.pid,
        ageMs: ageMs === null ? "" : ageMs,
      });
      return true;
    }
  }

  if (ageMs !== null && ageMs > LOCK_STALE_MS) {
    if (removeLockFile()) {
      logEvent("raw_uploader_lock_recovered", {
        reason: alive ? "lock_too_old_process_alive" : "lock_too_old",
        stalePid: info && info.pid ? info.pid : "",
        ageMs,
      });
      return true;
    }
  }

  return false;
}

function acquireLock() {
  fs.mkdirSync(UPLOADER_DIR, { recursive: true });
  try {
    const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return fd;
  } catch (e) {
    if (e && e.code === "EEXIST" && maybeRecoverStaleLock()) {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return fd;
    }
    throw e;
  }
}

function releaseLock(fd) {
  try {
    fs.closeSync(fd);
  } catch (_) {}
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

async function* walkRawFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.opendir(dir);
  } catch (_) {
    return;
  }
  for await (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkRawFiles(fullPath);
    } else if (entry.isFile() && isRawBodyFile(entry.name)) {
      yield fullPath;
    }
  }
}

async function stableStat(file) {
  let first;
  try {
    first = await fs.promises.stat(file);
  } catch (_) {
    return null;
  }
  if (!first.isFile() || first.size <= 0) return null;
  if (Date.now() - first.mtimeMs < DEFAULT_STABLE_AGE_MS) return null;
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    const second = await fs.promises.stat(file);
    if (!second.isFile() || second.size !== first.size) return null;
    return second;
  } catch (_) {
    return null;
  }
}

function sourceFileKey(machineId, file, stat) {
  return sha256String(`${machineId}|${path.basename(file)}|${stat.size}|${Math.floor(stat.mtimeMs)}`);
}

function sentPathFor(file) {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(UPLOADER_DIR, "sent", d, path.basename(file));
}

async function moveToSent(file) {
  const dest = sentPathFor(file);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.rename(file, dest);
  } catch (_) {
    await fs.promises.copyFile(file, dest);
    await fs.promises.unlink(file);
  }
  return dest;
}

async function discardRawFile(file, reason) {
  await fs.promises.unlink(file);
  return "";
}

function backoffMs(failures) {
  const steps = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60];
  return steps[Math.min(Math.max(failures - 1, 0), steps.length - 1)] * 1000;
}

function errorText(err) {
  if (!err) return "unknown";
  return String(err.stack || err.message || err).slice(0, 500);
}

function isServerCapabilityError(err) {
  return /inline raw body upload only supports single chunk/i.test(errorText(err));
}

function isDiscardableUploadError(err) {
  const text = errorText(err);
  return /HTTP 413\b/.test(text) ||
    /file_size exceeds max/i.test(text) ||
    /chunk_count exceeds max/i.test(text);
}

function nextBackoffMs(err, failures) {
  if (isServerCapabilityError(err)) return 24 * 60 * 60 * 1000;
  return backoffMs(failures);
}

async function uploadFile(file, stat, cfg, token) {
  const base = rawUploadBase(cfg.rawUploadUrl);
  const machineId = cfg.machineId || cfg.machine_id || "";
  if (!base || !machineId) throw new Error("missing rawUploadUrl or machineId");

  const fileName = path.basename(file);
  const key = sourceFileKey(machineId, file, stat);
  const metadata = {
    machine_id: machineId,
    tool_kind: fileToolKind(fileName),
    file_name: fileName,
    body_kind: fileBodyKind(fileName),
    file_size: stat.size,
    mtime_ms: Math.floor(stat.mtimeMs),
    source_file_key: key,
    installer_version: cfg.installerVersion || cfg.version || "",
    hostname: os.hostname() || "",
    git_user_email: cfg.gitUserEmail || "",
  };

  const init = await requestJson("POST", `${base}/init`, metadata, token, 10000);
  const uploadId = init.json.upload_id;
  const chunkSize = Number(init.json.chunk_size || cfg.rawUploadChunkBytes || DEFAULT_CHUNK_BYTES);
  if (!uploadId) throw new Error("raw upload init missing upload_id");

  const fd = await fs.promises.open(file, "r");
  const hash = crypto.createHash("sha256");
  let index = 0;
  let offset = 0;
  try {
    while (offset < stat.size) {
      const size = Math.min(chunkSize, stat.size - offset);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await fd.read(buffer, 0, size, offset);
      const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      hash.update(chunk);
      const chunkSha = sha256Buffer(chunk);
      await requestRaw(
        "PUT",
        `${base}/${uploadId}/chunks/${index}`,
        chunk,
        token,
        {
          "Content-Type": "application/octet-stream",
          "X-Chunk-SHA256": chunkSha,
        },
        30000
      );
      offset += bytesRead;
      index += 1;
    }
  } finally {
    await fd.close();
  }

  const contentSha = hash.digest("hex");
  const completed = await requestJson("POST", `${base}/${uploadId}/complete`, { content_sha256: contentSha }, token, 30000);
  if (completed.json.upload_status !== "completed" ||
      (completed.json.content_sha256 && completed.json.content_sha256 !== contentSha)) {
    throw new Error("raw upload complete not confirmed");
  }
  return { sourceFileKey: key, contentSha256: contentSha, bytes: stat.size };
}

async function applyDiskGuard(rawBodiesDir, cfg, state, phase, options) {
  const result = storage.maintain(rawBodiesDir, {...cfg, rawUploaderDir: UPLOADER_DIR}, options);
  let discardedFiles = 0;
  let discardedBytes = 0;
  for (const item of result.removed) {
    if (item.kind === "raw" && storage.isRawFile(item.name)) {
      const key = sourceFileKey(cfg.machineId || "", item.file, item);
      state.files[key] = {
        ...state.files[key], uploaded: false, discarded: true,
        discardedAt: new Date().toISOString(), discardReason: item.reason,
        fileName: item.name, bodyKind: fileBodyKind(item.name), bytes: item.size,
        mtimeMs: Math.floor(item.mtimeMs),
      };
      discardedFiles++;
      discardedBytes += item.size;
    }
    logEvent("raw_uploader_file_cleaned", {file: item.name, bytes: item.size, reason: item.reason, phase});
  }
  state.diskGuard = {
    lastCheckedAt: new Date().toISOString(), rawBodiesBytes: result.total,
    spoolBytes: result.total, freeBytes: result.freeBytes,
    hardLimitBytes: result.limits.hard, softLimitBytes: result.limits.soft,
    targetLimitBytes: result.limits.target, minFreeBytes: result.limits.minFree,
    lastCleanedFiles: result.removed.length,
  };
  return {rawBodiesBytes: result.total, discardedFiles, discardedBytes};
}

function pruneState(state, now = Date.now()) {
  // Keep bounded recent receipts for ref retirement and diagnostics. Pending
  // files whose state ages out can safely re-upload using deterministic IDs.
  const entries = Object.entries(state.files || {}).filter(([, item]) => {
    const time = Date.parse(item.uploadedAt || item.discardedAt || item.lastAttemptAt || "");
    return !Number.isFinite(time) || now - time < 30 * storage.DAY;
  });
  entries.sort((a,b) => Date.parse(b[1].uploadedAt || b[1].discardedAt || b[1].lastAttemptAt || 0) -
    Date.parse(a[1].uploadedAt || a[1].discardedAt || a[1].lastAttemptAt || 0));
  state.files = Object.fromEntries(entries.slice(0, 5000));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const maxRuntimeMs = Number.isFinite(args.maxRuntimeSec)
    ? args.maxRuntimeSec * 1000
    : DEFAULT_MAX_RUNTIME_MS;
  const maxFiles = Number.isFinite(args.maxFiles) ? args.maxFiles : DEFAULT_MAX_FILES;
  const maxBytes = Number.isFinite(args.maxBytes) ? args.maxBytes : DEFAULT_MAX_BYTES;
  const startedAt = Date.now();

  let lockFd;
  try {
    lockFd = acquireLock();
  } catch (_) {
    logEvent("raw_uploader_skip", { reason: "locked" });
    return;
  }

  try {
    const cfg = readJSONSafe(ENDPOINT_FILE);
    const rawBodiesDir = cfg.rawBodiesDir || path.join(INSTALL_DIR, "raw-bodies");
    const token = readUploadToken();
    const state = readJSONSafe(STATE_FILE);
    pruneState(state);
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    let failedFiles = 0;
    let discardedFiles = 0;
    let discardedBytes = 0;

    const preGuard = await applyDiskGuard(rawBodiesDir, cfg, state, "before_upload");
    discardedFiles += preGuard.discardedFiles;
    discardedBytes += preGuard.discardedBytes;
    writeJSONAtomic(STATE_FILE, state);
    if (!cfg.rawUploadUrl) {
      logEvent("raw_uploader_skip", {reason: "missing_raw_upload_url", cleaned: true});
      return;
    }

    for await (const file of walkRawFiles(rawBodiesDir)) {
      if (Date.now() - startedAt > maxRuntimeMs) break;
      if (uploadedFiles >= maxFiles || uploadedBytes >= maxBytes) break;

      const stat = await stableStat(file);
      if (!stat) continue;
      const fileName = path.basename(file);
      const bodyKind = fileBodyKind(fileName);
      const key = sourceFileKey(cfg.machineId || "", file, stat);
      const item = state.files[key] || {};
      if (item.uploaded) {
        try {
          await moveToSent(file);
        } catch (_) {}
        continue;
      }
      const nextAttemptAt = Number(item.nextAttemptAt || 0);
      if (nextAttemptAt && Date.now() < nextAttemptAt) {
        if (!(cfg.rawUploadMultipart && item.blockedByServerCapability)) continue;
      }

      try {
        const result = await uploadFile(file, stat, cfg, token);
        await moveToSent(file);
        state.files[key] = {
          uploaded: true,
          uploadedAt: new Date().toISOString(),
          fileName,
          bodyKind,
          bytes: result.bytes,
          mtimeMs: Math.floor(stat.mtimeMs),
          contentSha256: result.contentSha256,
        };
        uploadedFiles += 1;
        uploadedBytes += stat.size;
        logEvent("raw_uploader_file_uploaded", { file: fileName, bytes: stat.size });
      } catch (e) {
        failedFiles += 1;
        const failures = Number(item.failures || 0) + 1;
        const entry = {
          ...item,
          uploaded: false,
          fileName,
          bodyKind,
          bytes: stat.size,
          mtimeMs: Math.floor(stat.mtimeMs),
          failures,
          lastError: errorText(e),
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: Date.now() + nextBackoffMs(e, failures),
        };
        if (isServerCapabilityError(e)) entry.blockedByServerCapability = true;
        state.files[key] = entry;
        logEvent("raw_uploader_file_failed", {
          file: fileName,
          bytes: stat.size,
          failures,
          error: state.files[key].lastError,
        });
        if (isDiscardableUploadError(e)) {
          try {
            const dest = await discardRawFile(file, "upload_rejected");
            state.files[key] = {
              ...state.files[key],
              discarded: true,
              discardedAt: new Date().toISOString(),
              discardReason: "upload_rejected",
              discardedPath: dest,
            };
            discardedFiles += 1;
            discardedBytes += stat.size;
            logEvent("raw_uploader_file_discarded", {
              file: fileName,
              bytes: stat.size,
              reason: "upload_rejected",
            });
          } catch (discardErr) {
            logEvent("raw_uploader_discard_failed", {
              file: fileName,
              bytes: stat.size,
              reason: "upload_rejected",
              error: errorText(discardErr),
            });
          }
        }
      }

      writeJSONAtomic(STATE_FILE, state);
    }

    const postGuard = await applyDiskGuard(rawBodiesDir, cfg, state, "after_upload");
    discardedFiles += postGuard.discardedFiles;
    discardedBytes += postGuard.discardedBytes;
    pruneState(state);
    writeJSONAtomic(STATE_FILE, {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastResult: failedFiles ? "partial_failed" : "ok",
      lastUploadedFiles: uploadedFiles,
      lastUploadedBytes: uploadedBytes,
      lastFailedFiles: failedFiles,
      lastDiscardedFiles: discardedFiles,
      lastDiscardedBytes: discardedBytes,
    });
    logEvent("raw_uploader_done", { uploadedFiles, uploadedBytes, failedFiles, discardedFiles, discardedBytes });
  } finally {
    releaseLock(lockFd);
  }
}

if (require.main === module) {
  run().catch((e) => {
    logEvent("raw_uploader_failed", {
      error: e && e.message ? e.message : "unknown",
    });
    process.exit(1);
  });
}

module.exports.__test__ = {
  fileBodyKind,
  fileToolKind,
  applyDiskGuard,
  pruneState,
};
