// Publisher integration, not another FileLock implementation test: policy, legacy records, fencing and outcomes.
// Primitive takeover races/deadlines already belong to a-lock-is-freed-only-on-positive-evidence.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {liveness} from '../lib/process-identity.mjs';
import {once} from 'node:events';
import {COMMITTED, NOT_COMMITTED, publish, snapshot} from '../lib/registry-publish.mjs';
const PID=4017,OLD='{"version":1,"services":{}}\n',NEW='{"next":true}\n';
function fixture(t,{state='unknown',startedAt=null,legacy=false,raw,own=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'registry-lock-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'services.json'),lock=file+'.lock',atMs=Date.now()-60000,pid=own?process.pid:PID;
 fs.writeFileSync(file,OLD);const holder=raw??JSON.stringify(legacy?{pid,at:new Date(atMs).toISOString(),nonce:'legacy'}:{pid,atMs,nonce:'holder'});
 fs.writeFileSync(lock,holder);fs.utimesSync(lock,new Date(atMs),new Date(atMs));
 const before=snapshot(file),calls=[];
 const probe={liveness:given=>{calls.push(['liveness',given]);assert.equal(given,pid);if(own){process.kill(given,0);return'alive';}return state;},
  startTimes:(pids,options)=>{calls.push(['startTimes',pids,options]);return startedAt===null?null:new Map([[pid,startedAt]]);},anchorOffsetMs:()=>0};
 const write=options=>publish(file,NEW,before.hash,{waitMs:0,probe,...options});
 return{dir,file,lock,atMs,pid,holder,before,calls,probe,write};
}
for(const [name,state,reused]of [['dead','gone',false],['reused','alive',true]])for(const legacy of [false,true])test(`${legacy?'legacy ISO-at':'FileLock atMs'}: ${name} holder permits publication from positive evidence`,async t=>{
 const f=fixture(t,{state,legacy,startedAt:reused?Date.now()+60000:null});let result;
 await assert.doesNotReject(async()=>{result=await f.write();},'positive evidence must permit the registry publication');
 assert.equal(result.result,COMMITTED,result.detail);assert.equal(fs.readFileSync(f.file,'utf8'),NEW);assert.equal(fs.existsSync(f.lock),false);
 assert.deepEqual(f.calls[0],['liveness',PID]);if(reused)assert.equal(f.calls.filter(row=>row[0]==='startTimes').length,1);
});
// Producer reachability: the exact pre-migration publisher leaves its own real legacy token on an abrupt owned exit.
// Injected state cases above prove policy, not that the old writer actually produces this shape.
test('an abruptly exited owned legacy writer is recovered through actual wrapper liveness',async t=>{
 const f=fixture(t);fs.unlinkSync(f.lock);const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const legacy=path.join(f.dir,'legacy-publisher.mjs');fs.writeFileSync(legacy,execFileSync('git',['-C',root,'show','dacd4a1cb6a98797fb23eebc8a59c788c97b50bd:lib/registry-publish.mjs']));
 const writer=path.join(f.dir,'owned-writer.mjs');fs.writeFileSync(writer,`import {acquireLock} from ${JSON.stringify(pathToFileURL(legacy).href)};await acquireLock(process.argv[2]);process.exit(23);`);
 const child=spawnSync(process.execPath,[writer,f.file],{encoding:'utf8',timeout:10000});assert.equal(child.status,23,child.stderr);
 const recorded=JSON.parse(fs.readFileSync(f.lock,'utf8'));assert.deepEqual(Object.keys(recorded),['pid','at','nonce']);assert.equal(recorded.pid,child.pid);
 assert.equal(liveness(process.pid),'alive','same native probe positive control');assert.equal(liveness(0),'unknown','same native probe invalid-input control');assert.equal(liveness(child.pid),'gone','the owned writer must actually have exited');
 const observed=[];let result;await assert.doesNotReject(async()=>{result=await publish(f.file,NEW,f.before.hash,{waitMs:0,probe:{liveness:pid=>{observed.push(pid);return liveness(pid);},startTimes:()=>null,anchorOffsetMs:()=>0}});},'the exited legacy writer must not block publication');
 assert.equal(result.result,COMMITTED,result.detail);assert.deepEqual(observed,[child.pid]);assert.equal(fs.readFileSync(f.file,'utf8'),NEW);assert.equal(fs.existsSync(f.lock),false);
});

for(const legacy of [false,true])test(`${legacy?'legacy ISO-at':'FileLock atMs'}: verified live self keeps its lock and registry unchanged`,async t=>{
 const f=fixture(t,{own:true,legacy});await assert.rejects(f.write(),/held by/);
 assert.deepEqual(f.calls[0],['liveness',process.pid],'the live holder must actually be observed');
 assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),f.holder);
});
for(const [name,state,startedAt]of [['unknown PID','unknown',null],['failed start probe','alive',null],['empty start answer','alive',undefined]])test(`${name} never authorizes takeover or publication`,async t=>{
 const f=fixture(t,{state,startedAt});if(name==='empty start answer')f.probe.startTimes=()=>new Map();
 await assert.rejects(f.write(),/held by/);assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),f.holder);
 assert.deepEqual(f.calls[0],['liveness',PID]);
});
for(const raw of ['', '{"pid":', '{"who":"unreadable holder"}'])test(`partial/unreadable old lock ${JSON.stringify(raw)} is not age-taken`,async t=>{
 const f=fixture(t,{raw});await assert.rejects(f.write(),/held by.*(?:unreadable|holder|\{)|held by /s);
 assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),raw);assert.deepEqual(f.calls,[]);
});
test('an unreadable lock file is kept and gives a manual-repair diagnostic',async t=>{
 const f=fixture(t),io={...fs,readFileSync:(file,...args)=>{if(file===f.lock)throw Object.assign(new Error('owned EACCES'),{code:'EACCES'});return fs.readFileSync(file,...args);}};
 await assert.rejects(f.write({io}),/held by unreadable.*(?:manual|[Rr]emove|[Rr]epair)/s);
 assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),f.holder);
});
test('equal millisecond holder/start evidence stays held; only a later observed start is reused',async t=>{
 const f=fixture(t,{state:'alive'});f.probe.startTimes=()=>new Map([[PID,f.atMs]]);
 await assert.rejects(f.write(),/held by/);assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),f.holder);
});
test('ownership lost after staging fences rename, removes only its temp, and preserves the new lock',async t=>{
 const f=fixture(t);fs.unlinkSync(f.lock);const other='{"pid":4018,"atMs":1,"nonce":"replacement"}',keep=path.join(f.dir,'unrelated.tmp');fs.writeFileSync(keep,'keep');
 let staged=false,renamed=false;const io={...fs,writeFileSync:(file,...args)=>{fs.writeFileSync(file,...args);if(String(file).startsWith(f.file+'.connect-')){staged=true;fs.writeFileSync(f.lock,other);}},renameSync:(from,to)=>{if(to===f.file)renamed=true;return fs.renameSync(from,to);}};
 const result=await f.write({io});assert.equal(staged,true);assert.equal(result.result,NOT_COMMITTED,result.detail);assert.match(result.detail,/lock|ownership|held/i);assert.equal(renamed,false);
 assert.equal(fs.existsSync(f.file),true,'fenced publication deleted the registry');assert.deepEqual(fs.readFileSync(f.file),f.before.bytes);assert.equal(fs.readFileSync(f.lock,'utf8'),other);assert.equal(fs.readFileSync(keep,'utf8'),'keep');
 assert.deepEqual(fs.readdirSync(f.dir).filter(name=>name.includes('.connect-')),[]);
});
// New default-wait property: zero-wait refusal cases cannot prove the public default waits for a cooperating release.
test('default wait permits an owned cooperating holder to release before publication',async t=>{
 const f=fixture(t),helper=path.join(f.dir,'owned-release.mjs'),go=path.join(f.dir,'go');
 fs.writeFileSync(helper,`import fs from 'node:fs';process.stdout.write('ready');const watch=setInterval(()=>{if(!fs.existsSync(process.argv[4]))return;clearInterval(watch);setTimeout(()=>{try{if(fs.readFileSync(process.argv[2],'utf8')===process.argv[3])fs.unlinkSync(process.argv[2]);}catch{}},150);},10);setTimeout(()=>process.exit(91),4000).unref();`);
 const observed=f.probe.liveness;f.probe.liveness=pid=>{fs.writeFileSync(go,'go');return observed(pid);};
 const child=spawn(process.execPath,[helper,f.lock,f.holder,go],{stdio:['ignore','pipe','pipe']});const ended=once(child,'close');
 const [ready]=await Promise.race([once(child.stdout,'data'),ended.then(()=>{throw new Error('owned releaser exited before ready');})]);assert.equal(String(ready),'ready');
 let result;try{result=await publish(f.file,NEW,f.before.hash,{probe:f.probe});}catch(error){assert.fail(`default wait refused the cooperating holder: ${error.message}`);}finally{const [code]=await ended;assert.equal(code,0,'owned releaser must finish cleanly');}
 assert.equal(result.result,COMMITTED,result.detail);assert.equal(fs.readFileSync(f.file,'utf8'),NEW);assert.equal(fs.existsSync(f.lock),false);
});

test('publisher never releases a foreign lock installed during readback',async t=>{
 const f=fixture(t);fs.unlinkSync(f.lock);const other='{"pid":4018,"atMs":1,"nonce":"new-owner"}';let renamed=false;
 const io={...fs,renameSync:(from,to)=>{fs.renameSync(from,to);if(to===f.file){renamed=true;fs.writeFileSync(f.lock,other);}}};
 const promise=f.write({io});assert.ok(promise instanceof Promise,'publish retains its async public API');const result=await promise;
 assert.equal(renamed,true);assert.equal(result.result,COMMITTED);assert.equal(fs.readFileSync(f.file,'utf8'),NEW);assert.equal(fs.existsSync(f.lock),true,'publisher released a foreign lock');assert.equal(fs.readFileSync(f.lock,'utf8'),other);
});
