const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repo = path.resolve(__dirname, "..");
const cli = path.join(repo, "cli.js");

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-opencode-test-"));
}

function runInstaller(home) {
  return execFileSync(process.execPath, [cli, "url=collector.example.test"], {
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

test("installer writes a loadable OpenCode plugin when OpenCode config exists", () => {
  const home = makeHome();
  const opencodeDir = path.join(home, ".config", "opencode");
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(opencodeDir, "opencode.json"),
    JSON.stringify({ "$schema": "https://opencode.ai/config.json" })
  );

  runInstaller(home);

  const pluginPath = path.join(opencodeDir, "plugins", "ai-otel-setup.mjs");
  const endpointPath = path.join(opencodeDir, "ai-otel", "endpoint.json");
  assert.equal(fs.existsSync(pluginPath), true);
  assert.equal(fs.existsSync(endpointPath), true);

  const plugin = fs.readFileSync(pluginPath, "utf8");
  assert.match(plugin, /const TOOL_KIND = "opencode"/);
  assert.match(plugin, /session\.diff/);
  assert.doesNotMatch(plugin, /OTEL_LOG_TOOL_DETAILS/);

  execFileSync(process.execPath, ["--check", pluginPath], { stdio: "ignore" });
});

test("installer skips OpenCode when no OpenCode config directory exists", () => {
  const home = makeHome();

  const output = runInstaller(home);

  assert.match(output, /opencode\s+: skipped/);
  assert.equal(fs.existsSync(path.join(home, ".config", "opencode", "plugins", "ai-otel-setup.mjs")), false);
});
