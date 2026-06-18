#!/usr/bin/env node
"use strict";

// 跨平台 hook 启动器：优先 PATH 上的 node（用户升级 Node 时自动跟新版本），
// 找不到再用安装时这台机器上 node 的绝对路径（即当前进程的 execPath，一定可用）。
// 改用 JS 内部兜底替代 shell `||` 操作符链——PowerShell 5.1（Win10/11 默认 shell）
// 不支持 `||`，cc/gemini 在 Windows 上默认走 PowerShell，会被坑。统一在 JS 里兜底
// 后，命令字符串变成纯 `<node> <launcher> <hook>` 三段绝对路径调用，对 shell 透明，
// POSIX sh / cmd.exe / PowerShell 5.1 / PowerShell 7 全 cover。
//
// stdio: "inherit"：stdin（Codex/CC 传 hook payload JSON）、stderr 都直通给 hook
// 子进程，hook 那边的 readStdin / process.stderr 行为不受影响。退出码原样转发。

const { spawnSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort; old installs may not have logging.js yet.
}

const PACKAGE_NAME = "ai-otel-setup";
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const RAW_UPLOAD_TRIGGER_INTERVAL_MS = 60 * 1000;

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeJSONSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i++) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function npmBin(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runNpmToolSync(name, args, options) {
  const command = npmBin(name);
  return execFileSync(command, args, {
    ...options,
    // Windows cannot reliably exec .cmd shims directly via execFileSync.
    shell: process.platform === "win32",
  });
}

function runAutoUpdate(installDir) {
  const statePath = path.join(installDir, "auto-update-state.json");
  const cfg = readJSONSafe(path.join(installDir, "endpoint.json"));
  const state = readJSONSafe(statePath);
  const now = Date.now();
  logEvent("auto_update_start", {
    currentVersion: cfg.installerVersion || cfg.version || "0.0.0",
  });

  if (!cfg.endpoint) {
    writeJSONSafe(statePath, { ...state, lastFinishedAt: now, lastResult: "skipped" });
    logEvent("auto_update_skipped", { reason: "missing_endpoint" });
    return;
  }

  const currentVersion = cfg.installerVersion || cfg.version || "0.0.0";
  try {
    const latestVersion = runNpmToolSync("npm", ["view", PACKAGE_NAME, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
      windowsHide: true,
    }).trim();

    if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
      writeJSONSafe(statePath, {
        ...state,
        currentVersion,
        latestVersion,
        lastFinishedAt: now,
        lastResult: "up-to-date",
      });
      logEvent("auto_update_up_to_date", { currentVersion, latestVersion });
      return;
    }

    logEvent("auto_update_install_start", { currentVersion, latestVersion });
    const installArgs = ["-y", `${PACKAGE_NAME}@${latestVersion}`, `url=${cfg.endpoint}`];
    if (cfg.otelTransport === "http") installArgs.push("--http");
    if (cfg.otelTransport === "grpc" && process.platform === "win32") installArgs.push("--grpc");
    // 透传 --beta：保留用户首次装机时的全量上报选择。fullUpload 是新字段（v1.1.0+），
    // mongoGrayTag 是老字段（≤v1.0.x 残留），二者任一为真即认为应继续全量。
    // 不传等于 auto-update 抹掉 beta（mergeSettings 会 delete 残留的 ai_otel.mongo_gray attr）。
    if (cfg.fullUpload === true || cfg.mongoGrayTag) installArgs.push("--beta");
    runNpmToolSync("npx", installArgs, {
      stdio: "ignore",
      timeout: 120000,
      windowsHide: true,
      env: { ...process.env, AI_OTEL_AUTO_UPDATE: "1" },
    });

    writeJSONSafe(statePath, {
      ...state,
      previousVersion: currentVersion,
      latestVersion,
      lastFinishedAt: Date.now(),
      lastResult: "updated",
    });
    logEvent("auto_update_updated", { previousVersion: currentVersion, latestVersion });
  } catch (e) {
    writeJSONSafe(statePath, {
      ...state,
      currentVersion,
      lastFinishedAt: Date.now(),
      lastResult: "failed",
      lastError: e && e.message ? String(e.message).slice(0, 300) : "unknown",
    });
    logEvent("auto_update_failed", {
      currentVersion,
      error: e && e.message ? e.message : "unknown",
    });
  }
}

function maybeSpawnAutoUpdate(nodeBin, installDir) {
  const cfgPath = path.join(installDir, "endpoint.json");
  if (!fs.existsSync(cfgPath)) return;

  const statePath = path.join(installDir, "auto-update-state.json");
  const state = readJSONSafe(statePath);
  const now = Date.now();
  const lastAttemptAt = Number(state.lastAttemptAt || 0);
  const shouldRetrySoon =
    state.lastResult === "failed" ||
    state.lastResult === "scheduled" ||
    state.lastResult === "spawn-failed";
  const interval = shouldRetrySoon ? UPDATE_RETRY_INTERVAL_MS : UPDATE_CHECK_INTERVAL_MS;
  if (lastAttemptAt && now - lastAttemptAt < interval) return;

  if (!writeJSONSafe(statePath, { ...state, lastAttemptAt: now, lastResult: "scheduled" })) return;

  try {
    const child = spawn(nodeBin, [__filename, "--auto-update", installDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logEvent("auto_update_scheduled", { lastResult: state.lastResult || "" });
  } catch (_) {
    writeJSONSafe(statePath, { ...state, lastAttemptAt: now, lastResult: "spawn-failed" });
    logEvent("auto_update_spawn_failed");
  }
}

function maybeSpawnRawUploader(nodeBin, installDir) {
  const uploaderPath = path.join(installDir, "raw-body-uploader.js");
  if (!fs.existsSync(uploaderPath)) return;

  const cfg = readJSONSafe(path.join(installDir, "endpoint.json"));
  if (!cfg.rawUploadUrl) return;

  const statePath = path.join(installDir, "raw-uploader-trigger-state.json");
  const state = readJSONSafe(statePath);
  const now = Date.now();
  const lastAttemptAt = Number(state.lastAttemptAt || 0);
  if (lastAttemptAt && now - lastAttemptAt < RAW_UPLOAD_TRIGGER_INTERVAL_MS) return;
  if (!writeJSONSafe(statePath, { ...state, lastAttemptAt: now, lastResult: "scheduled" })) return;

  try {
    // detached + unref，不阻塞会话；uploader 内有 lock 防并发，故放大单次清空量：
    // runtime 25→240s、files 50→2000、bytes 200MB→1GB，让 runtime 成为唯一瓶颈，
    // 重度用户即便 Windows 定时器没生效，仅靠 hook 触发也能追上生成速度（约 1.3 文件/秒）。
    const child = spawn(nodeBin, [uploaderPath, "--once", "--max-runtime=240", "--max-files=2000", "--max-bytes=1073741824"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    logEvent("raw_uploader_scheduled", { reason: "hook_trigger" });
  } catch (e) {
    writeJSONSafe(statePath, {
      ...state,
      lastAttemptAt: now,
      lastResult: "spawn-failed",
      lastError: e && e.message ? String(e.message).slice(0, 300) : "unknown",
    });
    logEvent("raw_uploader_spawn_failed", {
      error: e && e.message ? e.message : "unknown",
    });
  }
}

function hookEnvSnapshot() {
  return {
    hookEnvTelemetryEnabled: process.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1",
    hookEnvHasOtlpEndpoint: !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    hookEnvOtlpProtocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL || "",
    hookEnvLogsExporter: process.env.OTEL_LOGS_EXPORTER || "",
  };
}

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch (_) {
    return "";
  }
}

function settingsTelemetrySnapshot(installDir) {
  const settingsPath = path.join(path.dirname(installDir), "settings.json");
  const settings = readJSONSafe(settingsPath);
  const env = settings.env || {};
  const cfg = readJSONSafe(path.join(installDir, "endpoint.json"));
  const host = endpointHost(cfg.endpoint || "");
  const noProxy = `${env.NO_PROXY || ""},${env.no_proxy || ""}`;
  return {
    settingsTelemetryEnabled: env.CLAUDE_CODE_ENABLE_TELEMETRY === "1",
    settingsHasOtlpEndpoint: !!env.OTEL_EXPORTER_OTLP_ENDPOINT,
    settingsOtlpProtocol: env.OTEL_EXPORTER_OTLP_PROTOCOL || "",
    settingsLogsExporter: env.OTEL_LOGS_EXPORTER || "",
    settingsMetricsExporter: env.OTEL_METRICS_EXPORTER || "",
    settingsHasOtlpLogsEndpoint: !!env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    settingsHasOtlpMetricsEndpoint: !!env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    settingsNoProxyHasCollector: host ? noProxy.split(",").map((s) => s.trim()).some((s) => s === host || s.startsWith(`${host}:`)) : false,
  };
}

if (process.argv[2] === "--auto-update") {
  runAutoUpdate(process.argv[3] || __dirname);
  process.exit(0);
}

const scriptPath = process.argv[2];
if (!scriptPath) process.exit(0);

let nodeBin = process.execPath;
try {
  // -v 只打版本号立即退出，用来探 PATH 上是否有可执行 node。
  // timeout 防 PATH 上的 "node" 是个会卡住的 wrapper（极少见但存在）。
  execFileSync("node", ["-v"], { stdio: "ignore", timeout: 1500, windowsHide: true });
  nodeBin = "node";
} catch (_) {
  // PATH 上没 node 或探测失败 → 沿用当前进程 execPath（即 installer 焊死的那条
  // 绝对路径）。注意此时如果用户连 baked 那个版本也卸了，那 launcher 自己根本就
  // 启动不起来，根本走不到这里——也就是说 hook 真挂的时候用户会感知到，符合
  // 不静默吞错的预期。
}

maybeSpawnAutoUpdate(nodeBin, __dirname);
maybeSpawnRawUploader(nodeBin, __dirname);

const startedAt = Date.now();
logEvent("hook_launcher_start", {
  script: path.basename(scriptPath),
  ...hookEnvSnapshot(),
  ...settingsTelemetrySnapshot(__dirname),
});
const r = spawnSync(nodeBin, [scriptPath], { stdio: "inherit", windowsHide: true });
logEvent("hook_launcher_exit", {
  script: path.basename(scriptPath),
  status: r.status === null ? 1 : r.status,
  signal: r.signal || "",
  durationMs: Date.now() - startedAt,
});
// status 为 null 表示进程被信号杀掉（SIGTERM 等），按 1 处理
process.exit(r.status === null ? 1 : r.status);
