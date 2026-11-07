// New properties: refusal before either artifact changes, and quoted-context round-trip of supported paths.
// Existing ampersand/privacy/atomic tests remain controls; this fixture never executes a native launcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { rerenderLaunchers } from '../lib/launcher-rerender.mjs';
import { encodeRenderFrame } from '../lib/render-frame.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const native=p=>p.split(String.fromCharCode(92)).join('/');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'render-input-boundary-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const name of ['wrappers','bin','launchers','home'])fs.mkdirSync(path.join(dir,name));
 fs.copyFileSync(path.join(ROOT,'render.sh'),path.join(dir,'render.sh'));
 fs.copyFileSync(path.join(ROOT,'wrappers/aliases'),path.join(dir,'wrappers/aliases'));
 for(const name of ['aify-input-boundary.sh','aify-render-frame.sh']){const helper=path.join(ROOT,'bin',name);if(fs.existsSync(helper))fs.copyFileSync(helper,path.join(dir,'bin',name));}
 const endpoint=fs.readFileSync(path.join(ROOT,'wrappers/claude-aify.sh.in'),'utf8').split('\n').find(line=>line.startsWith('HARNESS_ENDPOINT='));assert.ok(endpoint);
 fs.writeFileSync(path.join(dir,'wrappers/probe-aify.sh.in'),`#!/bin/bash\n${endpoint}\nBRIDGE="@@BRIDGE_DIR@@"\nprintf '%s\\0%s\\0' "$HARNESS_ENDPOINT" "$BRIDGE"\n`);
 const target=path.join(dir,'probe-aify'),records=path.join(dir,'launchers');
 const env={PATH:process.env.PATH,HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),RENDER_RECORD_DIR:records,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
 const render=pairs=>spawnSync('bash',[native(path.join(dir,'bin/aify-render-frame.sh'))],{input:encodeRenderFrame([native(path.join(dir,'render.sh')),'probe-aify.sh.in',native(target),...pairs]),env,encoding:'utf8',timeout:15000});
 const good=['ENDPOINT=http://127.0.0.2:1/p?a=1&b=2','BRIDGE_DIR=C:/Program Files/bridge'];
 const snapshot=()=>({target:fs.readFileSync(target),mode:fs.statSync(target).mode,records:fs.readdirSync(records).sort().map(name=>({name,bytes:fs.readFileSync(path.join(records,name)),mode:fs.statSync(path.join(records,name)).mode}))});
 const start=render(good);assert.equal(start.status,0,start.stderr);assert.ok(fs.readdirSync(records).length,'healthy record control missing');
 return{dir,target,records,env,render,good,snapshot};
}
test('direct argv preserves parent body bytes and matches framed output including provenance',t=>{
 const f=fixture(t),parent=spawnSync('git',['-C',ROOT,'show','262c6e4:render.sh'],{encoding:'utf8'});assert.equal(parent.status,0,'approved parent source missing');
 const beforeFile=path.join(f.dir,'before-render.sh');fs.writeFileSync(beforeFile,parent.stdout);
 const args=['probe-aify.sh.in',native(f.target),...f.good];
 const before=spawnSync('bash',[native(beforeFile),...args],{env:f.env,encoding:'utf8'});assert.equal(before.status,0,before.stderr);const bytes=fs.readFileSync(f.target);
 const after=spawnSync('bash',[native(path.join(f.dir,'render.sh')),...args],{env:f.env,encoding:'utf8'});assert.equal(after.status,0,after.stderr);
 const current=fs.readFileSync(f.target);const text=current.toString('utf8');assert.equal((text.match(/^HARNESS_TEMPLATE_.*$/gm)||[]).length,3);
 assert.deepEqual(Buffer.from(text.replace(/^HARNESS_TEMPLATE_.*\n/gm,'')),bytes);
 const framed=f.render(f.good);assert.equal(framed.status,0,framed.stderr);assert.deepEqual(fs.readFileSync(f.target),current);
});
for(const key of ['','lower','BAD*KEY','BAD[KEY]','KEY-NAME'])test(`render refuses invalid key ${JSON.stringify(key)} without changing output or record`,t=>{
 const f=fixture(t),before=f.snapshot(),result=f.render([...f.good,`${key}=ordinary`]);
 assert.equal(result.status,78,result.stderr);assert.match(result.stderr,/key/i);assert.deepEqual(f.snapshot(),before);
});
for(const value of ['bad name','bad;name'])test(`direct render keeps service-name grammar for ${JSON.stringify(value)}`,t=>{
 const f=fixture(t),before=f.snapshot(),result=f.render([...f.good,`SERVICE_NAME=${value}`]);assert.equal(result.status,78,result.stderr);assert.match(result.stderr,/SERVICE_NAME/);assert.deepEqual(f.snapshot(),before);
});
test('a missing equals sign is refused with unchanged artifacts',t=>{
 const f=fixture(t),before=f.snapshot(),result=f.render([...f.good,'NO_EQUALS']);assert.equal(result.status,78);assert.deepEqual(f.snapshot(),before);
});
const badValues=[['double quote','bad"value'],['dollar','bad$value'],['backtick','bad`value'],['brace','bad}value'],['tab','bad\tvalue'],['newline','bad\nvalue'],['carriage return','bad\rvalue'],['DEL','bad'+String.fromCharCode(127)],['C1','bad'+String.fromCharCode(133)]];
for(const [name,value]of badValues)for(const key of ['ENDPOINT','UNUSED'])test(`render refuses ${name} in ${key} before any write`,t=>{
 const f=fixture(t),before=f.snapshot(),pairs=f.good.filter(pair=>!pair.startsWith(`${key}=`));pairs.push(`${key}=${value}`);
 const result=f.render(pairs);assert.equal(result.status,78,result.stderr);assert.match(result.stderr,new RegExp(key));assert.deepEqual(f.snapshot(),before);
});
test('a refused command substitution cannot execute even if its rendered assignment is checked',t=>{
 const f=fixture(t),before=f.snapshot(),marker=path.join(f.dir,'owned-marker');
 const value=`http://127.0.0.2:1/$(: > '${native(marker)}')`;
 const rendered=f.render([`ENDPOINT=${value}`,f.good[1]]);
 // Execute only the private synthetic assignment carrier; this contains no runtime, service or fleet command.
 spawnSync('bash',[native(f.target),'--check'],{env:f.env,encoding:'utf8',timeout:10000});
 assert.equal(fs.existsSync(marker),false,'rendered substitution executed in the owned --check carrier');
 assert.equal(rendered.status,78,rendered.stderr);assert.deepEqual(f.snapshot(),before);
});
// This is the production re-render function connect calls, with owned registry/record/output files.
for(const [name,value]of badValues)test(`connect re-render refuses recorded ${name} without changing either artifact`,t=>{
 const f=fixture(t),registry=path.join(f.dir,'services.json');fs.writeFileSync(registry,'{"version":1,"services":{}}');
 const record=path.join(f.records,fs.readdirSync(f.records)[0]);
 const fields=fs.readFileSync(record,'utf8').split('\0');const index=fields.findIndex(field=>field.startsWith('ENDPOINT='));assert.ok(index>=0);
 fields[index]=`ENDPOINT=${value}`;fs.writeFileSync(record,fields.join('\0'));
 const before=f.snapshot(),rows=rerenderLaunchers({dest:f.dir,registryPath:registry,wrapperRoot:f.dir,env:f.env});
 assert.equal(rows[0]?.state,'failed',JSON.stringify(rows));assert.match(rows[0].detail,/ENDPOINT/);assert.deepEqual(f.snapshot(),before);
});
const B=String.fromCharCode(92);
for(const value of [`C:${B}Users${B}A B${B}x`,`${B}${B}server${B}share${B}x`,`C:${B}dir${B}`])test(`real Hermes template preserves native Windows extra ${JSON.stringify(value)}`,t=>{
 const f=fixture(t),source=fs.readFileSync(path.join(ROOT,'wrappers/hermes-aify.sh.in'),'utf8');fs.writeFileSync(path.join(f.dir,'wrappers/hermes-aify.sh.in'),source);
 const tokens=[...new Set([...source.matchAll(/@@([A-Z0-9_]+)@@/g)].map(match=>match[1]))];
 const values={ENDPOINT:'http://127.0.0.2:1',WRAPPER_VERSION:'probe',SERVICE_NAME:'safe-service',WRAPPER_DIR:native(f.dir),BRIDGE_DIR:native(path.join(f.dir,'bridge')),HERMES_PLUGIN_PATH:value,HERMES_STDIO_DIR:value};
 const target=path.join(f.dir,'hermes-aify'),rendered=spawnSync('bash',[native(path.join(f.dir,'render.sh')),'hermes-aify.sh.in',native(target),...tokens.map(key=>`${key}=${values[key]??''}`)],{env:f.env,encoding:'utf8'});assert.equal(rendered.status,0,rendered.stderr);
 const syntax=spawnSync('bash',['-n',native(target)],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
 const text=fs.readFileSync(target,'utf8'),lines=['AIFY_HERMES_PLUGIN_PATH','AIFY_HERMES_STDIO_DIR'].map(key=>text.split('\n').find(line=>line.startsWith(key+'="')));assert.ok(lines.every(Boolean));
 const carrier=path.join(f.dir,'closed-assignments.sh');fs.writeFileSync(carrier,lines.join('\n')+`\nprintf '%s\\0%s\\0' "$AIFY_HERMES_PLUGIN_PATH" "$AIFY_HERMES_STDIO_DIR"\n`);
 const run=spawnSync('bash',[native(carrier)],{env:f.env,encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.deepEqual(run.stdout.split('\0'),[value,value,'']);
});
for(const [name,value]of [['drive with spaces',`C:${B}Users${B}A B${B}x`],['UNC',`${B}${B}server${B}share${B}x`],['trailing separator',`C:${B}dir${B}`],['ordinary punctuation',"C:/A B/a&b|c%'!你好"]])test(`supported ${name} round-trips in the actual quoted assignment context`,t=>{
 const f=fixture(t),rendered=f.render([f.good[0],`BRIDGE_DIR=${value}`]);assert.equal(rendered.status,0,rendered.stderr);
 const syntax=spawnSync('bash',['-n',native(f.target)],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
 const run=spawnSync('bash',[native(f.target)],{env:f.env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);
 assert.deepEqual(run.stdout.split('\0'),['http://127.0.0.2:1/p?a=1&b=2',value,'']);
 const fields=fs.readFileSync(path.join(f.records,fs.readdirSync(f.records)[0]),'utf8').split('\0');
 assert.ok(fields.includes(`BRIDGE_DIR=${value}`),'record must retain the raw pair, not its shell encoding');
});
