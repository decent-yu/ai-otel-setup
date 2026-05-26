"use strict";

const fs = require("fs");
const path = require("path");

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LOG_FILE = path.join(__dirname, "ai-otel.log");
const STATE_FILE = path.join(__dirname, "ai-otel-log-state.json");

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
  } catch (_) {
    // Logging must never break hooks.
  }
}

function pruneLogIfNeeded(now) {
  const state = readJSONSafe(STATE_FILE);
  const lastPruneAt = Number(state.lastPruneAt || 0);
  if (lastPruneAt && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  writeJSONSafe(STATE_FILE, { ...state, lastPruneAt: now });

  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoff = now - RETENTION_MS;
    const lines = fs.readFileSync(LOG_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const item = JSON.parse(line);
        const ts = Date.parse(item.ts || "");
        return Number.isFinite(ts) && ts >= cutoff;
      } catch (_) {
        return false;
      }
    });
    fs.writeFileSync(LOG_FILE, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  } catch (_) {
    // Best effort only.
  }
}

function cleanValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return String(value).slice(0, 500);
}

function logEvent(event, fields) {
  try {
    const now = Date.now();
    pruneLogIfNeeded(now);
    const record = {
      ts: new Date(now).toISOString(),
      event,
    };
    for (const [k, v] of Object.entries(fields || {})) {
      record[k] = cleanValue(v);
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (_) {
    // Logging must never break hooks.
  }
}

module.exports = { logEvent };
