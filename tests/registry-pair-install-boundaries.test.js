// Distinct from malformed-registry coverage: a successful reader that omits one required field must not publish.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {test} from 'node:test';import {createHash} from 'node:crypto';import {sealedPath} from './sealed-path.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),posix=value=>value.replaceAll('\\','/');
const required=['REGISTRY_FINGERPRINT','STRICT_EXTRA_MCP_B64','SESSION_MCP_B64','SESSION_HTTP_B64'];
const snapshot=folder=>Object.fromEntries(fs.readdirSync(folder).sort().map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(folder,file))).digest('hex')]));
function fixture(t,missing){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'missing-registry-pair-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const out=path.join(dir,'out'),home=path.join(dir,'home'),bin=path.join(dir,'bin'),state=path.join(dir,'state'),records=path.join(state,'launchers');
 for(const folder of [out,home,bin,records])fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(out,'claude-aify'),'owned existing launcher');fs.writeFileSync(path.join(records,'previous.args'),'owned existing record');
 fs.writeFileSync(path.join(bin,'node'),'#!/bin/bash\nif [ "${1:-}" = --owned-positive ]; then printf owned-reader; exit 0; fi\nprintf "%s\\n" "$*" >> "$PAIR_READER_CALLS"\nprintf "%s\\n" "$PAIR_READER_OUTPUT"\n',{mode:0o755});
 const seal=sealedPath([]),calls=path.join(dir,'calls'),values={REGISTRY_FINGERPRINT:'a'.repeat(64),STRICT_EXTRA_MCP_B64:'',SESSION_MCP_B64:'',SESSION_HTTP_B64:''};
 const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),PATH:bin+path.delimiter+seal.PATH,PAIR_READER_CALLS:posix(calls),PAIR_READER_OUTPUT:Object.entries(values).filter(([name])=>name!==missing).map(([name,value])=>name+'='+value).join('\n')};
 // Poison every required inherited value: a missing successful output cannot be repaired from the caller's env.
 for(const name of required)env[name]='must-not-be-inherited';
 const control=spawnSync('bash',['-c','node --owned-positive'],{env,encoding:'utf8',timeout:5000});assert.equal(control.status,0,control.stderr);assert.equal(control.stdout,'owned-reader');assert.equal(fs.existsSync(calls),false,'positive lookup must not create the reader-call condition');
 const before={target:snapshot(out),records:snapshot(records)};
 const run=spawnSync('bash',[posix(path.join(ROOT,'install.sh')),'--client','claude','--endpoint','http://127.0.0.2:1','--dest',posix(out),'--registry',posix(path.join(state,'services.json'))],{env,encoding:'utf8',timeout:20000});
 return {run,before,after:{target:snapshot(out),records:snapshot(records)},calls:fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n'):[],text:fs.readFileSync(path.join(out,'claude-aify'),'utf8')};
}
for(const missing of required)test(`successful reader missing ${missing} refuses78 and preserves existing target/records`,t=>{
 const result=fixture(t,missing);
 assert.deepEqual({status:result.run.status,named:result.run.stderr.includes('registry reader gave no '+missing),target:result.after.target,records:result.after.records},
  {status:78,named:true,target:result.before.target,records:result.before.records},'required result refusal and nonmutation must hold together');
 assert.equal(result.calls.length,1,'one registry Node start, not a category-enumeration process');assert.match(result.calls[0],/install-pairs/);
});
test('CONTROL: present empty fragment values install with one reader call, not inherited poison',t=>{
 const result=fixture(t);assert.equal(result.run.status,0,result.run.stderr);assert.equal(result.calls.length,1);assert.match(result.text,/^HARNESS_REGISTRY_FINGERPRINT="a{64}"$/m);assert.doesNotMatch(result.text,/must-not-be-inherited/);assert.notDeepEqual(result.after.target,result.before.target);
});
