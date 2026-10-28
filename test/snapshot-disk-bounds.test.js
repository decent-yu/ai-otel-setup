"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFileSync, spawn} = require("child_process");
const {__test__: snapshot} = require("../templates/git-snapshot");
const storage = require("../templates/spool-storage");

function git(repo, ...args) {
  return execFileSync("git", ["-C",repo,...args], {encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
}
function fixture(t, initial = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-otel-bounded-"));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const repo = path.join(root,"repo");
  const raw = path.join(root,"raw-bodies");
  fs.mkdirSync(repo); fs.mkdirSync(raw);
  git(repo,"init"); git(repo,"config","user.name","Snapshot Test"); git(repo,"config","user.email","test@example.invalid");
  fs.writeFileSync(path.join(repo,"a.txt"),"baseline\n");
  let head = "";
  if (!initial) { git(repo,"add","-A"); git(repo,"commit","-m","baseline"); head = git(repo,"rev-parse","HEAD"); }
  const cfg = {rawBodiesDir:raw, rawBodiesMinFreeBytes:1,
    gitSnapshotBundleMaxBytes:4096, gitSnapshotFileMaxBytes:1024,
    gitSnapshotWorkspaceMaxBytes:2048};
  let tick = Date.now();
  const capture = (extra = {}, session = "test-session", event = "stop", seq = "p_1") =>
    snapshot.captureSnapshot(repo,session,event,++tick,seq,"cc",head,{...cfg,...extra});
  return {root,repo,raw,head,cfg,capture};
}

for (const remote of ["https://example.invalid/team/repo.git","ssh://git@example.invalid:2222/team/repo.git","git@example.invalid:team/repo.git"]) {
  test(`bounded bundle restores dirty and untracked files for ${remote}`, async t => {
    const f = fixture(t);
    git(f.repo,"config","remote.origin.url",remote);
    fs.writeFileSync(path.join(f.repo,"a.txt"),"staged version\n"); git(f.repo,"add","a.txt");
    fs.writeFileSync(path.join(f.repo,"a.txt"),"workspace version\n");
    fs.writeFileSync(path.join(f.repo,"[literal] file.txt"),"untracked\n");
    const index = fs.readFileSync(path.join(f.repo,".git","index"));
    const branch = git(f.repo,"symbolic-ref","HEAD");
    const result = await f.capture();
    assert.equal(result.status,"created");
    assert.deepEqual(fs.readFileSync(path.join(f.repo,".git","index")),index);
    assert.equal(git(f.repo,"rev-parse","HEAD"),f.head);
    assert.equal(git(f.repo,"symbolic-ref","HEAD"),branch);
    const bundle = path.join(f.raw,result.bundleFile);
    assert(fs.statSync(bundle).size <= 4096);
    git(f.repo,"bundle","verify",bundle);
    const restore = path.join(f.root,"restore");
    execFileSync("git",["clone","--no-hardlinks",f.repo,restore],{stdio:"ignore"});
    git(restore,"bundle","unbundle",bundle);
    assert.equal(git(restore,"show",`${result.snap.commit}:a.txt`),"workspace version");
    assert.equal(git(restore,"show",`${result.snap.commit}:[literal] file.txt`),"untracked");
    assert.deepEqual(fs.readdirSync(f.raw),[result.bundleFile]);
  });
}

test("initial repository produces a verifiable standalone bounded bundle", async t => {
  const f = fixture(t,true);
  const result = await f.capture();
  assert.equal(result.status,"created");
  git(f.repo,"bundle","verify",path.join(f.raw,result.bundleFile));
  assert.equal(git(f.repo,"show",`${result.snap.commit}:a.txt`),"baseline");
  assert.equal(fs.existsSync(path.join(f.repo,".git","index")),false);
});

test("oversized files are rejected before adding objects or refs", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo,"big.bin"),Buffer.alloc(512));
  const objects = git(f.repo,"count-objects","-v");
  const out = await f.capture({gitSnapshotFileMaxBytes:128});
  assert.equal(out.status,"workspace_file_too_large");
  assert.equal(git(f.repo,"count-objects","-v"),objects);
  assert.equal(git(f.repo,"for-each-ref","refs/snapshots/"),"");
  assert.deepEqual(fs.readdirSync(f.raw),[]);
});

test("workspace total and path count limits are independent of text diff truncation", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo,"one.bin"),Buffer.alloc(128));
  fs.writeFileSync(path.join(f.repo,"two.bin"),Buffer.alloc(128));
  assert.equal((await f.capture({gitSnapshotWorkspaceMaxBytes:200})).status,"workspace_bytes_exceeded");
  assert.equal((await f.capture({gitSnapshotWorkspaceMaxFiles:1})).status,"workspace_file_count_exceeded");
  assert.equal(git(f.repo,"for-each-ref","refs/snapshots/"),"");
});

test("quota reservation counts unknown bytes and stops before creating Git objects", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.raw,"unknown.data"),Buffer.alloc(100));
  fs.writeFileSync(path.join(f.repo,"a.txt"),"changed\n");
  const before = git(f.repo,"count-objects","-v");
  const out = await f.capture({rawBodiesHardLimitBytes:4200});
  assert.equal(out.status,"spool_quota_exceeded");
  assert.equal(git(f.repo,"count-objects","-v"),before);
  assert.deepEqual(fs.readdirSync(f.raw),["unknown.data"]);
});

test("ref ceiling stops new objects when existing recovery points cannot be retired", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo,"a.txt"),"first\n");
  assert.equal((await f.capture()).status,"created");
  fs.writeFileSync(path.join(f.repo,"a.txt"),"second\n");
  const before = git(f.repo,"count-objects","-v");
  assert.equal((await f.capture({gitSnapshotMaxRefs:1})).status,"snapshot_ref_limit");
  assert.equal(git(f.repo,"count-objects","-v"),before);
});

test("real Git overflow removes its partial file and newly created ref", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo,"a.txt"),"changed\n");
  const result = await f.capture({gitSnapshotBundleMaxBytes:32});
  assert.equal(result.status,"bundle_bytes_exceeded");
  assert.equal(git(f.repo,"for-each-ref","refs/snapshots/"),"");
  assert.deepEqual(fs.readdirSync(f.raw),[]);
});

test("bounded output aborts at byte ceiling instead of writing an oversized partial", async t => {
  const f = fixture(t);
  let child;
  let peak = 0;
  const watch = setInterval(() => {
    for (const name of fs.readdirSync(f.raw)) {
      if (name.endsWith(".partial")) peak = Math.max(peak,fs.statSync(path.join(f.raw,name)).size);
    }
  },5);
  const fake = () => {
    child = spawn(process.execPath,["-e","process.stdout.write(Buffer.alloc(32)); setTimeout(()=>process.stdout.write(Buffer.alloc(32)),100); setInterval(()=>{},1000)"],{stdio:["ignore","pipe","pipe"]});
    return child;
  };
  try {
    await assert.rejects(snapshot.writeSnapshotBundle(f.repo,f.raw,"s","stop",1,"ref","cc",f.head,
      {...f.cfg,gitSnapshotBundleMaxBytes:48},fake),error=>error.reason === "bundle_bytes_exceeded");
    assert(peak > 0 && peak <= 48);
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(fs.readdirSync(f.raw),[]);
  } finally { clearInterval(watch); }
});

test("timeout and nonzero exporter exit publish nothing and clean owned partial files", async t => {
  const f = fixture(t);
  for (const [script,reason] of [["setInterval(()=>{},1000)","bundle_timeout"],
    ["process.stdout.write('incomplete');process.exit(1)","bundle_export_failed"]]) {
    const fake = () => spawn(process.execPath,["-e",script],{stdio:["ignore","pipe","pipe"]});
    await assert.rejects(snapshot.writeSnapshotBundle(f.repo,f.raw,"s","stop",1,"ref","cc",f.head,
      {...f.cfg,gitSnapshotBundleTimeoutMs:script.includes("setInterval") ? 80 : 5000},fake),
    error=>error.reason === reason);
    assert.deepEqual(fs.readdirSync(f.raw),[]);
  }
});

test("a successful exit with malformed bundle content is not published", async t => {
  const f = fixture(t);
  const fake = () => spawn(process.execPath,["-e","process.stdout.write('not a git bundle')"],{stdio:["ignore","pipe","pipe"]});
  await assert.rejects(snapshot.writeSnapshotBundle(f.repo,f.raw,"s","stop",1,"ref","cc",f.head,f.cfg,fake));
  assert.deepEqual(fs.readdirSync(f.raw),[]);
});

test("writer contention skips the new snapshot and preserves the active owner's lock", async t => {
  const f = fixture(t);
  const release = storage.acquireWriter(f.raw);
  try { assert.equal((await f.capture()).status,"snapshot_writer_busy"); }
  finally { release(); }
});

test("old refs retire only with upload receipts and preserve the current session's last frame", async t => {
  const f = fixture(t);
  const commit = f.head;
  const oldTime = Date.now()-8*storage.DAY;
  const oldRef = `refs/snapshots/old-session/${oldTime}-stop`;
  const pendingRef = `refs/snapshots/pending-session/${oldTime}-stop`;
  const keepRef = `refs/snapshots/current-session/${oldTime}-stop`;
  for (const ref of [oldRef,pendingRef,keepRef]) git(f.repo,"update-ref",ref,commit);
  const dir = storage.uploaderDir(f.raw,f.cfg); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,"state.json"),JSON.stringify({files:{
    a:{uploaded:true,fileName:`snapshot-old-session-${oldTime}-stop.snapshot.bundle`},
    b:{uploaded:true,fileName:`snapshot-current-session-${oldTime}-stop.snapshot.bundle`},
  }}));
  assert.equal(snapshot.retireUploadedRefs(f.repo,"current-session",f.raw,f.cfg,Date.now()),2);
  const refs = git(f.repo,"for-each-ref","--format=%(refname)","refs/snapshots/");
  assert.equal(refs.includes(oldRef),false);
  assert(refs.includes(pendingRef)); assert(refs.includes(keepRef));
});

test("ref pressure retires confirmed older frames early without stopping an active session", async t => {
  const f = fixture(t);
  const first = await f.capture({},"test-session","user_prompt","p_1");
  const second = await f.capture({},"test-session","stop","p_1");
  const dir = storage.uploaderDir(f.raw,f.cfg); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,"state.json"),JSON.stringify({files:{a:{uploaded:true,fileName:first.bundleFile}}}));
  const third = await f.capture({gitSnapshotMaxRefs:2},"test-session","user_prompt","p_2");
  assert.equal(third.status,"created");
  const refs = git(f.repo,"for-each-ref","--format=%(refname)","refs/snapshots/");
  assert.equal(refs.includes(first.snap.refname),false);
  assert(refs.includes(second.snap.refname));
  assert(refs.includes(third.snap.refname));
  assert.match(git(f.repo,"show","-s","--format=%B",third.snap.commit),/prompt_id=p_2/);
});
