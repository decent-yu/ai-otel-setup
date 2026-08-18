const test = require("node:test");
const assert = require("node:assert/strict");

const uploader = require("../templates/raw-body-uploader.js").__test__;

// raw body 是逐字节原样上传（受 content_sha256 校验），倍率只体现在 init metadata；
// 这里只验证它与 local-usage-scanner 的解析口径完全一致。
test("resolveUsageMultiplier: 与 scanner 同口径，缺省回落 1", () => {
  assert.equal(uploader.resolveUsageMultiplier({}, {}), 1);
  assert.equal(uploader.resolveUsageMultiplier(null, null), 1);
  assert.equal(uploader.DEFAULT_USAGE_MULTIPLIER, 1);
});

test("resolveUsageMultiplier: endpoint.json 生效，env 优先级更高", () => {
  assert.equal(uploader.resolveUsageMultiplier({ usageMultiplier: 5 }, {}), 5);
  assert.equal(uploader.resolveUsageMultiplier({ usageMultiplier: 5 }, { AI_OTEL_USAGE_MULTIPLIER: "12" }), 12);
  assert.equal(uploader.resolveUsageMultiplier({ usageMultiplier: 5 }, { AI_OTEL_USAGE_MULTIPLIER: "abc" }), 5);
});

test("resolveUsageMultiplier: 非法值一律回落 1", () => {
  for (const bad of ["", "abc", "0", "-3", "NaN", "Infinity", null, undefined, String(uploader.MAX_USAGE_MULTIPLIER + 1)]) {
    assert.equal(uploader.normalizeUsageMultiplier(bad), null, `normalize ${JSON.stringify(bad)}`);
    assert.equal(uploader.resolveUsageMultiplier({ usageMultiplier: bad }, {}), 1, `cfg ${JSON.stringify(bad)}`);
    assert.equal(uploader.resolveUsageMultiplier({}, { AI_OTEL_USAGE_MULTIPLIER: bad }), 1, `env ${JSON.stringify(bad)}`);
  }
});
