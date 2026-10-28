"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const {spawn} = require("child_process");

for (const mode of ["confirmed","unconfirmed","truncated"]) {
  test(`uploader ${mode}: only confirmed intact content is moved to sent`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),"ai-otel-upload-"));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const raw = path.join(root,"raw-bodies"); fs.mkdirSync(raw);
    const file = path.join(raw,"test.request.json");
    const content = Buffer.from('{"test":"body"}');
    fs.writeFileSync(file,content);
    const old = new Date(Date.now()-60000); fs.utimesSync(file,old,old);
    const chunks = [];
    let metadata;
    const server = http.createServer(async (req,res)=> {
      const data = [];
      for await (const chunk of req) data.push(chunk);
      const body = Buffer.concat(data);
      res.setHeader("Content-Type","application/json");
      if (req.url.endsWith("/init")) {
        metadata = JSON.parse(body);
        if (mode === "truncated") fs.truncateSync(file,0);
        res.end(JSON.stringify({upload_id:"test",chunk_size:4}));
      } else if (req.url.includes("/chunks/")) {
        chunks.push(body); res.end('{"ok":true}');
      } else {
        const hash = crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
        assert.equal(JSON.parse(body).content_sha256,hash);
        res.end(JSON.stringify(mode === "confirmed" ? {upload_status:"completed",content_sha256:hash} : {}));
      }
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    for (const name of ["raw-body-uploader.js","spool-storage.js"]) {
      fs.copyFileSync(path.join(__dirname,"../templates",name),path.join(root,name));
    }
    fs.writeFileSync(path.join(root,"endpoint.json"),JSON.stringify({
      machineId:"test-machine",rawBodiesDir:raw,rawBodiesMinFreeBytes:1,
      rawUploadUrl:`http://127.0.0.1:${server.address().port}/v1/raw-bodies`,
    }));
    const child = spawn(process.execPath,[path.join(root,"raw-body-uploader.js"),"--once"],{stdio:"pipe"});
    const timer = setTimeout(()=>child.kill("SIGKILL"),8000);
    const exit = await new Promise(resolve=>child.once("close",resolve)); clearTimeout(timer);
    assert.equal(exit,0);
    const state = JSON.parse(fs.readFileSync(path.join(root,"raw-uploader","state.json")));
    const entry = Object.values(state.files)[0];
    assert.equal(metadata.file_size,content.length);
    assert.equal(entry.uploaded,mode === "confirmed");
    assert.equal(fs.existsSync(file),mode !== "confirmed");
    if (mode === "confirmed") assert.deepEqual(Buffer.concat(chunks),content);
    else assert.match(entry.lastError,mode === "truncated" ? /source changed/ : /not confirmed/);
  });
}
