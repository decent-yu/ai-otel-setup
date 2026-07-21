const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const scanner = require("../templates/local-usage-scanner.js").__test__;

function usage({ input, cached, output }) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    total_tokens: input + output,
  };
}

function tokenLine(ts, last, total) {
  return JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
      },
    },
  });
}

function mkdirTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-local-usage-"));
}

test("computeCodexTokenDelta: total 快照差分，重复/流式刷新不重复累计 calls", () => {
  const state = {};

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
      total_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
    }, state, { file: "a" }),
    { input: 200, cache_r: 800, output: 10, countMessage: true },
  );

  assert.equal(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
      total_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
    }, state, { file: "a" }),
    null,
  );

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 1000, cached: 800, output: 20 }),
      total_token_usage: usage({ input: 1000, cached: 800, output: 20 }),
    }, state, { file: "a" }),
    { input: 0, cache_r: 0, output: 10, countMessage: false },
  );

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 800, cached: 600, output: 10 }),
      total_token_usage: usage({ input: 1800, cached: 1400, output: 30 }),
    }, state, { file: "a" }),
    { input: 200, cache_r: 600, output: 10, countMessage: true },
  );
});

test("computeCodexTokenDelta: 同文件 total reset 按 last_token_usage 作为新段", () => {
  const state = {};
  scanner.computeCodexTokenDelta({
    last_token_usage: usage({ input: 3000, cached: 2000, output: 100 }),
    total_token_usage: usage({ input: 3000, cached: 2000, output: 100 }),
  }, state, { file: "a" });

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 900, cached: 700, output: 20 }),
      total_token_usage: usage({ input: 900, cached: 700, output: 20 }),
    }, state, { file: "a" }),
    { input: 200, cache_r: 700, output: 20, countMessage: true },
  );
});

test("aggregateCodex: 重复 archived/session 快照不会生成 unknown model 重复 bucket", async () => {
  const root = mkdirTemp();
  const sessions = path.join(root, "sessions", "2026", "07", "19");
  const archived = path.join(root, "archived_sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });

  const sid = "019f5920-588e-7971-87b4-8053e2e94353";
  const mainFile = path.join(sessions, `rollout-2026-07-19T13-08-28-${sid}.jsonl`);
  const duplicateFile = path.join(archived, `rollout-2026-07-19T21-21-15-${sid}.jsonl`);

  fs.writeFileSync(mainFile, [
    JSON.stringify({ timestamp: "2026-07-19T05:08:28.000Z", type: "session_meta", payload: { id: sid, cwd: "/tmp/astronos" } }),
    JSON.stringify({ timestamp: "2026-07-19T05:08:29.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tokenLine("2026-07-19T05:08:30.000Z", usage({ input: 1000, cached: 800, output: 10 }), usage({ input: 1000, cached: 800, output: 10 })),
    tokenLine("2026-07-19T05:08:31.000Z", usage({ input: 1000, cached: 800, output: 10 }), usage({ input: 1000, cached: 800, output: 10 })),
    tokenLine("2026-07-19T05:08:32.000Z", usage({ input: 1000, cached: 800, output: 15 }), usage({ input: 1000, cached: 800, output: 15 })),
    tokenLine("2026-07-19T05:09:00.000Z", usage({ input: 300, cached: 200, output: 5 }), usage({ input: 1300, cached: 1000, output: 20 })),
  ].join("\n") + "\n", "utf8");

  fs.writeFileSync(duplicateFile, [
    tokenLine("2026-07-19T13:21:15.000Z", usage({ input: 1200, cached: 900, output: 18 }), usage({ input: 1200, cached: 900, output: 18 })),
  ].join("\n") + "\n", "utf8");

  const rows = await scanner.aggregateCodex(["2026-07-19"], [path.join(root, "sessions"), archived]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gpt-5.6-sol");
  assert.equal(rows[0].messages, 2);
  assert.equal(rows[0].input, 300);
  assert.equal(rows[0].cache_r, 1000);
  assert.equal(rows[0].output, 20);
});
