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

const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
let logEvent = () => {};
try {
  ({ logEvent } = require("./logging.js"));
} catch (_) {
  // Logging is best effort; old installs may not have logging.js yet.
}

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
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

const scriptPath = process.argv[2];
if (!scriptPath) process.exit(0);

let nodeBin = process.execPath;
try {
  // -v 只打版本号立即退出，用来探 PATH 上是否有可执行 node。
  // timeout 防 PATH 上的 "node" 是个会卡住的 wrapper（极少见但存在）。
  execFileSync("node", ["-v"], { stdio: "ignore", timeout: 1500 });
  nodeBin = "node";
} catch (_) {
  // PATH 上没 node 或探测失败 → 沿用当前进程 execPath（即 installer 焊死的那条
  // 绝对路径）。注意此时如果用户连 baked 那个版本也卸了，那 launcher 自己根本就
  // 启动不起来，根本走不到这里——也就是说 hook 真挂的时候用户会感知到，符合
  // 不静默吞错的预期。
}

const startedAt = Date.now();
logEvent("hook_launcher_start", {
  script: path.basename(scriptPath),
  ...hookEnvSnapshot(),
  ...settingsTelemetrySnapshot(__dirname),
});
const r = spawnSync(nodeBin, [scriptPath], { stdio: "inherit" });
logEvent("hook_launcher_exit", {
  script: path.basename(scriptPath),
  status: r.status === null ? 1 : r.status,
  signal: r.signal || "",
  durationMs: Date.now() - startedAt,
});
// status 为 null 表示进程被信号杀掉（SIGTERM 等），按 1 处理
process.exit(r.status === null ? 1 : r.status);
