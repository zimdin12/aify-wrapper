// Actual renders and read-only CLI judgments, with independent SHA/version/root/alias oracles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {registryPairs} from '../lib/launcher-rerender.mjs';
import {PendingHermesConfig} from '../lib/hermes-pending-config.mjs';
import {LauncherProvenanceReader} from '../lib/launcher-provenance.mjs';
import {readRecords} from '../lib/render-record.mjs';
import {compareTemplateSource,isTemplateFilename,sha256Bytes} from '../lib/template-source.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),CHECK=path.join(ROOT,'bin/aify-wrapper-check.mjs');
const WIN=process.platform==='win32';
const BASH=execFileSync('bash',['-c',WIN?'cygpath -w "$(command -v bash)"':'command -v bash'],{encoding:'utf8'}).trim();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function world(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aify-template-check-')),owner=path.join(dir,'owner'),dest=path.join(dir,'out'),registry=path.join(dir,'services.json');
 fs.mkdirSync(owner);fs.mkdirSync(dest);fs.cpSync(path.join(ROOT,'wrappers'),path.join(owner,'wrappers'),{recursive:true});
 fs.copyFileSync(path.join(ROOT,'render.sh'),path.join(owner,'render.sh'));fs.writeFileSync(path.join(owner,'VERSION'),'1.2.3\n');fs.writeFileSync(registry,'{"version":1,"services":{}}');
 return {dir,owner,dest,registry,records:path.join(dir,'launchers'),pending:path.join(dir,'pending.json')};
}
function render(w,{client='pi',version='1.2.3',record=true,pairs=[],env:extra={}}={}){
 const target=path.join(w.dest,`${client}-aify`),template=`${client}-aify.sh.in`;
 const env={...process.env,...extra};
 if(extra.PATH!==undefined){for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];env.PATH=extra.PATH;}
 delete env.RENDER_RECORD_DIR;if(record)env.RENDER_RECORD_DIR=w.records;
 const run=spawnSync(BASH,[path.join(w.owner,'render.sh'),template,target,
  'ENDPOINT=http://127.0.0.2:1',`WRAPPER_DIR=${w.owner.replaceAll('\\','/')}`,`WRAPPER_VERSION=${version}`,'SERVICE_NAME=aify-comms','MCP_TRANSPORT=stdio','BRIDGE_DIR=/owned/bridge','NATIVE_BASE=/owned/base','SCRIPT_DIR=/owned/source',
  'HERMES_PLUGIN_PATH=','HERMES_STDIO_DIR=','HERMES_TUI_DIR=',...registryPairs('',template,{}).pairs,...pairs],{encoding:'utf8',env,timeout:30000});
 return {run,target};
}
function check(w,{json=true,strict=true}={}){
 const run=spawnSync(process.execPath,[CHECK,'--dest',w.dest,'--registry',w.registry,'--pending',w.pending,...(json?['--json']:[]),...(strict?['--strict']:[])],{encoding:'utf8',timeout:30000});
 return {run,report:json?JSON.parse(run.stdout):null};
}
function made(w,options){const result=render(w,options);assert.equal(result.run.status,0,result.run.stderr);return result.target;}
function unmark(target){fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^HARNESS_TEMPLATE_.*\n/gm,''));}
function reason(report,source,state){return [...report.current,...report.stale,...report.unknown].flatMap(row=>row.reasons??[]).find(row=>row.source===source&&row.state===state);}

for(const client of ['claude','codex','hermes','pi'])test(`${client} actual render stamps its own template SHA and fresh CLI verdict is current`,()=>{
 const w=world(),target=made(w,{client});const text=fs.readFileSync(target,'utf8');
 assert.ok(text.startsWith('#!/bin/bash\n'),'shebang remains first');
 assert.equal(/^HARNESS_TEMPLATE_SHA256="([^"]+)"$/m.exec(text)?.[1],sha(fs.readFileSync(path.join(w.owner,`wrappers/${client}-aify.sh.in`))));
 const {run,report}=check(w);assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(report.ok,true);assert.ok(reason(report,'template','current'));
});
test('template drift is stale with typed SHA evidence and strict failure',()=>{
 const w=world(),template=path.join(w.owner,'wrappers/pi-aify.sh.in'),installed=sha(fs.readFileSync(template));made(w);fs.appendFileSync(template,'\n# changed owner template\n');
 const direct=compareTemplateSource({wrapperRoot:w.owner,template:'pi-aify.sh.in',templateSha:installed});
 assert.equal(direct.state,'stale');assert.equal(direct.installed,installed);assert.equal(direct.expected,sha(fs.readFileSync(template)));
 const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.stale.length,1);const evidence=reason(report,'template','stale');assert.ok(evidence);assert.notEqual(evidence.installed,evidence.expected);
 assert.equal(report.stale[0].installed,report.stale[0].expected,'registry fields are still registry digests, not template SHA');
 const text=check(w,{json:false}).run.stdout;assert.match(text,/template changed/i);assert.match(text,/owner/);assert.doesNotMatch(text,/registry is [0-9a-f]{64}.*template/);
});
test('a package version bump cannot override matching template evidence',()=>{
 const w=world();made(w);fs.writeFileSync(path.join(w.owner,'VERSION'),'9.9.9\n');const {run,report}=check(w);assert.equal(run.status,0,run.stdout);assert.equal(report.current.length,1);
});
test('the pinned owning package, not this newer checker package, decides current',()=>{
 const w=world();fs.appendFileSync(path.join(w.owner,'wrappers/pi-aify.sh.in'),'\n# distinct pinned source\n');made(w);
 const {run,report}=check(w);assert.equal(run.status,0,run.stdout);assert.ok(reason(report,'template','current'));assert.equal(report.current.length,1);
});
for(const record of [true,false])test(`unmarked matching-version launcher is UNKNOWN (record=${record}) and strict still fails`,()=>{
 const w=world();unmark(made(w,{record}));const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);assert.equal(report.current.length,0);assert.ok(reason(report,'provenance','unknown'));
 const text=check(w,{json:false}).run.stdout;assert.match(text,/stamp provenance/i);assert.match(text,/owner/);assert.doesNotMatch(text,/restart|update.*global checker/i);
 assert.equal(check(w,{strict:false}).run.status,0,'diagnostic non-strict exit semantics stay unchanged');
});
test('unmarked known version mismatch is stale with both versions, never a registry digest relabel',()=>{
 const w=world();unmark(made(w,{version:'0.0.1-ancient',record:false}));const {run,report}=check(w);assert.equal(run.status,1);const evidence=reason(report,'version','stale');assert.ok(evidence);assert.equal(evidence.installed,'0.0.1-ancient');assert.equal(evidence.expected,'1.2.3');
});
test('an unmarked unknown-version sentinel is not a known version mismatch',()=>{
 const w=world();unmark(made(w,{version:'unknown'}));const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);assert.equal(report.stale.length,0);
});
test('a control character in the owner VERSION is unavailable evidence, not printable stale output',()=>{
 const w=world();unmark(made(w));fs.writeFileSync(path.join(w.owner,'VERSION'),'1.2.3\u001bBAD');const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);assert.equal(report.stale.length,0);assert.doesNotMatch(check(w,{json:false}).run.stdout,/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
});
test('an unmarked versionless launcher remains unknown',()=>{
 const w=world(),target=made(w);unmark(target);fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^HARNESS_WRAPPER_VERSION=.*\n/m,''));const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);
});
test('a later render-only overwrite is judged from its marker, not the surviving record',()=>{
 const w=world();made(w);const record=path.join(w.records,fs.readdirSync(w.records)[0]),old=fs.readFileSync(record);
 fs.appendFileSync(path.join(w.owner,'wrappers/pi-aify.sh.in'),'\n# subsequent render\n');made(w,{record:false});assert.deepEqual(fs.readFileSync(record),old);
 const {run,report}=check(w);assert.equal(run.status,0,run.stdout);assert.equal(report.current.length,1);assert.ok(reason(report,'template','current'));assert.equal(reason(report,'template','current').recordState,'superseded');
});
test('alias follows primary TARGET even with a renamed record and has to agree byte for byte',()=>{
 const w=world(),primary=made(w),alias=path.join(w.dest,'omp-aify');fs.copyFileSync(primary,alias);
 const original=path.join(w.records,fs.readdirSync(w.records)[0]),renamed=path.join(w.records,'not-a-guessed-hash.args');fs.renameSync(original,renamed);
 if(WIN){const fields=fs.readFileSync(renamed,'utf8').split('\0');fields[2]=`TARGET=${fields[2].slice('TARGET='.length).toUpperCase()}`;fs.writeFileSync(renamed,fields.join('\0'));}
 let result=check(w);assert.equal(result.run.status,0,result.run.stdout);assert.equal(result.report.current.length,2);const aliasRow=result.report.current.find(row=>row.name==='omp-aify');assert.ok(Array.isArray(aliasRow.reasons));assert.ok(aliasRow.reasons.some(row=>row.recordTarget));
 fs.appendFileSync(alias,'\n# diverged alias\n');result=check(w);assert.equal(result.run.status,1);assert.ok(result.report.stale.some(row=>row.name==='omp-aify'));const evidence=reason(result.report,'alias','stale');assert.ok(evidence);
 const expected=sha256Bytes(fs.readFileSync(primary));assert.equal(expected,sha(fs.readFileSync(primary)));
 assert.equal(evidence.expected,expected);assert.equal(evidence.installed,sha(fs.readFileSync(alias)));
});
// A deterministic read order makes full TARGET identity disagree with basename-only matching.
test('a foreign same-basename record read first cannot claim the alias primary TARGET',()=>{
 const w=world(),primary=made(w),alias=path.join(w.dest,'omp-aify');fs.copyFileSync(primary,alias);
 const original=fs.readdirSync(w.records)[0],fields=fs.readFileSync(path.join(w.records,original),'utf8').split('\0');
 const foreign=path.join(w.dir,'foreign','pi-aify');fs.mkdirSync(path.dirname(foreign));fs.copyFileSync(primary,foreign);fields[2]=`TARGET=${foreign}`;
 fs.writeFileSync(path.join(w.records,'foreign.args'),fields.join('\0'));
 const io={...fs,readdirSync:directory=>path.resolve(directory)===path.resolve(w.records)?['foreign.args',original]:fs.readdirSync(directory)};
 const records=readRecords(w.records,io);assert.equal(records.length,2);assert.equal(records[0].target,foreign,'negative control: the foreign target really was read first');
 const bytes=fs.readFileSync(alias),result=new LauncherProvenanceReader({registryPath:w.registry,io}).read({name:'omp-aify',path:alias,text:bytes.toString('utf8'),bytes});
 const normalize=value=>WIN?path.resolve(value).toLowerCase():path.resolve(value);
 assert.equal(result.state,'current');assert.equal(normalize(result.recordTarget),normalize(primary));
});
for(const change of ['owner missing','template missing','duplicate marker','dynamic owner','relative owner'])test(`unreadable provenance fails closed: ${change}`,()=>{
 const w=world(),target=made(w),sentinel=path.join(w.dir,'EXECUTED');
 if(change==='owner missing')fs.renameSync(w.owner,`${w.owner}-moved`);
 if(change==='template missing')fs.unlinkSync(path.join(w.owner,'wrappers/pi-aify.sh.in'));
 if(change==='duplicate marker')fs.appendFileSync(target,'\nHARNESS_TEMPLATE_SHA256="'+'0'.repeat(64)+'"\n');
 if(change==='relative owner')fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^AIFY_WRAPPER_DIR_FWD=.*$/m,'AIFY_WRAPPER_DIR_FWD="relative-package"'));
 if(change==='dynamic owner')fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^AIFY_WRAPPER_DIR_FWD=.*$/m,`AIFY_WRAPPER_DIR_FWD="$(touch ${sentinel.replaceAll('\\','/')})"`));
 const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);assert.equal(fs.existsSync(sentinel),false);
});
test('registry disagreement stays stale when template provenance is unavailable',()=>{
 const w=world();unmark(made(w));fs.writeFileSync(w.registry,'{"version":1,"services":{"other":{"endpoint":"http://127.0.0.2:1"}}}');const {run,report}=check(w);assert.equal(run.status,1);assert.ok(reason(report,'registry','stale'));assert.ok(reason(report,'provenance','unknown'));
});
for(const key of ['HARNESS_TEMPLATE_NAME','HARNESS_TEMPLATE_SHA256','HARNESS_TEMPLATE_OWNER_ROOT'])test(`caller cannot supply generated ${key}`,()=>{
 const w=world(),target=path.join(w.dest,'pi-aify');fs.writeFileSync(target,'KEEP');const {run}=render(w,{pairs:[`${key}=forged`]});assert.equal(run.status,78);assert.match(run.stderr,/reserved|generated/i);assert.equal(fs.readFileSync(target,'utf8'),'KEEP');assert.equal(fs.existsSync(w.records),false);
});
test('ordinary unused render inputs remain supported with the existing null pending field',()=>{const w=world();made(w,{pairs:['UNUSED_PROBE=safe']});const shown=check(w);assert.equal(shown.run.status,0);assert.equal(shown.report.hermesConfigPending,null);});
test('customer pending JSON retains the actual producer fields',()=>{
 const w=world();made(w);const recordedAt='2026-11-07T00:00:00.000Z',target=path.join(w.dir,'owned-config.yaml');
 new PendingHermesConfig({marker:w.pending,now:()=>recordedAt}).record(w.registry,target);
 assert.deepEqual(check(w).report.hermesConfigPending,{recordedAt,registry:path.resolve(w.registry),target});
});
test('unreadable pending metadata retains its problem field',()=>{
 const w=world();made(w);fs.writeFileSync(w.pending,'{broken');const shown=check(w).report.hermesConfigPending;
 assert.ok(shown&&typeof shown==='object','pending field must remain an object when unreadable');assert.deepEqual(Object.keys(shown),['problem']);assert.equal(typeof shown.problem,'string');
});
for(const change of ['duplicate owner marker','dynamic owner marker'])test(`ambiguous generated owner fails closed: ${change}`,()=>{
 const w=world(),target=made(w),sentinel=path.join(w.dir,'SHOULD-NOT-RUN');
 if(change==='duplicate owner marker')fs.appendFileSync(target,'\nHARNESS_TEMPLATE_OWNER_ROOT=unavailable\n');
 else fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^HARNESS_TEMPLATE_OWNER_ROOT=.*$/m,`HARNESS_TEMPLATE_OWNER_ROOT="$(touch ${sentinel.replaceAll('\\','/')})"`));
 const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);assert.equal(fs.existsSync(sentinel),false);
});
test('public template comparison refuses invalid identity before any filesystem read',()=>{
 assert.equal(isTemplateFilename('pi-aify.sh.in'),true);assert.equal(isTemplateFilename('../VERSION'),false);
 let reads=0;const result=compareTemplateSource({wrapperRoot:'/owned',template:'../VERSION',templateSha:'0'.repeat(64),io:{readFileSync(){reads++;throw new Error('must not read');}}});
 assert.equal(result.state,'unknown');assert.equal(reads,0);
});
test('template identity cannot escape the owning wrappers directory',()=>{
 const w=world(),target=made(w),digest=sha(fs.readFileSync(path.join(w.owner,'VERSION')));
 fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^HARNESS_TEMPLATE_NAME=.*$/m,'HARNESS_TEMPLATE_NAME=../VERSION').replace(/^HARNESS_TEMPLATE_SHA256=.*$/m,`HARNESS_TEMPLATE_SHA256="${digest}"`));
 const {run,report}=check(w);assert.equal(run.status,1);assert.equal(report.unknown.length,1);
});

test('missing SHA tools still render successfully and explicitly report unavailable provenance',()=>{
 const w=world(),tools=path.join(w.dir,'tools');fs.mkdirSync(tools);
 for(const name of ['dirname','grep','sort','tr','mkdir','chmod','mv','basename','awk']){
  const source=execFileSync(BASH,['-c',WIN?'cygpath -w "$(command -v "$1")"':'command -v "$1"','_',name],{encoding:'utf8'}).trim();
  const target=path.join(tools,`${name}${WIN?'.exe':''}`);fs.copyFileSync(source,target);fs.chmodSync(target,0o755);
 }
 if(WIN)for(const file of fs.readdirSync(path.dirname(BASH)).filter(file=>file.toLowerCase().endsWith('.dll')))fs.copyFileSync(path.join(path.dirname(BASH),file),path.join(tools,file));
 const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==='PATH')delete env[key];env.PATH=tools;
 const control=spawnSync(BASH,['-c','command -v grep >/dev/null && ! command -v sha256sum && ! command -v shasum && ! command -v definitely_missing_provenance_tool'],{encoding:'utf8',env});assert.equal(control.status,0,control.stderr);
 const {run,target}=render(w,{env});assert.equal(run.status,0,run.stderr);assert.match(fs.readFileSync(target,'utf8'),/^HARNESS_TEMPLATE_SHA256="unavailable"$/m);assert.equal(check(w).report.unknown.length,1);
});
