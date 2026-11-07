// The real npm frontend discovers peers before sealing HOME; a bad explicit root cannot select another checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {npmCliBeside} from '../lib/package-install.mjs';

const ROOT=path.resolve(import.meta.dirname,'..'),NPM=npmCliBeside(process.execPath);
// Independent fixtures name real reader inputs, not a list imported from the implementation under test.
const INPUTS={env:['lib/agent-definition-schema.mjs','bin/aify-env-credential.mjs'],comms:['mcp/stdio/aify-service-endpoint.mjs'],schema:['lib/agent-definition-schema.mjs']};
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'sibling-checkouts-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'layout','wrapper'),home=path.join(base,'original-home');
 fs.mkdirSync(path.join(root,'tests'),{recursive:true});fs.mkdirSync(path.join(root,'lib'));fs.mkdirSync(home);
 for(const file of ['tests/run-in-a-temp-root.mjs','tests/sibling-checkouts.mjs','lib/inherited-session.mjs']){
  if(fs.existsSync(path.join(ROOT,file)))fs.copyFileSync(path.join(ROOT,file),path.join(root,file));
 }
 fs.copyFileSync(path.join(ROOT,'package.json'),path.join(root,'package.json'));
 const output=path.join(base,'observed.json');
 fs.writeFileSync(path.join(root,'tests/probe.test.js'),[
  "import fs from 'node:fs';import os from 'node:os';import {test} from 'node:test';",
  "test('owned observation',()=>fs.writeFileSync(process.env.CHECKOUT_PROBE_OUT,JSON.stringify({env:process.env.AIFY_ENV_REPO??null,comms:process.env.AIFY_COMMS_REPO??null,schema:process.env.AIFY_ENV_SCHEMA_REPO??null,secretPresent:Boolean(process.env.AIFY_API_KEY),home:os.homedir(),temp:os.tmpdir()})));",
 ].join('\n'));
 const peer=(kind,where)=>{
  for(const file of INPUTS[kind]){const target=path.join(where,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'// owned source-path fixture\n');}
  return where;
 };
 const run=(extra={})=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^AIFY_|^NODE_TEST_CONTEXT$|^npm_/i.test(key)));
  Object.assign(env,{HOME:home,USERPROFILE:home,CHECKOUT_PROBE_OUT:output,NPM_CONFIG_CACHE:path.join(base,'npm-cache'),NPM_CONFIG_USERCONFIG:path.join(base,'npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(base,'npm-globalrc'),NPM_CONFIG_UPDATE_NOTIFIER:'false',...extra});
  const child=spawnSync(process.execPath,[NPM,'test','--','tests/probe.test.js'],{cwd:root,env,encoding:'utf8',timeout:25000});
  return {...child,text:(child.stdout??'')+(child.stderr??''),observed:fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):null};
 };
 return {base,root,home,output,peer,run};
}
const announced=run=>{
 const line=run.text.split('\n').find(line=>line.startsWith('AIFY_TEST_CHECKOUTS '));
 assert.ok(line,`runner omitted checkout diagnostics: ${run.text}`);
 return JSON.parse(line.slice('AIFY_TEST_CHECKOUTS '.length));
};
const success=run=>{assert.equal(run.status,0,run.text);assert.ok(run.observed,'probe never ran');return announced(run);};
const refusal=run=>{assert.notEqual(run.status,0,run.text);assert.equal(run.observed,null,'test child ran after prerequisite refusal');assert.match(run.text,/NOT_RUN/);};

test('explicit env wins over healthy adjacent and original-home peers',t=>{
 const f=fixture(t),explicit=f.peer('env',path.join(f.base,'chosen & owned'));
 f.peer('env',path.join(f.root,'..','aify-env'));f.peer('env',path.join(f.home,'projects','aify-env'));
 const run=f.run({AIFY_ENV_REPO:explicit});const rows=success(run);
 assert.equal(run.observed.env,explicit);
 const row=rows.find(row=>row.variable==='AIFY_ENV_REPO');assert.equal(row.source,'explicit');assert.equal(row.root,explicit);assert.equal(Object.hasOwn(row,'revision'),true);
});
for(const [label,value] of [['missing','missing'],['empty',''],['not a directory','file'],['directory without reader inputs','empty-dir']])test(`explicit ${label} refuses despite healthy fallback`,t=>{
 const f=fixture(t);f.peer('env',path.join(f.root,'..','aify-env'));f.peer('env',path.join(f.home,'projects','aify-env'));
 const target=value===''?'':path.join(f.base,value);
 if(value==='file')fs.writeFileSync(target,'not a directory');
 if(value==='empty-dir')fs.mkdirSync(target);
 refusal(f.run({AIFY_ENV_REPO:target}));
});
test('adjacent env wins over original-home projects without explicit env',t=>{
 const f=fixture(t),adjacent=f.peer('env',path.join(f.root,'..','aify-env'));
 f.peer('env',path.join(f.home,'projects','aify-env'));
 const run=f.run();success(run);assert.equal(run.observed.env,path.resolve(adjacent));
});
test('original-home fallback is captured before the child receives its sealed home',t=>{
 const f=fixture(t),original=f.peer('env',path.join(f.home,'projects','aify-env'));
 const run=f.run();success(run);assert.equal(run.observed.env,original);assert.notEqual(run.observed.home,f.home);
 assert.ok(path.relative(run.observed.temp,run.observed.home).startsWith('home'));
});
test('unrelated selected work runs without a blanket requirement for every peer',t=>{
 const f=fixture(t),run=f.run();const rows=success(run);
 assert.equal(run.observed.env,null);assert.equal(run.observed.comms,null);
 assert.equal(rows.find(row=>row.variable==='AIFY_COMMS_REPO').source,'unavailable');
});
for(const value of ['','missing-schema'])test(`explicit schema override ${value||'empty'} refuses without falling back to healthy env`,t=>{
 const f=fixture(t),env=f.peer('env',path.join(f.base,'env'));
 refusal(f.run({AIFY_ENV_REPO:env,AIFY_ENV_SCHEMA_REPO:value?path.join(f.base,value):value}));
});
test('separate schema source survives while live env selection remains unchanged',t=>{
 const f=fixture(t),env=f.peer('env',path.join(f.base,'env')),schema=f.peer('schema',path.join(f.base,'archive'));
 const run=f.run({AIFY_ENV_REPO:env,AIFY_ENV_SCHEMA_REPO:schema});success(run);
 assert.equal(run.observed.env,env);assert.equal(run.observed.schema,schema);
});
test('the unchanged real comms parity gate still refuses while unrelated selected work can run',t=>{
 const f=fixture(t);success(f.run());
 fs.cpSync(path.join(ROOT,'lib'),path.join(f.root,'lib'),{recursive:true});
 fs.copyFileSync(path.join(ROOT,'tests/private-credential.mjs'),path.join(f.root,'tests/private-credential.mjs'));
 fs.copyFileSync(path.join(ROOT,'tests/the-session-key-is-resolved-as-comms-resolves-it.test.js'),path.join(f.root,'tests/probe.test.js'));
 fs.unlinkSync(f.output);
 const run=f.run();assert.notEqual(run.status,0,run.text);assert.equal(run.observed,null);
 assert.match(run.text,/AIFY_COMMS_REPO must name an aify-comms checkout: this test holds the wrapper's key rule to comms' resolver/);
});
test('diagnostics do not expose an unrelated credential variable',t=>{
 const f=fixture(t),run=f.run({AIFY_API_KEY:'DO-NOT-PRINT-OWNED-SECRET-CONTROL'});success(run);
 assert.equal(run.observed.secretPresent,true,'positive control: the credential variable never reached the child');
 assert.doesNotMatch(run.text,/DO-NOT-PRINT-OWNED-SECRET-CONTROL/);
});
