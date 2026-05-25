#!/usr/bin/env node
/**
 * ai-otel-setup
 *
 * 一行命令配置 Claude Code / Codex CLI / Gemini CLI / OpenCode OTel 上报：
 *   npx -y ai-otel-setup url=COLLECTOR_HOST
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
 *   - settings.json 写之前会备份到 settings.json.bak（每次覆盖，仅保留上一份）
 *   - 多次运行幂等（按 hook id=team:session-start 去重）
 *   - 不依赖任何运行时第三方包，只用 Node 标准库
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { execFileSync } = require("child_process");

const PKG_VERSION = require("./package.json").version;

// 安装时这台机器的 node 绝对路径，POSIX 上拿来构造 hook command 用。
// Windows 上不再写 node 绝对路径（见 buildHookCommand 注释）。
const NODE_BIN = process.execPath;

// 跨平台 hook 命令构造。
//
// **Windows 上的关键决策（v1.0.9 重构）**：不再写 node 绝对路径，也不再加引号，
// 让 shell 自己按空白 split + 用 PATH lookup node。原因：
//   - 写绝对路径如 "C:\Program Files\nodejs\node.exe"，PowerShell 5.1（cc/gemini
//     在 Windows 默认 shell）解析时会把外层引号脱掉，按空白把 "C:\Program" 切成
//     一个 token，"Files\nodejs\..." 切成另一个，hook 进程起不来，exit code 1。
//   - 用 8.3 短路径 (C:\Progra~1\...) 在 NTFS 8dot3name 禁用的卷上失效，
//     更糟的是 cmd /c for 在某些 locale 下输出会带额外引号，被 installer
//     二次拼装成 ""\"C:\\\"C:\\Program Files\\nodejs\\node.exe\\\"\"" 这种
//     非法嵌套，比原 bug 更难修。
//   - 改写 wrapper .cmd / .sh 让用户用别的 shell 接管 → 整体复杂度+30 行，
//     而且 wrapper 路径本身仍可能带空格，治标不治本。
//
// 务实最稳的解：让 shell 自己 PATH 找 node；两个 JS 路径作为 node 参数传入。
// Windows 下统一把反斜杠改成正斜杠：
//   - cmd / PowerShell / Node 都能识别 C:/Users/... 路径
//   - Git Bash / bash 不会再把 C:\Users\... 里的反斜杠当转义字符吃掉
// 参数路径加双引号，兼容用户名含空格的常见场景。
//
// launch-hook.js 内部还会再做一次 PATH 上探 node、失败时 fallback baked
// execPath 的兜底，所以 PATH 上 node 临时失踪也能起来。
//
// POSIX：保持 quoted 三段格式，shell 行为统一，路径有空格也安全。
function windowsNodeArg(p) {
  return `"${String(p).replace(/\\/g, "/")}"`;
}

function buildHookCommand(launcherPath, scriptPath) {
  if (process.platform === "win32") {
    return `node ${windowsNodeArg(launcherPath)} ${windowsNodeArg(scriptPath)}`;
  }
  return `"${NODE_BIN}" "${launcherPath}" "${scriptPath}"`;
}

// 把 launcher 模板拷到 hook 同目录，返回 launcher 的绝对路径
function installLauncher(installDir) {
  const launcherDest = path.join(installDir, "launch-hook.js");
  fs.copyFileSync(path.join(__dirname, "templates", "launch-hook.js"), launcherDest);
  fs.chmodSync(launcherDest, 0o755);
  return launcherDest;
}

const REQUIRED_KEYS = ["url"];
const HOOK_ID = "team:session-start";
// UserPromptSubmit 兜底 hook：复用同一脚本，靠 stdin.hook_event_name 分流；
// 单独 id 是为了让 settings.json 的 SessionStart / UserPromptSubmit 数组各自能按 id 去重
const PROMPT_HOOK_ID = "team:user-prompt-submit";
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

function isIpHost(host) {
  return net.isIP(String(host || "").replace(/^\[|\]$/g, "")) !== 0;
}

function bracketIpv6Host(host) {
  const normalized = String(host || "").replace(/^\[|\]$/g, "");
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function formatRootUrl(protocol, host, port) {
  return `${protocol}//${bracketIpv6Host(host)}${port ? ":" + port : ""}`;
}

function resolveEndpoint(rawUrl) {
  const input = String(rawUrl || "").trim();

  // 用户传完整 URL：保留显式 protocol/port/path；仅在未写 port 时按 IP/域名补默认 gRPC 端口。
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (!url.port) url.port = isIpHost(url.hostname) ? "4317" : "24317";
    if (url.pathname === "/" && !url.search && !url.hash) {
      return formatRootUrl(url.protocol, url.hostname, url.port);
    }
    return url.toString();
  }

  // 用户传裸地址：
  //   - IP：本地/内网测试形态，OTLP/gRPC = http://IP:4317
  //   - 域名：生产公网形态，OTLP/gRPC = https://DOMAIN:24317
  // 判断只看地址形态，不写入任何具体 host。
  const url = new URL(`http://${input}`);
  const isIp = isIpHost(url.hostname);
  const port = url.port || (isIp ? "4317" : "24317");
  return formatRootUrl(isIp ? "http:" : "https:", url.hostname, port);
}

function extractHost(endpoint) {
  // 从已 resolve 的 endpoint 取 host（不带端口），用于 NO_PROXY
  try {
    return new URL(endpoint).hostname;
  } catch (_) {
    return endpoint.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
  }
}

function displayEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (!isIpHost(url.hostname)) {
      // 生产域名的真实 gRPC 端口只写入配置，不在安装完成日志里暴露。
      url.port = "";
      if (url.pathname === "/" && !url.search && !url.hash) return url.origin;
      return url.toString();
    }
  } catch (_) {
    // 展示失败时沿用原值，不影响安装。
  }
  return endpoint;
}

function mergeNoProxy(existing, host) {
  // 合并保留用户已有 NO_PROXY 值，仅追加 collector host，去重保序
  const list = (existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (host && !list.includes(host)) list.push(host);
  return list.join(",");
}

// ---------- git config 兜底 (跨平台) ----------
//
// hook 进程偶有"压根没跑"的场景（网络/超时/进程崩溃），导致 git.user.email/name 永久丢失。
// 装机时把全局 git config 写到 OTEL_RESOURCE_ATTRIBUTES，CC SDK 自动把 resource attr
// 带到每条 metric/log，service 端在 SessionStore miss 时用它兜底（参见 translator.js
// 的 RESOURCE_FALLBACK_KEYS）。
//
// 跨平台细节：
//   - execFileSync(cmd, args)：不经过 shell，Win/Mac 行为一致
//   - windowsHide:true：Windows 上不弹 cmd 黑窗
//   - stdio[2]="ignore"：屏蔽 stderr，避免 git 报错刷屏
//   - timeout:1000：超时直接当成"读不到"，不让 installer 卡住
//   - ENOENT (git 没装) / 退出码非 0 (key 没设) 都吞掉返回空串
function readGlobalGitUser() {
  function readGitVal(key) {
    try {
      return execFileSync("git", ["config", "--global", "--get", key], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (_) {
      return "";
    }
  }
  return {
    name: readGitVal("user.name"),
    email: readGitVal("user.email"),
  };
}

// ---------- 装机上报：走同一条 OTel 管线 ----------
//
// 历史：原 POST 到 cc-view-server :8081/api/installer/report 直写 Doris。
// otel-prod 部署到公网、cc-view-web 留在内网后，installer 只能跟 OTel collector
// 说话；改成发一条 OTLP/HTTP log（event.name = installer_register），由 forwarder
// 走同一条管线落到 iData，cc-view-server 端从事件表 reduce 出装机记录。
// 这样 installer 命令依旧只暴露一个 url，跟数据上报完全同源。
//
// 设计原则：
//   - fire-and-forget：2.5s 超时、不重试、任何失败绝不让安装本身退出非 0
//   - 复用 logsEndpointFromGrpc：4317 → 4318，path 自动补 /v1/logs
//   - debug 模式下才打错误，正常运行不污染 stdout

function postJsonWithTimeout(targetUrl, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? require("https") : require("http");
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: (u.pathname || "/") + (u.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        // 排空 body，让 socket 进入 keepalive/释放
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode || 0));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function reportInstall(otelEndpoint, gitUser, allResults, debug) {
  if (!gitUser || !gitUser.email) {
    if (debug) console.error("[ai-otel-setup] 跳过装机上报：无 git user.email");
    return;
  }
  const logsUrl = logsEndpointFromGrpc(otelEndpoint);
  if (!logsUrl) return;
  const findOk = (tool) =>
    allResults.find((r) => r.tool === tool)?.status === "installed";

  // OTLP/HTTP log record。translator (lib/translate/installer_register.js) 按
  // event.name = "installer_register" 路由到对应 eid，把 git.user.* / hostname
  // 经 contextBlocksFromAttrs 落进 user 块，installer_* / os_* / node_version /
  // *_cli_detected 走 phase1UdmapFields 白名单进 udmap。
  const sessionId = `installer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const attrs = {
    "tool_kind": "installer",
    "event.name": "installer_register",
    "event.timestamp": new Date().toISOString(),
    "session.id": sessionId,
    "git.user.email": gitUser.email,
    "git.user.name": gitUser.name || "",
    "hostname": os.hostname() || "",
    "installer_version": PKG_VERSION,
    "os_platform": os.platform(),
    "os_arch": os.arch(),
    "node_version": process.version,
    "cc_cli_detected": findOk("claude") ? "1" : "0",
    "codex_cli_detected": findOk("codex") ? "1" : "0",
  };
  const payload = {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: `${Date.now()}000000`,
                body: { stringValue: "installer_register" },
                attributes: Object.entries(attrs).map(([k, v]) => ({
                  key: k,
                  value: { stringValue: String(v ?? "") },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    await postJsonWithTimeout(logsUrl, payload, 2500);
    if (debug) console.error("[ai-otel-setup] 装机上报已发送 →", logsUrl);
  } catch (e) {
    if (debug) {
      console.error("[ai-otel-setup] 装机上报失败（不影响安装）:", e.message || e);
    }
  }
}

// ---------- OTEL_RESOURCE_ATTRIBUTES (W3C baggage 风格) ----------

// "k1=urlencoded,k2=urlencoded2" → { k1: "decoded", k2: "decoded2" }
function parseResourceAttrs(s) {
  const out = {};
  if (!s || typeof s !== "string") return out;
  for (const pair of s.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    if (!k) continue;
    const raw = pair.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(raw);
    } catch (_) {
      out[k] = raw; // decode 失败原样保留，不抛
    }
  }
  return out;
}

function serializeResourceAttrs(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === null || v === undefined) continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.join(",");
}

// parse-merge-serialize：保留用户自定义 attr（如 region=us-east），仅注入/覆盖 git.user.*
function mergeResourceAttrs(existing, gitUser) {
  const attrs = parseResourceAttrs(existing || "");
  if (gitUser.email) attrs["git.user.email"] = gitUser.email;
  if (gitUser.name) attrs["git.user.name"] = gitUser.name;
  return serializeResourceAttrs(attrs);
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
  const bak = `${p}.bak`;
  fs.copyFileSync(p, bak);
  return bak;
}

// ---------- 合并逻辑 ----------

function buildEnv(template, args, endpoint) {
  const env = { ...template.env };
  env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  // OTEL_RESOURCE_ATTRIBUTES 由 mergeSettings 单独处理（parse-merge 用户已有 + 注入 git.user.*）
  return env;
}

function mergeSettings(existing, newEnv, hookEntry, promptHookEntry, collectorHost, gitUser) {
  const merged = { ...existing };

  // env：plugin 优先（组织规范不允许个人改红线），但保留用户独有的 env
  merged.env = { ...(existing.env || {}) };
  for (const k of OTEL_KEYS) {
    merged.env[k] = newEnv[k];
  }

  // OTEL_RESOURCE_ATTRIBUTES：parse-merge 用户已有 attr + 注入 git.user.email/name。
  // 不进 OTEL_KEYS（OTEL_KEYS 走 overwrite，会丢掉用户自定义如 region=us-east）。
  // 只在 readGlobalGitUser 拿到非空值时写；全空时保持用户已有值不动（包括不删）。
  if (gitUser && (gitUser.name || gitUser.email)) {
    const ra = mergeResourceAttrs(merged.env.OTEL_RESOURCE_ATTRIBUTES, gitUser);
    if (ra) merged.env.OTEL_RESOURCE_ATTRIBUTES = ra;
  }

  // 兜底用户写坏的 HTTP(S)_PROXY：把 collector host 加进 NO_PROXY，让 OTel gRPC 绕过代理
  // 仅追加，不动用户原有的 NO_PROXY 值，也不动 HTTP_PROXY / HTTPS_PROXY
  if (collectorHost) {
    merged.env.NO_PROXY = mergeNoProxy(merged.env.NO_PROXY, collectorHost);
    merged.env.no_proxy = mergeNoProxy(merged.env.no_proxy, collectorHost);
  }

  merged.hooks = { ...(existing.hooks || {}) };

  // hooks.SessionStart：按 id 去重，存在则覆盖，不存在则追加
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;

  // hooks.UserPromptSubmit：兜底 hook，按 PROMPT_HOOK_ID 去重，规则同上
  if (promptHookEntry) {
    const userPromptSubmit = Array.isArray(merged.hooks.UserPromptSubmit)
      ? [...merged.hooks.UserPromptSubmit]
      : [];
    const pidx = userPromptSubmit.findIndex((h) => h && h.id === PROMPT_HOOK_ID);
    if (pidx >= 0) userPromptSubmit[pidx] = promptHookEntry;
    else userPromptSubmit.push(promptHookEntry);
    merged.hooks.UserPromptSubmit = userPromptSubmit;
  }

  return merged;
}

function logsEndpointFromGrpc(endpoint) {
  try {
    const grpcUrl = new URL(endpoint);
    const isIp = isIpHost(grpcUrl.hostname);
    const logsUrl = new URL(`${isIp ? "http:" : "https:"}//${bracketIpv6Host(grpcUrl.hostname)}`);

    if (isIp) {
      logsUrl.port = !grpcUrl.port || grpcUrl.port === "4317" ? "4318" : grpcUrl.port;
    } else if (grpcUrl.port && grpcUrl.port !== "24317") {
      logsUrl.port = grpcUrl.port;
    }

    logsUrl.pathname =
      !grpcUrl.pathname || grpcUrl.pathname === "/" ? "/v1/logs" : grpcUrl.pathname;
    logsUrl.search = grpcUrl.search;
    return logsUrl.toString();
  } catch (_) {
    return "http://localhost:4318/v1/logs";
  }
}

function buildEndpointConfig(endpoint) {
  return {
    endpoint,
    logsEndpoint: logsEndpointFromGrpc(endpoint),
    installerVersion: PKG_VERSION,
    packageName: "ai-otel-setup",
  };
}

// ---------- Codex config.toml 处理 ----------
//
// 真实 schema（参见 https://developers.openai.com/codex/config-reference 与 /codex/hooks）：
//
//   [features]
//   codex_hooks = true                          ← 没这个 flag，整段 hooks 被忽略
//
//   [otel]
//   exporter = "otlp-grpc"                      ← 用 exporter 选 transport，不是 enabled / protocol
//   metrics_exporter = "otlp-grpc"
//   trace_exporter = "otlp-grpc"
//
//   [otel.exporter.otlp-grpc]                   ← 端点写在嵌套子表里
//   endpoint = "http://host:4317"
//
//   [[hooks.SessionStart]]                      ← codex 真的有 SessionStart
//   matcher = "startup|resume"
//   [[hooks.SessionStart.hooks]]                ← 真正的 command 嵌一层
//   type = "command"
//   command = "..."
//
// 嵌套子表 + 嵌套数组用 hand-rolled 正则维护太脆，改成"managed 块"风格：
// 用 BEGIN/END 标记夹住整段我们写的内容，重跑 installer 时整块剥离再追加。

const CODEX_MANAGED_BEGIN = "# >>> ai-otel-setup managed >>>";
const CODEX_MANAGED_END = "# <<< ai-otel-setup managed <<<";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCodexManagedBlock(text) {
  const re = new RegExp(
    `\\n?${escapeRegex(CODEX_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(CODEX_MANAGED_END)}\\n?`,
    "g"
  );
  return text.replace(re, "\n");
}

function stripLegacyCodexOtel(text) {
  // 旧 installer 写的 [otel]（含非法 key enabled = true）整段删除，避免与新 [otel] 冲突
  return text.replace(
    /(?:\n|^)\[otel\][\s\S]*?(?=\n\[|\n\[\[|$)/g,
    (m) => (/enabled\s*=\s*true/.test(m) ? "" : m)
  );
}

function stripLegacyCodexHook(text) {
  // 旧 installer 写的 [[hooks.UserPromptSubmit]] + id = "team:session-start" 整块删除
  return text.replace(
    /(?:\n|^)\[\[hooks\.UserPromptSubmit\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g,
    (m) => (/id\s*=\s*["']team:session-start["']/.test(m) ? "" : m)
  );
}

function stripLegacyCodexHooksFlag(text) {
  // Codex 把 [features].codex_hooks 重命名为 [features].hooks，旧 key 启动时触发 deprecation 警告
  // 删 = true 这行，由 ensureFeaturesHooksTrue 统一写 hooks = true；= false 是显式 opt-out，保留
  return text.replace(/^[ \t]*codex_hooks[ \t]*=[ \t]*true[ \t]*\r?\n/gm, "");
}

function ensureFeaturesHooksTrue(text) {
  // 在用户已有的 [features] 块原地插入 hooks = true（如缺失）；没有 [features] 就新建。
  // 不能写在 managed 块里——TOML 1.0 禁止同名 table 重复声明，会被严格解析器拒绝。
  const lines = text.split(/\r?\n/);
  let featuresIdx = -1;
  let hooksKeyExists = false;
  for (let i = 0; i < lines.length; i++) {
    if (featuresIdx === -1) {
      if (/^\s*\[features\]\s*$/.test(lines[i])) featuresIdx = i;
      continue;
    }
    if (/^\s*\[/.test(lines[i])) break; // 下一个 section，结束 [features] 主块扫描
    if (/^[ \t]*hooks[ \t]*=/.test(lines[i])) hooksKeyExists = true;
  }
  if (featuresIdx >= 0) {
    if (hooksKeyExists) return text; // 任何 hooks = ... 都尊重，不覆盖用户显式选择
    lines.splice(featuresIdx + 1, 0, "hooks = true");
    return lines.join("\n");
  }
  return text.trimEnd() + "\n\n[features]\nhooks = true\n";
}

function buildCodexManagedBlock(endpoint, hookDest, launcherDest) {
  // exporter / trace_exporter / metrics_exporter 是 externally-tagged enum：
  //   - 写 scalar `exporter = "otlp-grpc"`：codex 解析为 unit variant，因为
  //     OtlpGrpc 是 struct variant（带 endpoint 等字段），报
  //     "invalid type: unit variant, expected struct variant"。
  //   - 同时写 scalar 和 table：报 "cannot extend value of type string"。
  //   - 只写 table `[otel.exporter."otlp-grpc"]`：✓ codex 把它解析为
  //     OtlpGrpc { endpoint }，tag 来自 key 名。
  // 官方 sample 之所以能 `exporter = "none"`，是因为 None 本身就是 unit variant。
  // [features].hooks = true 由 ensureFeaturesHooksTrue 写到用户块里，避免重复声明 [features]
  return [
    CODEX_MANAGED_BEGIN,
    "[otel]",
    'environment = "prod"',
    "log_user_prompt = false",
    "",
    '[otel.exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    '[otel.trace_exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    '[otel.metrics_exporter."otlp-grpc"]',
    `endpoint = ${JSON.stringify(endpoint)}`,
    "",
    "[[hooks.SessionStart]]",
    'matcher = "startup|resume"',
    "",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(buildHookCommand(launcherDest, hookDest))}`,
    CODEX_MANAGED_END,
  ].join("\n");
}

function installCodex(home, endpoint) {
  const codexDir = path.join(home, ".codex");
  if (!fs.existsSync(codexDir)) {
    return { tool: "codex", status: "skipped", reason: "未检测到 ~/.codex" };
  }
  const installDir = path.join(codexDir, "ai-otel");
  const configPath = path.join(codexDir, "config.toml");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "codex", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const launcherDest = installLauncher(installDir);
  const bak = backup(configPath);
  let existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  // 先剥离上一次的 managed 块和旧 schema 残留，再保证用户块里有 hooks = true
  existing = stripCodexManagedBlock(existing);
  existing = stripLegacyCodexOtel(existing);
  existing = stripLegacyCodexHook(existing);
  existing = stripLegacyCodexHooksFlag(existing);
  existing = ensureFeaturesHooksTrue(existing);

  // hook 同目录的 endpoint.json：hook 脚本运行时读它拿 logs endpoint，避免依赖
  // shell 前缀注入 env（cmd.exe 不认那种语法，跨平台必须改成走文件）。
  writeJSONAtomic(path.join(installDir, "endpoint.json"), buildEndpointConfig(endpoint));
  const managed = buildCodexManagedBlock(endpoint, hookDest, launcherDest);
  const merged = (existing.trimEnd() + "\n\n" + managed + "\n").replace(/\n{3,}/g, "\n\n");
  fs.writeFileSync(configPath, merged, "utf8");
  return { tool: "codex", status: "installed", path: configPath, backup: bak };
}

function installGemini(home, endpoint) {
  const geminiDir = path.join(home, ".gemini");
  if (!fs.existsSync(geminiDir)) {
    return { tool: "gemini", status: "skipped", reason: "未检测到 ~/.gemini" };
  }
  const installDir = path.join(geminiDir, "ai-otel");
  const settingsPath = path.join(geminiDir, "settings.json");
  const hookDest = path.join(installDir, "on-session-start.js");
  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "gemini", "on-session-start.js"), hookDest);
  fs.chmodSync(hookDest, 0o755);
  const launcherDest = installLauncher(installDir);
  // 同 Codex：endpoint.json 给 hook 脚本读，跨平台不依赖 env 前缀。
  writeJSONAtomic(path.join(installDir, "endpoint.json"), buildEndpointConfig(endpoint));
  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = { ...existing };
  // ⚠️ Gemini telemetry.target 只支持 "local" 与 "gcp"，没有 "otlp" 枚举值。
  //    指向自建 OTLP 接收端的标准用法是 target=local + otlpEndpoint=<url>。
  //    见调研：docs/superpowers/specs/2026-04-29-multi-cli-otel-research.md §2.2
  merged.telemetry = {
    ...(existing.telemetry || {}),
    enabled: true,
    target: "local",
    otlpEndpoint: endpoint,
    otlpProtocol: "grpc",
    useCollector: true,
    logPrompts: false,
  };
  merged.hooks = { ...(existing.hooks || {}) };
  const sessionStart = Array.isArray(merged.hooks.SessionStart)
    ? [...merged.hooks.SessionStart]
    : [];
  const hookEntry = {
    id: HOOK_ID,
    command: buildHookCommand(launcherDest, hookDest),
  };
  const idx = sessionStart.findIndex((h) => h && h.id === HOOK_ID);
  if (idx >= 0) sessionStart[idx] = hookEntry;
  else sessionStart.push(hookEntry);
  merged.hooks.SessionStart = sessionStart;
  writeJSONAtomic(settingsPath, merged);
  return { tool: "gemini", status: "installed", path: settingsPath, backup: bak };
}

function installOpenCode(home, endpoint) {
  const opencodeDir = process.env.OPENCODE_CONFIG_DIR || path.join(home, ".config", "opencode");
  if (!fs.existsSync(opencodeDir)) {
    return { tool: "opencode", status: "skipped", reason: "未检测到 ~/.config/opencode" };
  }
  const installDir = path.join(opencodeDir, "ai-otel");
  const pluginDir = path.join(opencodeDir, "plugins");
  const pluginDest = path.join(pluginDir, "ai-otel-setup.mjs");
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "templates", "opencode", "plugin.mjs"), pluginDest);
  writeJSONAtomic(path.join(installDir, "endpoint.json"), buildEndpointConfig(endpoint));
  return { tool: "opencode", status: "installed", path: pluginDest };
}

// ---------- 主流程 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || process.argv.includes("--help")) {
    printUsage();
    return;
  }

  const errs = validateArgs(args);
  if (errs.length) {
    console.error("[ai-otel-setup] 参数错误：");
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
  const launcherDest = path.join(installDir, "launch-hook.js");

  const templateDir = path.join(__dirname, "templates");
  const settingsTemplate = readJSONSafe(path.join(templateDir, "settings.template.json"));
  const hookScriptSrc = path.join(templateDir, "on-session-start.js");

  if (!fs.existsSync(hookScriptSrc)) {
    console.error(`[ai-otel-setup] 找不到 hook 模板：${hookScriptSrc}`);
    process.exit(1);
  }

  const endpoint = resolveEndpoint(args.url);
  const newEnv = buildEnv(settingsTemplate, args, endpoint);

  const hookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(launcherDest, hookScriptDest),
        timeout: 3,
      },
    ],
    description:
      "ai-otel-setup 注入：补采项目/git/hostname 维度，POST 到 OTLP/HTTP 4318",
    id: HOOK_ID,
  };

  // UserPromptSubmit 兜底 hook：复用同一脚本，由 stdin.hook_event_name 在脚本内部
  // 分流。客户端做 2 分钟节流，服务端见 entry 已存在则仅补空。用于救 SessionStart
  // 因网络/超时丢失的场景（线上观测约 60% 事件因此空 git/hostname）。
  const promptHookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: buildHookCommand(launcherDest, hookScriptDest),
        timeout: 3,
      },
    ],
    description:
      "ai-otel-setup 注入：UserPromptSubmit 兜底，救 SessionStart 漏发场景",
    id: PROMPT_HOOK_ID,
  };

  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(hookScriptSrc, hookScriptDest);
  fs.chmodSync(hookScriptDest, 0o755);
  installLauncher(installDir);

  // v1.0.3：把 endpoint 写盘，给 hook 脚本的 resolveLogsEndpoint 当兜底。
  // 修的是 v1.0.2 的真实事故：settings.json 的 env 不一定能继承到 hook 子进程
  // （Windows / 已运行的 CC 实例都会踩到），导致 hook fallback 到 localhost
  // 拿 ECONNREFUSED 静默失败、marker 已写但 POST 永不到达。
  writeJSONAtomic(path.join(installDir, "endpoint.json"), buildEndpointConfig(endpoint));

  // 读全局 git config，作为 hook 进程没跑时的 SDK 层兜底来源
  // 失败/缺失返回空串；mergeSettings 见空就跳过 OTEL_RESOURCE_ATTRIBUTES 写入
  const gitUser = readGlobalGitUser();

  const existing = readJSONSafe(settingsPath);
  const bak = backup(settingsPath);
  const merged = mergeSettings(
    existing,
    newEnv,
    hookEntry,
    promptHookEntry,
    extractHost(endpoint),
    gitUser
  );
  writeJSONAtomic(settingsPath, merged);

  const results = [];
  try {
    results.push(installCodex(home, endpoint));
  } catch (e) {
    results.push({ tool: "codex", status: "failed", reason: e.message });
  }
  try {
    results.push(installGemini(home, endpoint));
  } catch (e) {
    results.push({ tool: "gemini", status: "failed", reason: e.message });
  }
  try {
    results.push(installOpenCode(home, endpoint));
  } catch (e) {
    results.push({ tool: "opencode", status: "failed", reason: e.message });
  }

  const debug = !!args.debug || process.argv.includes("--debug") || process.argv.includes("-d");
  const allResults = [{ tool: "claude", status: "installed" }, ...results];

  console.log("[ai-otel-setup] 安装完成。");
  console.log("");
  console.log(`  ${"version".padEnd(12)}: ${PKG_VERSION}`);
  console.log(`  ${"endpoint".padEnd(12)}: ${displayEndpoint(endpoint)}`);
  for (const r of allResults) {
    console.log(`  ${r.tool.padEnd(12)}: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}`);
  }
  if (debug) {
    console.log(`  ${"hook script".padEnd(12)}: ${hookScriptDest}`);
    console.log(`  ${"settings".padEnd(12)}: ${settingsPath}`);
    if (bak) console.log(`  ${"backup".padEnd(12)}: ${bak}`);
  }
  console.log("");
  console.log("接下来：直接运行 `claude` / `codex` / `gemini` / `opencode`，下次会话启动即自动上报。");
  if (debug) {
    console.log(
      "卸载：删除 " +
        installDir +
        " 与 " +
        path.join(claudeDir, "cc-otel-state") +
        "（marker 目录），并从 settings.json 移除 12 个 OTEL_* env、" +
        "SessionStart 中 id=" + HOOK_ID + " 与 UserPromptSubmit 中 id=" + PROMPT_HOOK_ID + " 的条目。"
    );
  }

  // 装机上报：fire-and-forget 语义，3s 内完成或放弃；任何错误都不冒泡
  await reportInstall(endpoint, gitUser, allResults, debug);
}

function printUsage() {
  console.log(`Usage:
  npx -y ai-otel-setup url=COLLECTOR_HOST

参数（必填）：
  url    Collector host（裸 IP 自动补 http://...:4317；裸域名自动补 https://...:24317；也可传完整 URL）

可选：
  debug=1 | --debug   显示安装路径、备份路径与卸载提示
`);
}

main().catch((e) => {
  console.error("[ai-otel-setup] 失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
