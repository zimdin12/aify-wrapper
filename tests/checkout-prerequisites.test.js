// Complements the npm black-box tests: gate modes, every peer role, Windows names, and real Git/worktree metadata.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {checkoutSource,SiblingCheckouts} from './sibling-checkouts.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
function owned(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'checkout-prerequisite-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),wrapper=path.join(root,'wrapper');fs.mkdirSync(home);fs.mkdirSync(wrapper);
 const env={...process.env,HOME:home,USERPROFILE:home};
 for(const key of Object.keys(env))if(/^AIFY_|^GIT_|^NODE_TEST_CONTEXT$/i.test(key))delete env[key];
 Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'gitconfig')});
 const write=(file,body='// owned reader input\n')=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
 return {root,home,wrapper,env,write};
}
function resolve(f,extra={},platform=process.platform){return new SiblingCheckouts({env:extra,wrapperRoot:f.wrapper,home:f.home,platform}).resolve();}
for(const {variable,file} of [
 {variable:'AIFY_ENV_REPO',file:'bin/aify-env-credential.mjs'},
 {variable:'AIFY_COMMS_REPO',file:'mcp/stdio/aify-service-endpoint.mjs'},
 {variable:'AIFY_DASHBOARD_REPO',file:'server/src/bridge/wsl-facts.ts'},
 {variable:'AIFY_ENV_SCHEMA_REPO',file:'lib/agent-definition-schema.mjs'},
])test(`${variable} refuses a root missing its actual reader, with healthy-source control`,t=>{
 const f=owned(t),peer=path.join(f.root,'peer');fs.mkdirSync(peer);
 if(variable==='AIFY_ENV_REPO')f.write(path.join(peer,'lib/agent-definition-schema.mjs'));
 assert.throws(()=>resolve(f,{[variable]:peer}),/NOT_RUN.*refusing fallback/);
 f.write(path.join(peer,file));const result=resolve(f,{[variable]:peer});
 assert.equal(result.env[variable],peer);assert.equal(result.checkouts.find(row=>row.variable===variable).root,peer);
});
test('Windows repo environment names canonicalize once without leaving duplicate spellings',t=>{
 const f=owned(t),peer=path.join(f.root,'env');f.write(path.join(peer,'bin/aify-env-credential.mjs'));f.write(path.join(peer,'lib/agent-definition-schema.mjs'));
 const good=resolve(f,{aify_env_repo:peer},'win32');assert.equal(good.env.AIFY_ENV_REPO,peer);assert.equal(Object.hasOwn(good.env,'aify_env_repo'),false);
});
test('conflicting Windows repo spellings refuse despite a healthy uppercase checkout',t=>{
 const f=owned(t),peer=path.join(f.root,'env');f.write(path.join(peer,'bin/aify-env-credential.mjs'));f.write(path.join(peer,'lib/agent-definition-schema.mjs'));
 assert.equal(resolve(f,{AIFY_ENV_REPO:peer},'win32').env.AIFY_ENV_REPO,peer);
 assert.throws(()=>resolve(f,{AIFY_ENV_REPO:peer,aify_env_repo:path.join(f.root,'other')},'win32'),/NOT_RUN: conflicting spellings/);
});
test('gate validation distinguishes healthy, optional NOT_RUN and required refusal without rediscovery',t=>{
 const f=owned(t),peer=path.join(f.root,'peer'),file='lib/owned-reader.mjs';f.write(path.join(peer,file));
 const args={variable:'AIFY_ENV_REPO',files:[file],env:{AIFY_ENV_REPO:peer}};
 assert.deepEqual(checkoutSource(args),{root:peer,skip:false});
 fs.unlinkSync(path.join(peer,file));assert.equal(checkoutSource(args).root,'');assert.match(checkoutSource(args).skip,/NOT_RUN/);
 assert.throws(()=>checkoutSource({...args,required:true}),/NOT_RUN/);
});
for(const kind of ['unset','missing'])test(`explicit real credential coverage with ${kind} source refuses, while fake-only control still writes`,t=>{
 const f=owned(t),cli=path.join(ROOT,'tests/fake-aify-env.mjs'),ref='owned-control.key';
 const run=extra=>spawnSync(process.execPath,[cli,'credential','set','--ref='+ref],{env:{...f.env,...extra},input:'owned-fixture-key',encoding:'utf8',timeout:10000});
 const key=path.join(f.home,'.aify/credentials',ref),extra=kind==='missing'?{AIFY_ENV_REPO:path.join(f.root,'missing')}:{};
 const rejected=run({...extra,AIFY_TEST_REAL_CREDENTIAL:'1'});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/NOT_RUN/);assert.equal(fs.existsSync(key),false);
 const control=run({...extra,AIFY_TEST_REAL_CREDENTIAL:'0'});assert.equal(control.status,0,control.stderr);assert.equal(fs.readFileSync(key,'utf8'),'owned-fixture-key');
});
function gitFixture(t){
 const f=owned(t),repo=path.join(f.root,'source');fs.mkdirSync(repo);
 const git=(cwd,...args)=>{const run=spawnSync('git',['-C',cwd,...args],{env:f.env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stderr);return run.stdout.trim();};
 git(repo,'init','-q');f.write(path.join(repo,'tracked'),'owned source\n');git(repo,'add','tracked');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','owned fixture');
 return {...f,repo,git,head:git(repo,'rev-parse','HEAD')};
}
test('an archive nested inside a Git checkout does not claim the enclosing checkout HEAD',t=>{
 const f=gitFixture(t),archive=path.join(f.repo,'archive');f.write(path.join(archive,'lib/agent-definition-schema.mjs'));
 const reader=new SiblingCheckouts({env:f.env,wrapperRoot:f.wrapper,home:f.home});
 assert.equal(reader.revision(f.repo),f.head,'positive control: actual repo HEAD is visible');assert.equal(reader.revision(archive),null);
 f.write(path.join(f.repo,'lib/agent-definition-schema.mjs'));
 const result=new SiblingCheckouts({env:{...f.env,AIFY_ENV_SCHEMA_REPO:f.repo},wrapperRoot:f.wrapper,home:f.home}).resolve();
 assert.equal(result.checkouts.find(row=>row.variable==='AIFY_ENV_SCHEMA_REPO').revision,f.head,'resolved diagnostics lost the actual source revision');
});
test('a linked worktree reports its own HEAD rather than unavailable revision',t=>{
 const f=gitFixture(t),linked=path.join(f.root,'linked');f.git(f.repo,'worktree','add','--detach',linked,'HEAD');
 const reader=new SiblingCheckouts({env:f.env,wrapperRoot:f.wrapper,home:f.home});assert.equal(reader.revision(linked),f.head);assert.equal(reader.revision(path.join(f.root,'missing')),null);
});
