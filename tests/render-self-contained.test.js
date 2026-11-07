// Contract: external installers copy just render.sh and a template. Existing tests had copied bin/ too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseRecord} from '../lib/render-record.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=p=>p.split(String.fromCharCode(92)).join('/');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'render-alone-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'wrappers'));fs.mkdirSync(path.join(dir,'home'));
 fs.copyFileSync(path.join(ROOT,'render.sh'),path.join(dir,'render.sh'));
 fs.writeFileSync(path.join(dir,'wrappers/probe-aify.sh.in'),'#!/bin/bash\n#| stripped documentation\nENDPOINT="@@ENDPOINT@@"\n');
 const env={PATH:process.env.PATH,HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
 return{dir,env,target:path.join(dir,'probe-aify')};
}
test('copy-alone renderer adds only generated provenance to approved parent healthy bytes',t=>{
 const f=fixture(t),args=['probe-aify.sh.in',native(f.target),'ENDPOINT=http://127.0.0.2:1/p?a=1&b=2'];
 const parent=spawnSync('git',['-C',ROOT,'show','262c6e4:render.sh'],{encoding:'utf8'});assert.equal(parent.status,0,parent.stderr);
 const before=path.join(f.dir,'before-render.sh');fs.writeFileSync(before,parent.stdout);
 const old=spawnSync('bash',[native(before),...args],{env:f.env,encoding:'utf8'});assert.equal(old.status,0,old.stderr);const expected=fs.readFileSync(f.target);
 const current=spawnSync('bash',[native(path.join(f.dir,'render.sh')),...args],{env:f.env,encoding:'utf8'});
 assert.equal(current.status,0,current.stderr);
 const actual=fs.readFileSync(f.target,'utf8');
 assert.equal((actual.match(/^HARNESS_TEMPLATE_.*$/gm)||[]).length,3);
 const digest=createHash('sha256').update(fs.readFileSync(path.join(f.dir,'wrappers/probe-aify.sh.in'))).digest('hex');
 assert.match(actual,new RegExp(`^HARNESS_TEMPLATE_SHA256="${digest}"$`,'m'));
 assert.deepEqual(Buffer.from(actual.replace(/^HARNESS_TEMPLATE_.*\n/gm,'')),expected);
 assert.deepEqual(fs.readdirSync(f.dir).sort(),['before-render.sh','home','probe-aify','render.sh','wrappers']);
});
// Existing copy-alone cases do not inspect records or prove category handling avoids a Node enumeration start.
test('copy-alone record omits every recomputed/client-specific pair and retains transport, without Node',t=>{
 const f=fixture(t),records=path.join(f.dir,'records'),bin=path.join(f.dir,'tools');fs.mkdirSync(records);fs.mkdirSync(bin);
 const marker=path.join(f.dir,'unexpected-node'),positive=path.join(f.dir,'positive-node');
 fs.writeFileSync(path.join(bin,'node'),'#!/bin/bash\nif [ "${1:-}" = --positive ]; then printf controlled > "$POSITIVE_NODE"; exit 0; fi\nprintf unexpected > "$UNEXPECTED_NODE"\nexit 95\n',{mode:0o755});
 const env={...f.env,PATH:bin+path.delimiter+f.env.PATH,POSITIVE_NODE:native(positive),UNEXPECTED_NODE:native(marker),RENDER_RECORD_DIR:native(records)};
 const control=spawnSync('bash',['-c','node --positive'],{env,encoding:'utf8',timeout:5000});assert.equal(control.status,0,control.stderr);assert.equal(fs.readFileSync(positive,'utf8'),'controlled');assert.equal(fs.existsSync(marker),false);
 const pairs=['ENDPOINT=http://127.0.0.2:1','REGISTRY_FINGERPRINT=owned','STRICT_EXTRA_MCP_B64=owned','SESSION_MCP_B64=owned','SESSION_HTTP_B64=owned','SESSION_MCP_CODEX_B64=owned','MCP_TRANSPORT=http'];
 const run=spawnSync('bash',[native(path.join(f.dir,'render.sh')),'probe-aify.sh.in',native(f.target),...pairs],{env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);assert.equal(fs.existsSync(marker),false);
 const files=fs.readdirSync(records);assert.equal(files.length,1);const record=parseRecord(fs.readFileSync(path.join(records,files[0])));assert.ok(record);
 assert.deepEqual(record.pairs,['ENDPOINT=http://127.0.0.2:1','MCP_TRANSPORT=http'],'HTTP is recomputed too; transport is an override, not a record omission');
});
test('copy-alone direct argv refuses newline before target or record publication',t=>{
 const f=fixture(t),records=path.join(f.dir,'records');fs.mkdirSync(records);fs.writeFileSync(f.target,'existing-target');
 const carrier=path.join(f.dir,'argv-call.sh');fs.writeFileSync(carrier,'#!/bin/bash\nbash "$RENDER" probe-aify.sh.in "$TARGET" "ENDPOINT=$BAD_VALUE"\n');
 const run=spawnSync('bash',[native(carrier)],{env:{...f.env,RENDER:native(path.join(f.dir,'render.sh')),TARGET:native(f.target),BAD_VALUE:'bad\nvalue',RENDER_RECORD_DIR:native(records)},encoding:'utf8'});
 assert.equal(run.status,78,run.stderr);assert.match(run.stderr,/ENDPOINT.*control/);
 assert.equal(fs.readFileSync(f.target,'utf8'),'existing-target');assert.deepEqual(fs.readdirSync(records),[]);
});
