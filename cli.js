#!/usr/bin/env node
/**
 * cc-otel-installer
 *
 * 一行命令配置 Claude Code OTel 上报：
 *   npx -y cc-otel-installer url=COLLECTOR_HOST
 *
 * 兼容写法：参数也可以全部塞在一个 argv 里，用逗号分隔：
 *   npx -y cc-otel-installer url=COLLECTOR_HOST
 *
 * 该 installer **不走 CC plugin 机制**：直接把 hook 脚本铺到
 * ~/.claude/cc-otel/，并把 12 个 OTel env + SessionStart hook 注入
 * 用户的 ~/.claude/settings.json。安装后 `claude` 立即生效，无需 /plugin install。
 *
 * 关键约束：
 *   - 失败时尽量给出可操作信息，不静默
 *   - settings.json 写之前会备份到 settings.json.bak.<ts>
 *   - 多次运行幂等（按 hook id=team:session-start 去重）
 *   - 不依赖任何运行时第三方包，只用 Node 标准库
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const REQUIRED_KEYS = ["url"];
const HOOK_ID = "team:session-start";
const OTEL_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRICS_INCLUDE_VERSION",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
];

// ---------- argv 解析 ----------

function parseArgs(argv) {
  const out = {};
  const flat = [];
  for (const a of argv) {
    // 兼容 url=x 单 argv 与 url=x 多 argv（保留逗号分隔，便于未来扩展）
    for (const part of a.split(",")) {
      if (part.trim()) flat.push(part.trim());
    }
  }
  for (const part of flat) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function validateArgs(args) {
  const errs = [];
  for (const k of REQUIRED_KEYS) {
    if (!args[k]) {
      errs.push(`missing required: ${k}`);
      continue;
    }
    if (/\s/.test(args[k])) errs.push(`${k} 不允许包含空格: "${args[k]}"`);
    if (args[k].includes(",")) errs.push(`${k} 不允许包含逗号: "${args[k]}"`);
  }
  return errs;
}

// ---------- url → endpoint ----------

function resolveEndpoint(rawUrl) {
  // 用户传裸 IP 或 host：自动补 http:// 和 :4317（gRPC 默认端口）
  // 用户传完整 URL：直接采用
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  // 如果用户已带端口（如 "1.2.3.4:4317"），保留；否则补默认 4317
  const hasPort = /:\d+$/.test(rawUrl);
  return `http://${rawUrl}${hasPort ? "" : ":4317"}`;
}

// ---------- 文件操作 ----------

function readJSONSafe(p) {
  try {
    if (!fs.existsSync(p)) return {};
    const txt = fs.readFileSync(p, "utf8");
    if (!txt.trim()) return {};
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`读取 ${p} 失败：${e.message}`);
  }
}

function writeJSONAtomic(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, p);
}

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${p}.bak.${ts}`;
  fs.copyFileSync(p, bak);
  return bak;
}

// ---------- 合并逻辑 ----------

function buildEnv(template, args, endpoint) {
  const env = { ...template.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  // OTEL_RESOURCE_ATTRIBUTES 已废弃：bg/dept/team 不再上报
  delete env.OTEL_RESOURCE_ATTRIBUTES;
  return env;
}

function mergeSettings(existing, newEnv, hookEntry) {
  const merged = { ...existing };

  // env：plugin 优先（组织规范不允许个人改红线），但保留用户独有的 env
  merged.env = { ...(existing.env || {}) };
  for (const k of OTEL_KEYS) {
    merged.env[k] = newEnv[k];
  }
  // 清理历史遗留：旧版本 installer 写过 OTEL_RESOURCE_ATTRIBUTES，删掉
  delete merged.env.OTEL_RESOURCE_ATTRIBUTES;

  // hooks.SessionStart：按 id 去重，存在则覆盖，不存在则追加
  merged.hooks = { ...(existing.hooks || {}) };
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;

  return merged;
}

// ---------- 主流程 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const errs = validateArgs(args);
  if (errs.length) {
    console.error("[cc-otel-installer] 参数错误：");
    for (const e of errs) console.error("  - " + e);
    console.error("");
    printUsage();
    process.exit(2);
  }

  const home = os.homedir();
  const claudeDir = path.join(home, ".claude");
  const installDir = path.join(claudeDir, "cc-otel");
  const settingsPath = path.join(claudeDir, "settings.json");
  const hookScriptDest = path.join(installDir, "on-session-start.js");

  const templateDir = path.join(__dirname, "templates");
  const settingsTemplate = readJSONSafe(path.join(templateDir, "settings.template.json"));
  const hookScriptSrc = path.join(templateDir, "on-session-start.js");

  if (!fs.existsSync(hookScriptSrc)) {
    console.error(`[cc-otel-installer] 找不到 hook 模板：${hookScriptSrc}`);
    process.exit(1);
  }

  const endpoint = resolveEndpoint(args.url);
  const newEnv = buildEnv(settingsTemplate, args, endpoint);

  const hookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptDest}"`,
        timeout: 3,
      },
    ],
    description:
      "cc-otel-installer 注入：补采项目/git/hostname 维度，POST 到 OTLP/HTTP 4318",
    id: HOOK_ID,
  };

  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(hookScriptSrc, hookScriptDest);
  fs.chmodSync(hookScriptDest, 0o755);

  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = mergeSettings(existing, newEnv, hookEntry);
  writeJSONAtomic(settingsPath, merged);

  console.log("[cc-otel-installer] 安装完成。");
  console.log("");
  console.log("  endpoint     : " + endpoint);
  console.log("  hook script  : " + hookScriptDest);
  console.log("  settings     : " + settingsPath);
  if (bak) console.log("  backup       : " + bak);
  console.log("");
  console.log("接下来：直接运行 `claude`，下次会话启动即自动上报。");
  console.log("卸载：删除 " + installDir + " 并从 settings.json 移除 12 个 OTEL_* env 与 SessionStart 中 id=" + HOOK_ID + " 的条目。");
}

function printUsage() {
  console.log(`Usage:
  npx -y cc-otel-installer url=COLLECTOR_HOST

参数（必填）：
  url    Collector host（裸 IP/域名，自动补 http://...:4317；也可传完整 URL）
`);
}

try {
  main();
} catch (e) {
  console.error("[cc-otel-installer] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
}
