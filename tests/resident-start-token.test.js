// New contracts: exact foreign parser bytes and formatter transport/omission/provenance, not OS process probing.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';import {test} from 'node:test';
import {checkoutSource} from './sibling-checkouts.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {root:source}=checkoutSource({variable:process.env.AIFY_ENV_SCHEMA_REPO!==undefined?'AIFY_ENV_SCHEMA_REPO':'AIFY_ENV_REPO',files:['lib/linux-process-token.mjs','tests/fixtures/process-identity-v1.json'],required:true});
const shared=JSON.parse(fs.readFileSync(path.join(source,'tests/fixtures/process-identity-v1.json'),'utf8'));
function write(t,{stat=shared.procStat,boot=shared.token.bootId,pid=shared.token.pid,capture='',harness='hermes',parserFailure}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resident-token-format-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let program=path.join(ROOT,'bin/aify-resident-record.mjs');
 if(parserFailure){
  fs.mkdirSync(path.join(dir,'bin'));program=path.join(dir,'bin/aify-resident-record.mjs');fs.copyFileSync(path.join(ROOT,'bin/aify-resident-record.mjs'),program);
  if(parserFailure!=='missing'){fs.mkdirSync(path.join(dir,'lib'));fs.writeFileSync(path.join(dir,'lib/linux-process-token.mjs'),parserFailure==='syntax'?'export const = invalid;':"throw new Error('owned parser load failure');");}
 }
 const run=spawnSync(process.execPath,[program,dir,'fixture-resident','residents',harness,String(pid),'/fixture/bin/hermes-aify',String(shared.legacyResident.writtenAtUs),'',capture,stat,boot],{encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);const names=fs.readdirSync(dir).filter(name=>name.endsWith('.json'));assert.equal(names.length,1);return JSON.parse(fs.readFileSync(path.join(dir,names[0]),'utf8'));
}
test('the Linux token leaf is an exact byte copy of the explicit env contract source',()=>{
 const copy=path.join(ROOT,'lib/linux-process-token.mjs');assert.ok(fs.existsSync(copy),'copied Linux token module missing');assert.deepEqual(fs.readFileSync(copy),fs.readFileSync(path.join(source,'lib/linux-process-token.mjs')));
});
// The CLI formatter above drives linuxStartTokenFromStat; shared fixture cases pin the copy's remaining format/equality surface.
for(const specimen of shared.cases)test(`shared identity fixture: ${specimen.name}`,async()=>{
 const copy=path.join(ROOT,'lib/linux-process-token.mjs');assert.ok(fs.existsSync(copy),'token copy prerequisite missing');
 const {linuxStartTokenFrom,sameLinuxStartToken}=await import(pathToFileURL(copy).href);
 const token=value=>value==='same'?shared.token:value===null?null:{...shared.token,...value};
 const record=token(specimen.recordToken),probe=token(specimen.probeToken);
 assert.equal(sameLinuxStartToken(record,probe,shared.token.pid),specimen.verified==='yes');
 if(specimen.verified==='yes')assert.deepEqual(linuxStartTokenFrom(record,shared.token.pid),shared.token);
});
test('formatter preserves exact token shape and raw ticks beyond Number precision',t=>{const record=write(t);assert.deepEqual(record.startToken,shared.token);assert.deepEqual(Object.keys(record.startToken).sort(),['version','platform','bootId','pid','startTicks'].sort());});
test('formatter finds field22 after complex comm parentheses and embedded newline',t=>{
 const stat=shared.procStat.replace('(hermes shell)','(a (complex) name\nwith )) parentheses)');const record=write(t,{stat});assert.deepEqual(record.startToken,shared.token);
});
for(const[name,change]of [
 ['missing stat',{stat:''}],['missing boot',{boot:''}],['bad boot',{boot:'not-a-boot'}],['wrong captured PID',{stat:shared.procStat.replace(/^41236 /,'41237 ')}],
 ['recorded child PID',{pid:41237}],['truncated stat',{stat:'41236 (shell) S 1 2'}],['non-decimal tick',{stat:shared.procStat.replace('9007199254740993','9e15')}],
])test(`formatter omits Linux identity for ${name} but keeps the legacy record`,t=>{const record=write(t,change);assert.equal(Object.hasOwn(record,'startToken'),false);assert.equal(record.pid,change.pid??shared.token.pid);assert.ok(record.lifetime);});
// New availability boundary: optional parser load failures must not turn a valid resident launch into failure.
for(const parserFailure of ['missing','syntax','throws'])test(`partial writer bundle ${parserFailure} parser still writes a legacy record`,t=>{
 const record=write(t,{parserFailure});assert.ok(record.lifetime);assert.equal(Object.hasOwn(record,'startToken'),false);
});
test('valid token addition preserves the existing optional startup provenance slot',t=>{
 const capture={agentId:'fixture-resident',harness:'claude',intent:'replace',producer:'SessionStart',storeId:'fixture-store',incarnation:1,revision:2,stopRevision:0,stopReceipt:'a'.repeat(64)};
 const record=write(t,{harness:'claude',capture:JSON.stringify(capture)});assert.deepEqual(record.startToken,shared.token);assert.deepEqual(record.operatorStart,capture);
});
