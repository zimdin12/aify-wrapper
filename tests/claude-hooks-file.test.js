// Hook-settings file location only. resident-start-wrapper.test.js covers what the hooks contain.
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {readerWrapper,definitionsEnv} from './definition-reader-wrapper.mjs';
import {renderWorld} from './launch-to-a-stub-runtime.mjs';
import {sealedPath} from './sealed-path.mjs';
import {ownerEnv} from './private-credential.mjs';
import {sessionFolder,writeSessionFile} from '../lib/session-folder.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),ID='hooks-agent',LIVE='live named hooks';
const fwd=value=>value.replaceAll('\\','/');

class HooksFixture {
  constructor(t){
    this.root=fs.mkdtempSync(path.join(os.tmpdir(),'aify-claude-hooks-'));
    this.home=path.join(this.root,'home');this.temp=path.join(this.root,'tmp');this.wrapper=path.join(this.root,'wrapper');
    this.out=path.join(this.root,'out');this.stubs=path.join(this.root,'stubs');this.seal=sealedPath([]);
    for(const dir of [this.home,this.temp,this.out,this.stubs,path.join(this.root,'bridge')])fs.mkdirSync(dir,{recursive:true});
    t.after(()=>{fs.rmSync(this.root,{recursive:true,force:true});fs.rmSync(this.seal.dir,{recursive:true,force:true});});
    readerWrapper(this.wrapper);
    fs.copyFileSync(path.join(ROOT,'bin/aify-lease.sh'),path.join(this.wrapper,'bin/aify-lease.sh'));
    // Real claim/release and filesystem record. Identity is an owned model; no watch, no OS process query.
    fs.writeFileSync(path.join(this.wrapper,'bin/aify-agent-lease.mjs'),`import {runLease} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'bin/aify-agent-lease.mjs')).href)};
import {AgentLease} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'lib/agent-lease.mjs')).href)};
const dead=new Set(),valid=pid=>Number.isInteger(pid)&&pid>0;
const probe={liveness:pid=>!valid(pid)?'unknown':dead.has(pid)?'gone':'alive',isAlive:pid=>valid(pid)&&!dead.has(pid),
 startTimes:pids=>new Map(pids.filter(pid=>valid(pid)&&!dead.has(pid)).map(pid=>[pid,1000])),processTable:()=>new Map(),
 anchorOffsetMs:()=>0,killTree:pid=>{dead.add(pid);}};
if(process.argv[2]!=='attach')process.exitCode=runLease(process.argv.slice(2),{env:process.env,
 lease:options=>new AgentLease({...options,probe}),watch:()=>{}});
`);
    const node=JSON.stringify(fwd(process.execPath));
    const record=`const fs=require('fs'),path=require('path');const at=process.argv.indexOf('--settings');`
      +`fs.writeFileSync(path.join(process.env.HOME,'runtime.json'),JSON.stringify({settings:at<0?null:process.argv[at+1],`
      +`temps:fs.readdirSync(process.env.HOOK_TEST_TEMP).filter(name=>name.startsWith('aify-hooks')).length}));`;
    fs.writeFileSync(path.join(this.stubs,'claude'),`#!/bin/bash
${node} -e ${JSON.stringify(record)} -- "$@"
if [ "\${HOOK_TEST_KILL:-0}" = 1 ]; then kill -9 "$PPID"; fi
exit 0
`,{mode:0o755});
    fs.writeFileSync(path.join(this.stubs,'aify-env'),'#!/bin/bash\nprintf handed > "$HOME/host-started"\nexit 0\n',{mode:0o755});
    fs.writeFileSync(path.join(this.root,'bridge/agent-for-handle.mjs'),'');
    fs.writeFileSync(path.join(this.root,'services.json'),'');
    this.defs=definitionsEnv(path.join(this.root,'defs'));
    renderWorld('claude',this.root,this.out);
  }
  run({args=['--aify-agent',ID],env={},kill=false}={}){
    fs.rmSync(path.join(this.home,'runtime.json'),{force:true});
    const result=spawnSync('bash',[path.join(this.out,'claude-aify'),...args],{encoding:'utf8',timeout:25000,env:{
      PATH:[this.stubs,this.seal.PATH].join(path.delimiter),HOME:this.home,USERPROFILE:this.home,
      TMPDIR:this.temp,TEMP:this.temp,TMP:this.temp,...ownerEnv(),...this.defs,HOOK_TEST_KILL:kill?'1':'0',HOOK_TEST_TEMP:this.temp,...env,
    }});
    assert.equal(result.error,undefined,result.error?.message);
    const file=path.join(this.home,'runtime.json');
    return {...result,runtime:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null};
  }
  named(){return path.join(this.home,'.aify/sessions',ID,'hooks.json');}
  async seed(){
    const folder=await sessionFolder({agentId:ID,home:this.home});assert.equal(folder.ok,true,folder.problem);
    await writeSessionFile(folder.dir,'hooks.json',LIVE);
  }
  usedTemp(run){assert.ok(run.runtime,'runtime must record: '+run.stderr);return path.dirname(path.resolve(run.runtime.settings))===path.resolve(this.temp);}
}

test('a named holder gets its settings from the session folder and leaves no temp file',t=>{
 const f=new HooksFixture(t);const run=f.run();assert.equal(run.status,0,run.stderr);
 assert.ok(run.runtime,'runtime must record: '+run.stdout+run.stderr);
 assert.equal(path.resolve(run.runtime.settings),path.resolve(f.named()),'--settings must be the session-folder file');
 assert.ok(JSON.parse(fs.readFileSync(f.named(),'utf8')).hooks.SessionStart,'the named file holds the assembled hooks');
 assert.equal(run.runtime.temps,0,'no aify-hooks temp exists while the runtime runs');
});

// Hermes' tool shell exports MSYS_NO_PATHCONV=1, so node receives the shell's own /c/... temp path unconverted.
test('a named holder launched without MSYS path conversion still gets the session file',
 {skip:process.platform!=='win32'&&'MSYS path conversion exists only under Git Bash'},t=>{
 const f=new HooksFixture(t);
 const posixTemp=execFileSync('bash',['-c','cygpath -u "$1"','_',f.temp],{encoding:'utf8'}).trim();
 assert.match(posixTemp,/^\//,'control: the shell-form temp path is not a Windows path');
 const run=f.run({env:{TMPDIR:posixTemp,MSYS_NO_PATHCONV:'1'}});assert.equal(run.status,0,run.stderr);
 assert.ok(run.runtime,'runtime must record: '+run.stderr);
 assert.equal(path.resolve(run.runtime.settings),path.resolve(f.named()),'--settings must be the session-folder file: '+run.stderr);
 assert.equal(run.runtime.temps,0);
});

test('three named launches, one killed without its trap, leave exactly one hooks.json',t=>{
 const f=new HooksFixture(t);
 for(const kill of [false,false,true]){
  const run=f.run({kill});if(!kill)assert.equal(run.status,0,run.stderr);
  assert.equal(path.resolve(run.runtime.settings),path.resolve(f.named()));assert.equal(run.runtime.temps,0);
 }
 assert.deepEqual(fs.readdirSync(path.dirname(f.named())),['hooks.json']);
 assert.deepEqual(fs.readdirSync(f.temp).filter(name=>name.startsWith('aify-hooks')),[],'a killed launch leaks no temp');
});

test('a status75 duplicate leaves the named hooks file untouched',async t=>{
 const f=new HooksFixture(t);await f.seed();
 fs.writeFileSync(path.join(f.wrapper,'bin/aify-agent-lease.mjs'),"process.stderr.write('OWNED_REFUSAL\\n');process.exit(75);");
 const run=f.run();assert.equal(run.status,75,run.stderr);assert.match(run.stderr,/^OWNED_REFUSAL$/m);
 assert.equal(run.runtime,null,'no runtime started');assert.equal(fs.readFileSync(f.named(),'utf8'),LIVE);
});

test('a --shared preliminary leaves the named hooks file untouched',async t=>{
 const f=new HooksFixture(t);await f.seed();
 const run=f.run({args:['--aify-agent',ID,'--shared'],env:{AIFY_LEASE_AGENT:ID}});assert.equal(run.status,0,run.stderr);
 assert.equal(fs.readFileSync(path.join(f.home,'host-started'),'utf8'),'handed');assert.equal(fs.readFileSync(f.named(),'utf8'),LIVE);
});

test('unclaimed launches with an inherited marker keep the temp file and the named file',async t=>{
 for(const fault of ['missing-shell','exit1']){
  const f=new HooksFixture(t);await f.seed();
  if(fault==='missing-shell')fs.unlinkSync(path.join(f.wrapper,'bin/aify-lease.sh'));
  else fs.writeFileSync(path.join(f.wrapper,'bin/aify-agent-lease.mjs'),"process.stderr.write('OWNED_FAILURE\\n');process.exit(1);");
  const run=f.run({env:{AIFY_LEASE_AGENT:ID}});assert.equal(run.status,0,fault+': '+run.stderr);
  if(fault==='exit1')assert.match(run.stderr,/^OWNED_FAILURE$/m);
  assert.ok(f.usedTemp(run),fault+': unclaimed launch keeps today\'s temp file');
  assert.equal(fs.readFileSync(f.named(),'utf8'),LIVE,fault+': named file untouched');
 }
});

test('a named-file write failure falls back to the temp file once and still starts',t=>{
 const f=new HooksFixture(t);const root=path.join(f.home,'.aify/sessions');fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,ID),'owned obstruction');
 const run=f.run();assert.equal(run.status,0,run.stderr);assert.ok(f.usedTemp(run),'falls back to the temp file');
 assert.equal(run.stderr.split('\n').filter(line=>line.includes('named hook settings unavailable; using a temp file')).length,1);
 assert.equal(fs.readFileSync(path.join(root,ID),'utf8'),'owned obstruction');
});
