const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..");
const cli = path.join(repo, "cli.js");
const launcherTemplate = path.join(repo, "templates", "launch-hook.js");
const claudeHook = path.join(repo, "templates", "on-session-start.js");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-test-"));
}

function runInstaller(home, args = ["url=collector.example.test"]) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AI_OTEL_SKIP_INSTALL_REPORT: "1",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("installer uses privacy-safe Claude defaults and timestamped backups", () => {
  const home = makeHome();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ env: { KEEP_ME: "1" } }));

  runInstaller(home);

  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
  assert.equal(settings.env.KEEP_ME, "1");
  assert.equal(settings.env.OTEL_LOG_TOOL_DETAILS, "0");

  const backups = fs.readdirSync(claudeDir).filter((name) => name.startsWith("settings.json.bak."));
  assert.equal(backups.length, 1);
  assert.equal(fs.existsSync(path.join(claudeDir, "settings.json.bak")), false);
});

test("Codex install does not duplicate an existing top-level otel table", () => {
  const home = makeHome();
  const codexDir = path.join(home, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    [
      "[features]",
      "",
      "[otel]",
      'environment = "dev"',
      "",
      '[projects."/tmp/demo"]',
      'trust_level = "trusted"',
      "",
    ].join("\n")
  );

  runInstaller(home);

  const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
  const topLevelOtelCount = (config.match(/^\[otel\]$/gm) || []).length;
  assert.equal(topLevelOtelCount, 1);
  assert.match(config, /^\[\[hooks\.SessionStart\]\]$/m);
  assert.match(config, /^\[otel\.exporter\."otlp-grpc"\]$/m);
});

test("launcher does not auto-update unless explicitly enabled", () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-launcher-"));
  fs.copyFileSync(launcherTemplate, path.join(installDir, "launch-hook.js"));
  fs.writeFileSync(
    path.join(installDir, "endpoint.json"),
    JSON.stringify({ endpoint: "https://collector.example.test:24317", installerVersion: "0.0.0" })
  );
  const hookPath = path.join(installDir, "hook.js");
  fs.writeFileSync(hookPath, "process.exit(0);\n");

  execFileSync(process.execPath, [path.join(installDir, "launch-hook.js"), hookPath], {
    env: { ...process.env, AI_OTEL_ENABLE_AUTO_UPDATE: "" },
    stdio: "ignore",
  });

  assert.equal(fs.existsSync(path.join(installDir, "auto-update-state.json")), false);
});

test("Claude hook stores prompt markers using a sanitized session id", () => {
  const home = makeHome();
  const endpointDir = path.join(home, ".claude", "cc-otel");
  fs.mkdirSync(endpointDir, { recursive: true });
  fs.writeFileSync(
    path.join(endpointDir, "endpoint.json"),
    JSON.stringify({ logsEndpoint: "http://127.0.0.1:9/v1/logs" })
  );

  execFileSync(process.execPath, [claudeHook], {
    input: JSON.stringify({
      session_id: "../../outside",
      hook_event_name: "UserPromptSubmit",
      cwd: repo,
    }),
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });

  assert.equal(fs.existsSync(path.join(home, ".claude", "outside.flag")), false);
  const stateDir = path.join(home, ".claude", "cc-otel-state");
  const markers = fs.readdirSync(stateDir).filter((name) => name.startsWith("sent-"));
  assert.equal(markers.length, 1);
  assert.doesNotMatch(markers[0], /\.\.|\//);
});
