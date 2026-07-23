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

test("computeCodexTokenDelta: 没有 last_token_usage 时只记录 total 基线不上报", () => {
  const state = {};

  assert.equal(
    scanner.computeCodexTokenDelta({
      total_token_usage: usage({ input: 5000, cached: 4000, output: 100 }),
    }, state, { file: "a" }),
    null,
  );

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 900, cached: 700, output: 20 }),
      total_token_usage: usage({ input: 5900, cached: 4700, output: 120 }),
    }, state, { file: "a" }),
    { input: 200, cache_r: 700, output: 20, countMessage: true },
  );
});

test("computeCodexTokenDelta: total 差分大于 last 时按 last 封顶，避免多报", () => {
  const state = {};

  scanner.computeCodexTokenDelta({
    last_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
    total_token_usage: usage({ input: 1000, cached: 800, output: 10 }),
  }, state, { file: "a" });

  assert.deepEqual(
    scanner.computeCodexTokenDelta({
      last_token_usage: usage({ input: 300_000_000, cached: 200_000_000, output: 1_000_000 }),
      total_token_usage: usage({ input: 120_000_001_000, cached: 90_000_000_800, output: 2_000_000_010 }),
    }, state, { file: "a" }),
    { input: 100_000_000, cache_r: 200_000_000, output: 1_000_000, countMessage: true },
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

test("computeCodexTokenDelta: 同文件 total reset 但没有 last 时不上报", () => {
  const state = {};
  scanner.computeCodexTokenDelta({
    last_token_usage: usage({ input: 3000, cached: 2000, output: 100 }),
    total_token_usage: usage({ input: 3000, cached: 2000, output: 100 }),
  }, state, { file: "a" });

  assert.equal(
    scanner.computeCodexTokenDelta({
      total_token_usage: usage({ input: 900, cached: 700, output: 20 }),
    }, state, { file: "a" }),
    null,
  );
});

test("aggregateCodex: total 快照异常跳涨时只上报 last 能确认的用量", async () => {
  const root = mkdirTemp();
  const sessions = path.join(root, "sessions", "2026", "07", "23");
  fs.mkdirSync(sessions, { recursive: true });

  const sid = "019f8262-139f-7fb2-9c54-cea49805db5b";
  const mainFile = path.join(sessions, `rollout-2026-07-23T08-00-00-${sid}.jsonl`);

  fs.writeFileSync(mainFile, [
    JSON.stringify({ timestamp: "2026-07-23T00:00:00.000Z", type: "session_meta", payload: { id: sid, cwd: "/tmp/astronos" } }),
    JSON.stringify({ timestamp: "2026-07-23T00:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    tokenLine("2026-07-23T00:00:02.000Z", usage({ input: 1000, cached: 800, output: 10 }), usage({ input: 1000, cached: 800, output: 10 })),
    tokenLine("2026-07-23T00:01:00.000Z", usage({ input: 300_000_000, cached: 200_000_000, output: 1_000_000 }), usage({ input: 120_000_001_000, cached: 90_000_000_800, output: 2_000_000_010 })),
  ].join("\n") + "\n", "utf8");

  const rows = await scanner.aggregateCodex(["2026-07-23"], [path.join(root, "sessions")]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].messages, 2);
  assert.equal(rows[0].input, 100_000_200);
  assert.equal(rows[0].cache_r, 200_000_800);
  assert.equal(rows[0].output, 1_000_010);
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
