"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test__ } = require("../cli");

test("Codex HTTP exporters all carry the normalized Git email header", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "http",
    { email: " Alice@Example.Invalid " },
  );
  const header = 'headers = { "x-ai-otel-git-email" = "alice@example.invalid" }';
  assert.equal(lines.filter((line) => line === header).length, 3);
});

test("Codex gRPC exporters all carry the Git email header", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "grpc",
    { email: "alice@example.invalid" },
  );
  const header = 'headers = { "x-ai-otel-git-email" = "alice@example.invalid" }';
  assert.equal(lines.filter((line) => line === header).length, 3);
});

test("Codex exporters omit identity header when global Git email is unavailable", () => {
  const lines = __test__.buildCodexOtelBlock(
    "https://collector.example.invalid:24317",
    "http",
    { email: "" },
  );
  assert.equal(lines.some((line) => line.includes("x-ai-otel-git-email")), false);
});
