"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {spawnSync} = require("child_process");
const storage = require("../templates/spool-storage");
const {__test__: uploader} = require("../templates/raw-body-uploader");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-spool-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const raw = path.join(root, "raw-bodies");
  const upload = path.join(root, "raw-uploader");
  fs.mkdirSync(raw);
  function file(name, size = 32, age = 60000) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, Buffer.alloc(size));
    const when = new Date(Date.now() - age);
    fs.utimesSync(full, when, when);
    return full;
  }
  return {root, raw, upload, file};
}
const quota = {rawBodiesSoftLimitBytes: 80, rawBodiesHardLimitBytes: 100,
  rawBodiesTargetLimitBytes: 60, rawBodiesMinFreeBytes: 1};

test("counts legacy locks, partials, sent and state; does not upload temporary names", t => {
  const f = fixture(t);
  f.file("raw-bodies/snapshot-s-1-stop.snapshot.bundle.lock", 120);
  f.file(`raw-bodies/.snapshot-${process.pid}-abc.partial`, 20);
  f.file("raw-uploader/sent/day/a.request.json", 30);
  f.file("raw-uploader/state.json", 10);
  const usage = storage.inventory(f.raw);
  assert.equal(usage.total, 180);
  assert.equal(storage.isRawFile("snapshot-s-1-stop.snapshot.bundle.lock"), false);
  assert.equal(storage.canReserve(f.raw, quota, 1), false);
});

test("cleans old legacy locks and dead writers, preserving fresh locks and live writers", t => {
  const f = fixture(t);
  const old = f.file("raw-bodies/snapshot-s-1-stop.snapshot.bundle.lock", 20, 2 * storage.DAY);
  const fresh = f.file("raw-bodies/snapshot-s-2-stop.snapshot.bundle.lock", 20);
  const live = f.file(`raw-bodies/.snapshot-${process.pid}-abc.partial`, 20, 2 * storage.DAY);
  const dead = f.file("raw-bodies/.snapshot-2147483647-abc.partial", 20);
  const unrelated = f.file("raw-bodies/other.lock", 20, 2 * storage.DAY);
  const out = storage.maintain(f.raw, quota, {freeBytes: () => 100000});
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(dead), false);
  for (const file of [fresh, live, unrelated]) assert.equal(fs.existsSync(file), true);
  assert.equal(out.total, 60);
});

test("pressure reclaims sent data before touching stable pending bodies", t => {
  const f = fixture(t);
  const pending = f.file("raw-bodies/p.request.json", 50);
  const sent = f.file("raw-uploader/sent/day/s.request.json", 70);
  const result = storage.maintain(f.raw, quota, {freeBytes: () => 10000});
  assert.equal(fs.existsSync(pending), true);
  assert.equal(fs.existsSync(sent), false);
  assert.equal(result.total, 50);
});

test("low-space eviction rechecks free bytes and stops after enough space is recovered", t => {
  const f = fixture(t);
  const first = f.file("raw-bodies/old.request.json", 20, 120000);
  const second = f.file("raw-bodies/new.request.json", 20, 60000);
  const result = storage.maintain(f.raw, {...quota, rawBodiesMinFreeBytes: 10}, {
    freeBytes: () => fs.existsSync(first) ? 5 : 25,
  });
  assert.equal(result.removed.length, 1);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(second), true);
});

test("quota evicts oldest stable bodies but preserves fresh files and unknown raw files", t => {
  const f = fixture(t);
  const first = f.file("raw-bodies/old.request.json", 50, 120000);
  const next = f.file("raw-bodies/new.request.json", 30, 60000);
  const fresh = f.file("raw-bodies/fresh.response.json", 10, 0);
  const unknown = f.file("raw-bodies/unknown.data", 20);
  const result = storage.maintain(f.raw, quota, {freeBytes: () => 100000});
  assert.equal(fs.existsSync(first), false);
  for (const file of [next, fresh, unknown]) assert.equal(fs.existsSync(file), true);
  assert.equal(result.total, 60);
});

test("retention removes expired pending bodies even below quota", t => {
  const f = fixture(t);
  const old = f.file("raw-bodies/old.snapshot.bundle", 10, 8 * storage.DAY);
  const result = storage.maintain(f.raw, quota, {freeBytes: () => 100000});
  assert.equal(fs.existsSync(old), false);
  assert.equal(result.removed[0].reason, "pending_retention_expired");
});

test("writer lock serializes Claude and Codex producers and recovers a dead owner", t => {
  const f = fixture(t);
  const release = storage.acquireWriter(f.raw);
  assert.equal(typeof release, "function");
  assert.equal(storage.acquireWriter(f.raw), null);
  release();
  fs.writeFileSync(path.join(f.raw,".snapshot-writer.lock"), JSON.stringify({pid:2147483647,token:"dead"}));
  const recovered = storage.acquireWriter(f.raw);
  assert.equal(typeof recovered, "function");
  recovered();
  assert.deepEqual(fs.readdirSync(f.raw), []);
});

test("inventory and cleanup do not follow directory symlinks", t => {
  const f = fixture(t);
  const outside = f.file("outside/secret.request.json", 500, 8 * storage.DAY);
  try { fs.symlinkSync(path.dirname(outside), path.join(f.raw,"link"), "junction"); }
  catch (e) { if (e.code === "EPERM") return t.skip("symlinks require privileges"); throw e; }
  assert.equal(storage.inventory(f.raw).total, 0);
  storage.maintain(f.raw, quota, {freeBytes: () => 100000});
  assert.equal(fs.existsSync(outside), true);
});

test("uploader cleans orphan files even when upload URL is absent", t => {
  const f = fixture(t);
  for (const name of ["raw-body-uploader.js","spool-storage.js"]) {
    fs.copyFileSync(path.join(__dirname,"../templates",name), path.join(f.root,name));
  }
  fs.writeFileSync(path.join(f.root,"endpoint.json"), JSON.stringify({rawBodiesDir:f.raw, ...quota}));
  const old = f.file("raw-bodies/snapshot-s-1-stop.snapshot.bundle.lock", 100, 2 * storage.DAY);
  const run = spawnSync(process.execPath,[path.join(f.root,"raw-body-uploader.js"),"--once"], {encoding:"utf8",timeout:5000});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.upload,"state.json"))).diskGuard.lastCleanedFiles, 1);
});

test("uploader state has bounded history and retains recent upload receipts", () => {
  const state = {files: {expired:{uploaded:true,uploadedAt:new Date(Date.now()-31*storage.DAY).toISOString()}}};
  for(let i=0;i<5010;i++) state.files[i] = {uploaded:true,uploadedAt:new Date(Date.now()-i).toISOString()};
  uploader.pruneState(state);
  assert.equal(Object.keys(state.files).length, 5000);
  assert.equal(state.files.expired, undefined);
  assert.equal(state.files[0].uploaded, true);
});

test("counts uploader metadata and cleans dead atomic-state writes without deleting unknown metadata", t => {
  const f = fixture(t);
  const dead = f.file("raw-uploader/state.json.tmp.2147483647", 30);
  const live = f.file(`raw-uploader/state.json.tmp.${process.pid}`, 20);
  const unknown = f.file("raw-uploader/unknown.data", 10);
  assert.equal(storage.inventory(f.raw).total,60);
  const result = storage.maintain(f.raw,quota,{freeBytes:()=>100000});
  assert.equal(result.total,30);
  assert.equal(fs.existsSync(dead),false);
  assert(fs.existsSync(live)); assert(fs.existsSync(unknown));
});

test("overlapping custom spool roots are counted once and sent files remain reclaimable", t => {
  const f = fixture(t);
  f.file("raw-bodies/p.request.json",30);
  const sent = f.file("raw-bodies/uploader/sent/day/s.request.json",60);
  const cfg = {...quota,rawUploaderDir:path.join(f.raw,"uploader")};
  assert.equal(storage.inventory(f.raw,cfg).total,90);
  storage.maintain(f.raw,cfg,{freeBytes:()=>100000});
  assert.equal(fs.existsSync(sent),false);
  assert.equal(storage.inventory(f.raw,cfg).total,30);
});
