// Log-write scope only. Existing #14 tests cover auth/readiness; these cover named retention and untouched fallbacks.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
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
const ROOT=path.resolve(import.meta.dirname,'..'),ID='log-agent';
const fwd=value=>value.replaceAll('\\','/');

class LogFixture {
  constructor(t){
    this.root=fs.mkdtempSync(path.join(os.tmpdir(),'aify-codex-log-'));
    this.home=path.join(this.root,'home');this.wrapper=path.join(this.root,'wrapper');
    this.out=path.join(this.root,'out');this.stubs=path.join(this.root,'stubs');this.seal=sealedPath([]);
    for(const dir of [this.home,this.out,this.stubs,path.join(this.root,'bridge')])fs.mkdirSync(dir,{recursive:true});
    t.after(()=>{fs.rmSync(this.root,{recursive:true,force:true});fs.rmSync(this.seal.dir,{recursive:true,force:true});});
    readerWrapper(this.wrapper);
    fs.copyFileSync(path.join(ROOT,'bin/aify-lease.sh'),path.join(this.wrapper,'bin/aify-lease.sh'));
    // Real claim/release and filesystem record. Identity is an owned model, watch is disabled, unrelated attachment is stubbed.
    const lease=`import {runLease} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'bin/aify-agent-lease.mjs')).href)};
import {AgentLease} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'lib/agent-lease.mjs')).href)};
const dead=new Set(),valid=pid=>Number.isInteger(pid)&&pid>0;
const probe={liveness:pid=>!valid(pid)?'unknown':dead.has(pid)?'gone':'alive',isAlive:pid=>valid(pid)&&!dead.has(pid),
 startTimes:pids=>new Map(pids.filter(pid=>valid(pid)&&!dead.has(pid)).map(pid=>[pid,1000])),processTable:()=>new Map(),
 anchorOffsetMs:()=>0,killTree:pid=>{dead.add(pid);}};
if(process.argv[2]!=='attach')process.exitCode=runLease(process.argv.slice(2),{env:process.env,
 lease:options=>new AgentLease({...options,probe}),watch:()=>{}});
`;
    fs.writeFileSync(path.join(this.wrapper,'bin/aify-agent-lease.mjs'),lease);
    const node=JSON.stringify(fwd(process.execPath));
    const listener=`const net=require('net');const server=net.createServer(s=>{s.on('error',()=>{});s.end();});server.listen(Number(process.argv[1].split(':').pop()),'127.0.0.1');setTimeout(()=>server.close(()=>process.exit(0)),15000).unref();`;
    fs.writeFileSync(path.join(this.stubs,'codex'),`#!/bin/bash
for arg in "$@"; do
 if [ "$arg" = app-server ]; then
  printf '%s\\n' "$LOG_TEST_TEXT"
  if [ "\${LOG_TEST_FAIL:-0}" = 1 ]; then exit 63; fi
  url=""; previous="";for word in "$@";do [ "$previous" = --listen ] && url="$word";previous="$word";done
  exec ${node} -e ${JSON.stringify(listener)} "$url"
 fi
done
printf started > "$HOME/tui-started"
exit 0
`,{mode:0o755});
    fs.writeFileSync(path.join(this.stubs,'setsid'),'#!/bin/bash\nexec "$@"\n',{mode:0o755});
    fs.writeFileSync(path.join(this.stubs,'aify-env'),'#!/bin/bash\nprintf handed > "$HOME/host-started"\nexit 0\n',{mode:0o755});
    fs.writeFileSync(path.join(this.root,'services.json'),'');
    this.defs=definitionsEnv(path.join(this.root,'defs'));
    renderWorld('codex',this.root,this.out);
  }
  run({args=['--aify-agent',ID],env={},text='owned log',fail=false}={}){
    fs.rmSync(path.join(this.home,'tui-started'),{force:true});
    const result=spawnSync('bash',[path.join(this.out,'codex-aify'),...args],{encoding:'utf8',timeout:25000,env:{
      PATH:[this.stubs,this.seal.PATH].join(path.delimiter),HOME:this.home,USERPROFILE:this.home,
      TMPDIR:this.root,TEMP:this.root,TMP:this.root,XDG_STATE_HOME:path.join(this.root,'state'),
      ...ownerEnv(),...this.defs,LOG_TEST_TEXT:text,LOG_TEST_FAIL:fail?'1':'0',...env,
    }});
    assert.equal(result.error,undefined,result.error?.message);
    return result;
  }
  named(){return path.join(this.home,'.aify/sessions',ID,'codex-app-server.log');}
  async seed(){
    const folder=await sessionFolder({agentId:ID,home:this.home});assert.equal(folder.ok,true,folder.problem);
    await writeSessionFile(folder.dir,'codex-app-server.log','live current');
    await writeSessionFile(folder.dir,'codex-app-server.log.1','live previous');
  }
  legacy(){const dir=path.join(this.root,'state/aify-comms');return fs.existsSync(dir)?fs.readdirSync(dir).map(name=>path.join(dir,name)):[];}
}

test('ten named holders leave only current and previous app-server logs',t=>{
 const f=new LogFixture(t);
 for(let launch=1;launch<=10;launch++){
  const run=f.run({text:'launch-'+launch});assert.equal(run.status,0,run.stderr);
  assert.ok(fs.existsSync(f.named()),'a named holder must publish its app-server log in its session folder');
  assert.equal(fs.readFileSync(f.named(),'utf8'),'launch-'+launch+'\n','current log is this actual server output');
  if(launch>1)assert.equal(fs.readFileSync(f.named()+'.1','utf8'),'launch-'+(launch-1)+'\n');
 }
 assert.deepEqual(fs.readdirSync(path.dirname(f.named())).sort(),['codex-app-server.log','codex-app-server.log.1']);
 assert.deepEqual(f.legacy(),[],'a named holder does not create service-owned port logs');
});

test('a status75 refusal leaves the named log pair untouched',async t=>{
 const f=new LogFixture(t);await f.seed();
 fs.writeFileSync(path.join(f.wrapper,'bin/aify-agent-lease.mjs'),"process.stderr.write('OWNED_REFUSAL\\n');process.exit(75);");
 const run=f.run();assert.equal(run.status,75,run.stderr);assert.match(run.stderr,/^OWNED_REFUSAL$/m);
 assert.equal(fs.readFileSync(f.named(),'utf8'),'live current');assert.equal(fs.readFileSync(f.named()+'.1','utf8'),'live previous');
 assert.equal(fs.existsSync(path.join(f.home,'tui-started')),false);
});

test('shared preliminary uses its port log without rotating named logs',async t=>{
 const f=new LogFixture(t);await f.seed();
 // Preliminary shared starts never claim. An inherited marker must not grant their log write permission.
 fs.unlinkSync(path.join(f.wrapper,'bin/aify-lease.sh'));
 const run=f.run({args:['--aify-agent',ID,'--shared'],env:{AIFY_LEASE_AGENT:ID}});assert.equal(run.status,0,run.stderr);
 assert.equal(fs.readFileSync(f.named(),'utf8'),'live current');assert.equal(fs.readFileSync(f.named()+'.1','utf8'),'live previous');
 assert.equal(fs.readFileSync(path.join(f.home,'host-started'),'utf8'),'handed');assert.equal(f.legacy().length,1);
});

for(const fault of ['missing-shell','exit1'])test('unclaimed '+fault+' ignores an inherited owner marker',async t=>{
 const f=new LogFixture(t);await f.seed();
 if(fault==='missing-shell')fs.unlinkSync(path.join(f.wrapper,'bin/aify-lease.sh'));
 else fs.writeFileSync(path.join(f.wrapper,'bin/aify-agent-lease.mjs'),"process.stderr.write('OWNED_FAILURE\\n');process.exit(1);");
 const run=f.run({env:{AIFY_LEASE_AGENT:ID,AIFY_AGENT_LEASE:'999999'}});assert.equal(run.status,0,run.stderr);
 if(fault==='exit1')assert.match(run.stderr,/^OWNED_FAILURE$/m);
 assert.equal(fs.readFileSync(f.named(),'utf8'),'live current');assert.equal(fs.readFileSync(f.named()+'.1','utf8'),'live previous');
 assert.equal(f.legacy().length,1);assert.equal(fs.readFileSync(f.legacy()[0],'utf8'),'owned log\n');
});

test('named-log preparation failure falls back once and still starts Codex',t=>{
 const f=new LogFixture(t);const root=path.join(f.home,'.aify/sessions');fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,ID),'owned obstruction');
 const run=f.run();assert.equal(run.status,0,run.stderr);assert.equal(fs.readFileSync(path.join(f.home,'tui-started'),'utf8'),'started');
 assert.equal(run.stderr.split('\n').filter(line=>line.includes('named app-server log unavailable; using per-port log')).length,1);
 assert.equal(f.legacy().length,1);assert.equal(fs.readFileSync(f.legacy()[0],'utf8'),'owned log\n');
 assert.equal(fs.readFileSync(path.join(root,ID),'utf8'),'owned obstruction');
});

test('app-server failure diagnostic names its actual named log',t=>{
 const f=new LogFixture(t);const run=f.run({fail:true,text:'owned startup failure'});assert.equal(run.status,1,run.stderr);
 assert.ok(run.stderr.includes(f.named()),'diagnostic must name the actual log: '+run.stderr);
 assert.equal(fs.readFileSync(f.named(),'utf8'),'owned startup failure\n');
 assert.equal(fs.existsSync(path.join(f.home,'tui-started')),false);
});
