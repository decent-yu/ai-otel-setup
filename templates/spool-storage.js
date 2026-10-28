"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS = {
  rawBodiesSoftLimitBytes: 256 * MiB,
  rawBodiesHardLimitBytes: 512 * MiB,
  rawBodiesTargetLimitBytes: 256 * MiB,
  rawBodiesMinFreeBytes: 1024 * MiB,
  gitSnapshotBundleMaxBytes: 32 * MiB,
  gitSnapshotWorkspaceMaxBytes: 32 * MiB,
  gitSnapshotFileMaxBytes: 8 * MiB,
  gitSnapshotWorkspaceMaxFiles: 1000,
  gitSnapshotMaxRefs: 256,
};

function positive(cfg, key, fallback = DEFAULTS[key]) {
  const n = Number(cfg && cfg[key]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function limits(cfg) {
  const hard = positive(cfg, "rawBodiesHardLimitBytes");
  return {
    hard,
    soft: Math.min(positive(cfg, "rawBodiesSoftLimitBytes"), hard),
    target: Math.min(positive(cfg, "rawBodiesTargetLimitBytes"), hard),
    minFree: positive(cfg, "rawBodiesMinFreeBytes"),
  };
}

function isRawFile(name) {
  return /\.(?:request\.json|response\.json|snapshot\.bundle)$/i.test(name);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}

function uploaderDir(rawDir, cfg) {
  return cfg.rawUploaderDir || path.join(path.dirname(rawDir), "raw-uploader");
}

// Only traverse our explicit roots, and never follow a symlink out of the spool.
function inventory(rawDir, cfg = {}) {
  const files = [];
  const upload = path.resolve(uploaderDir(rawDir, cfg));
  const rawRoot = path.resolve(rawDir);
  function walk(dir, kind) {
    let entries;
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw new Error("spool root must be a real directory");
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const full = path.resolve(file);
        if (kind === "metadata" && full === rawRoot) continue;
        const next = full === upload ? "metadata" : full === path.join(upload,"sent") ? "sent" :
          full === path.join(upload,"discarded") ? "discarded" : kind;
        walk(file, next);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile()) continue;
        files.push({ file, name: entry.name, kind, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  walk(rawDir, "raw");
  const relative = path.relative(rawRoot, upload);
  const insideRaw = relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  if (!insideRaw) walk(upload, "metadata");
  return { files, total: files.reduce((sum, item) => sum + item.size, 0) };
}

function freeBytes(dir) {
  if (!fs.statfsSync) return null;
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

function readOwner(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function acquireWriter(rawDir) {
  fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
  const file = path.join(rawDir, ".snapshot-writer.lock");
  const token = crypto.randomBytes(12).toString("hex");
  const create = () => {
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({pid: process.pid, token})); }
    finally { fs.closeSync(fd); }
  };
  try { create(); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const owner = readOwner(file);
    // Missing/partial owner can be the tiny create/write window: never steal it.
    if (!owner || !Number.isInteger(owner.pid) || alive(owner.pid)) return null;
    const current = readOwner(file);
    if (!current || current.token !== owner.token) return null;
    try { fs.unlinkSync(file); create(); } catch (_) { return null; }
  }
  return () => {
    const owner = readOwner(file);
    if (owner && owner.token === token) fs.unlinkSync(file);
  };
}

function temporary(item, now) {
  const stateWrite = item.kind === "metadata" && item.name.match(/^state\.json\.tmp\.(\d+)$/);
  if (stateWrite) return !alive(Number(stateWrite[1]));
  if (item.kind !== "raw") return false;
  const owned = item.name.match(/^\.snapshot-(\d+)-[a-f0-9]+\.partial$/);
  if (owned) return !alive(Number(owned[1]));
  // Legacy Git files have no PID. A day exceeds the old 10s export lifetime by
  // several orders of magnitude; fresh legacy locks are counted but preserved.
  return /^snapshot-.+\.snapshot\.bundle\.lock$/i.test(item.name) && now - item.mtimeMs > DAY;
}

function removeUnchanged(item) {
  try {
    const st = fs.lstatSync(item.file);
    if (!st.isFile() || st.size !== item.size || st.mtimeMs !== item.mtimeMs) return false;
    fs.unlinkSync(item.file);
    return true;
  } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

// Shared by uploader and producer. Callers receive every deletion for audit;
// unknown raw files are counted but never selected for deletion.
function maintain(rawDir, cfg = {}, options = {}) {
  fs.mkdirSync(rawDir, {recursive: true, mode: 0o700});
  const now = options.now || Date.now();
  const getFree = options.freeBytes || freeBytes;
  const bound = limits(cfg);
  const before = inventory(rawDir, cfg);
  let total = before.total;
  let free = getFree(rawDir);
  const removed = [];
  const remove = (item, reason) => {
    // A locked/open file on Windows must not prevent cleaning other files.
    try { if (!removeUnchanged(item)) return; }
    catch (_) { return; }
    total -= item.size;
    removed.push({...item, reason});
    free = getFree(rawDir);
  };
  const ordered = before.files.slice().sort((a,b) => a.mtimeMs - b.mtimeMs);
  const oldTemporary = new Set();
  for (const item of ordered) {
    if (temporary(item, now)) {
      oldTemporary.add(item.file);
      remove(item, "orphan_snapshot");
    } else if ((item.kind === "sent" || item.kind === "discarded") && now - item.mtimeMs > DAY) {
      remove(item, "retention_expired");
    } else if (options.evictPending !== false && item.kind === "raw" && isRawFile(item.name) && now - item.mtimeMs > 7 * DAY) {
      remove(item, "pending_retention_expired");
    }
  }
  const removedPaths = new Set(removed.map(item => item.file));
  const low = () => free !== null && free < bound.minFree;
  if (total > bound.soft || low()) {
    for (const item of ordered) {
      if (total <= bound.target && !low()) break;
      if (!removedPaths.has(item.file) && (item.kind === "sent" || item.kind === "discarded")) {
        remove(item, "uploaded_cache_pressure");
        removedPaths.add(item.file);
      }
    }
  }
  // Pressure eviction is best effort, as before, but never delete a current
  // writer's output and stop as soon as both quota and free space recover.
  if (options.evictPending !== false && (total > bound.hard || low())) {
    for (const item of ordered) {
      if (total <= bound.target && !low()) break;
      if (removedPaths.has(item.file) || oldTemporary.has(item.file)) continue;
      if (item.kind !== "raw" || !isRawFile(item.name) || now - item.mtimeMs < 15000) continue;
      const reason = low() ? "low_free_space" : "raw_bodies_hard_limit";
      remove(item, reason);
      removedPaths.add(item.file);
    }
  }
  return {beforeBytes: before.total, total, freeBytes: free, removed, limits: bound};
}

function canReserve(rawDir, cfg, bytes) {
  const usage = inventory(rawDir, cfg);
  const free = freeBytes(rawDir);
  const bound = limits(cfg);
  return usage.total + bytes <= bound.hard && (free === null || free - bytes >= bound.minFree);
}

module.exports = {DEFAULTS, DAY, positive, limits, isRawFile, alive, uploaderDir,
  inventory, freeBytes, acquireWriter, temporary, maintain, canReserve};
