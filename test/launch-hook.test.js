const test = require("node:test");
const assert = require("node:assert/strict");

const launcher = require("../templates/launch-hook.js").__test__;

function cfg(extra) {
  return { endpoint: "http://collector.example.com:4317", otelTransport: "http", ...extra };
}

// auto-update 会重建装机参数再跑一遍 installer。任何漏续传的装机选项都会被下一次
// 安装按默认值覆写 —— 倍率漏传就意味着灰度机器升级后静默变回真实量级。
test("buildInstallArgs: 倍率跨升级存活（回归 CRH-227 审查第 2 条）", () => {
  const args = launcher.buildInstallArgs(cfg({ usageMultiplier: 5 }), "1.2.0", "linux");
  assert.equal(args.includes("usage-multiplier=5"), true, "升级后必须续传倍率，否则 endpoint.json 会被覆写成 1");
});

test("buildInstallArgs: 倍率为默认 1 或缺省时不传该参数", () => {
  for (const c of [cfg(), cfg({ usageMultiplier: 1 })]) {
    const args = launcher.buildInstallArgs(c, "1.2.0", "linux");
    assert.equal(args.some((a) => a.startsWith("usage-multiplier=")), false, JSON.stringify(c));
  }
});

test("buildInstallArgs: 小于 1 的缩小倍率同样续传", () => {
  const args = launcher.buildInstallArgs(cfg({ usageMultiplier: 0.5 }), "1.2.0", "linux");
  assert.equal(args.includes("usage-multiplier=0.5"), true);
});

test("buildInstallArgs: 非法倍率不续传（让 installer 走自己的回落逻辑）", () => {
  for (const bad of ["abc", 0, -3, NaN, Infinity, null, undefined, ""]) {
    const args = launcher.buildInstallArgs(cfg({ usageMultiplier: bad }), "1.2.0", "linux");
    assert.equal(
      args.some((a) => a.startsWith("usage-multiplier=")),
      false,
      `usageMultiplier=${JSON.stringify(bad)} 不应被续传`
    );
  }
});

test("buildInstallArgs: 续传倍率不影响既有的 transport / fullUpload 续传", () => {
  const args = launcher.buildInstallArgs(
    cfg({ otelTransport: "grpc", fullUploadOptOut: true, usageMultiplier: 3 }),
    "1.2.0",
    "win32"
  );
  assert.deepEqual(args, [
    "-y",
    "ai-otel-setup@1.2.0",
    "url=http://collector.example.com:4317",
    "--grpc",
    "--no-full-upload",
    "usage-multiplier=3",
  ]);
});

test("buildInstallArgs: grpc 仅在 win32 续传（既有行为不回归）", () => {
  const linux = launcher.buildInstallArgs(cfg({ otelTransport: "grpc" }), "1.2.0", "linux");
  assert.equal(linux.includes("--grpc"), false);
  const win = launcher.buildInstallArgs(cfg({ otelTransport: "grpc" }), "1.2.0", "win32");
  assert.equal(win.includes("--grpc"), true);
});
