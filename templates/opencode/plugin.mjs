import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const TOOL_KIND = "opencode";

function configDir() {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
}

function readJSONSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return {};
  }
}

function resolveLogsEndpoint() {
  if (process.env.AI_OTEL_OPENCODE_LOGS_ENDPOINT) return process.env.AI_OTEL_OPENCODE_LOGS_ENDPOINT;
  if (process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) return process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;

  let base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) {
    const cfg = readJSONSafe(path.join(configDir(), "ai-otel", "endpoint.json"));
    if (cfg.logsEndpoint) return cfg.logsEndpoint;
    if (cfg.endpoint) base = cfg.endpoint;
  }

  if (!base) base = "http://localhost:4317";
  const url = new URL(base);
  if (url.port === "4317") url.port = "4318";
  if (!url.pathname || url.pathname === "/") url.pathname = "/v1/logs";
  return url.toString();
}

function safeGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).toString().trim();
  } catch (_) {
    return "";
  }
}

function attr(key, value) {
  return { key, value: { stringValue: String(value ?? "") } };
}

function payload(attrs, body) {
  return JSON.stringify({
    resourceLogs: [{
      resource: { attributes: [] },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: `${Date.now()}000000`,
          body: { stringValue: body },
          attributes: Object.entries(attrs).map(([key, value]) => attr(key, value)),
        }],
      }],
    }],
  });
}

function postLog(attrs, body) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(resolveLogsEndpoint());
    } catch (_) {
      return resolve();
    }

    const data = payload(attrs, body);
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 2000,
    }, (res) => {
      res.resume();
      res.on("end", resolve);
      res.on("error", resolve);
    });
    req.on("error", resolve);
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.end(data);
  });
}

function baseAttrs(ctx, sessionID, cwd) {
  const root = cwd || ctx.directory || process.cwd();
  return {
    tool_kind: TOOL_KIND,
    "session.id": sessionID || "",
    cwd: root,
    "project.name": path.basename(root),
    "git.remote": safeGit(root, ["config", "--get", "remote.origin.url"]),
    "git.user.email": safeGit(root, ["config", "user.email"]),
    "git.user.name": safeGit(root, ["config", "user.name"]),
    hostname: os.hostname() || "",
    data_source: "plugin",
  };
}

function sessionInfo(event) {
  return event?.properties?.info || {};
}

function diffTotals(diff) {
  return (diff || []).reduce((acc, file) => {
    acc.additions += Number(file.additions || 0);
    acc.deletions += Number(file.deletions || 0);
    acc.files += 1;
    return acc;
  }, { additions: 0, deletions: 0, files: 0 });
}

export default async function aiOtelOpenCodePlugin(ctx) {
  const seenSessions = new Set();
  return {
    async event({ event }) {
      try {
        if (event.type === "session.created" || event.type === "session.updated") {
          const info = sessionInfo(event);
          if (!info.id || seenSessions.has(info.id)) return;
          seenSessions.add(info.id);
          await postLog({
            ...baseAttrs(ctx, info.id, info.directory),
            "event.name": "hook_session_start",
            "event.timestamp": new Date().toISOString(),
            "opencode.session.version": info.version || "",
          }, "hook_session_start");
          return;
        }

        if (event.type === "session.diff") {
          const totals = diffTotals(event.properties?.diff);
          await postLog({
            ...baseAttrs(ctx, event.properties?.sessionID, ctx.directory),
            "event.name": "session_diff",
            "event.timestamp": new Date().toISOString(),
            "code.added_lines": totals.additions,
            "code.deleted_lines": totals.deletions,
            "code.changed_lines": totals.additions + totals.deletions,
            "code.changed_files": totals.files,
          }, "session_diff");
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          if (!info || info.role !== "assistant" || !info.time?.completed) return;
          await postLog({
            ...baseAttrs(ctx, info.sessionID, info.path?.cwd || ctx.directory),
            "event.name": "usage",
            "event.timestamp": new Date().toISOString(),
            "model.provider": info.providerID || "",
            "model.name": info.modelID || "",
            "cost.usd": info.cost || 0,
            "tokens.input": info.tokens?.input || 0,
            "tokens.output": info.tokens?.output || 0,
            "tokens.reasoning": info.tokens?.reasoning || 0,
            "tokens.cache.read": info.tokens?.cache?.read || 0,
            "tokens.cache.write": info.tokens?.cache?.write || 0,
          }, "usage");
        }
      } catch (_) {
        // Telemetry must never affect OpenCode runtime behavior.
      }
    },

    async "tool.execute.after"(input, output) {
      try {
        await postLog({
          ...baseAttrs(ctx, input.sessionID, ctx.directory),
          "event.name": "tool_result",
          "event.timestamp": new Date().toISOString(),
          "tool.name": input.tool || "",
          "tool.call_id": input.callID || "",
          "tool.title": output.title || "",
          "tool.status": output?.metadata?.error ? "error" : "ok",
        }, "tool_result");
      } catch (_) {
        // Do not capture tool args or output content, and never block tools.
      }
    },

    async "shell.env"(_input, output) {
      output.env.AI_OTEL_TOOL_KIND = TOOL_KIND;
      const cfg = readJSONSafe(path.join(configDir(), "ai-otel", "endpoint.json"));
      if (cfg.endpoint && !output.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        output.env.OTEL_EXPORTER_OTLP_ENDPOINT = cfg.endpoint;
      }
    },
  };
}
