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

const PACKAGE_NAME = "ai-otel-setup";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_INTERVAL_MS = 10 * 60 * 1000;

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

function runAutoUpdate(installDir) {
  const statePath = path.join(installDir, "auto-update-state.json");
  const cfg = readJSONSafe(path.join(installDir, "endpoint.json"));
  const state = readJSONSafe(statePath);
  const now = Date.now();

  if (!cfg.endpoint) {
    writeJSONSafe(statePath, { ...state, lastFinishedAt: now, lastResult: "skipped" });
    return;
  }

  const currentVersion = cfg.installerVersion || cfg.version || "0.0.0";
  try {
    const latestVersion = execFileSync(npmBin("npm"), ["view", PACKAGE_NAME, "version"], {
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
      return;
    }

    execFileSync(npmBin("npx"), ["-y", `${PACKAGE_NAME}@${latestVersion}`, `url=${cfg.endpoint}`], {
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
  } catch (e) {
    writeJSONSafe(statePath, {
      ...state,
      currentVersion,
      lastFinishedAt: Date.now(),
      lastResult: "failed",
      lastError: e && e.message ? String(e.message).slice(0, 300) : "unknown",
    });
  }
}

function maybeSpawnAutoUpdate(nodeBin, installDir) {
  if (process.env.AI_OTEL_ENABLE_AUTO_UPDATE !== "1") return;

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
  } catch (_) {
    writeJSONSafe(statePath, { ...state, lastAttemptAt: now, lastResult: "spawn-failed" });
  }
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
  execFileSync("node", ["-v"], { stdio: "ignore", timeout: 1500 });
  nodeBin = "node";
} catch (_) {
  // PATH 上没 node 或探测失败 → 沿用当前进程 execPath（即 installer 焊死的那条
  // 绝对路径）。注意此时如果用户连 baked 那个版本也卸了，那 launcher 自己根本就
  // 启动不起来，根本走不到这里——也就是说 hook 真挂的时候用户会感知到，符合
  // 不静默吞错的预期。
}

maybeSpawnAutoUpdate(nodeBin, __dirname);

const r = spawnSync(nodeBin, [scriptPath], { stdio: "inherit" });
// status 为 null 表示进程被信号杀掉（SIGTERM 等），按 1 处理
process.exit(r.status === null ? 1 : r.status);
