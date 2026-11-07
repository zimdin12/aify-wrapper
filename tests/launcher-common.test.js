// Real rendered launchers: preserve exports/argv/cleanup while missing new common functionality refuses safely.
import assert from 'node:assert/strict';import {test} from 'node:test';
import {HARNESS_CLIENTS} from './sealed-path.mjs';
import {LauncherCommonProbe} from './launcher-common-probe.mjs';
const success=result=>assert.equal(result.run.status,0,`${result.run.stdout}\n${result.run.stderr}`);
for(const client of HARNESS_CLIENTS){
 for(const name of ['AIFY_COMMON_FORBIDDEN','aify_common_forbidden','HARNESS_COMMON_FORBIDDEN','harness_common_forbidden'])test(`${client}: ${name} stays unexported and the sourced diagnostic names its calling launcher`,()=>{
  const result=new LauncherCommonProbe({client}).run({extra:`PROVIDER_TOKEN=owned\n${name}=not-allowed`,keys:['PROVIDER_TOKEN',name]});success(result);
  assert.ok(result.runtimePacket);assert.deepEqual(result.runtimePacket.env.PROVIDER_TOKEN,{present:true,value:'owned'});
  assert.deepEqual(result.runtimePacket.env[name],{present:false});
  assert.ok(result.run.stderr.includes(`${client}-aify: HARNESS_EXTRA_ENV may not set ${name}, which aify owns; skipped`),result.run.stderr);
 });
 test(`${client}: ordinary env values preserve spaces, equals and literal shell-looking text`,()=>{
  const value='kept with a space=and an equals $(literal-not-executed)';
  const result=new LauncherCommonProbe({client}).run({extra:`PROVIDER_TOKEN=${value}\n\nnot-a-pair\n# COMMENT=ignored`,keys:['PROVIDER_TOKEN']});success(result);
  assert.deepEqual(result.runtimePacket.env.PROVIDER_TOKEN,{present:true,value});
 });
 test(`${client}: the internal _pair export remains present with the parent EOF-empty value`,()=>{
  const result=new LauncherCommonProbe({client}).run({extra:'_pair=owned-collision',keys:['_pair']});success(result);
  assert.deepEqual(result.runtimePacket.env._pair,{present:true,value:''});
 });
 test(`${client}: an invalid export retains the parent errexit rather than silently launching`,()=>{
  const result=new LauncherCommonProbe({client}).run({extra:'not-valid-name=owned\nPROVIDER_TOKEN=must-not-be-reached'});
  assert.equal(result.run.status,1,result.run.stderr);assert.match(result.run.stderr,/not a valid identifier/);assert.equal(result.runtimePacket,null);
 });
 test(`${client}: absent common helper is reported by check without a runtime or host launch`,()=>{
  const result=new LauncherCommonProbe({client,missingHelper:true,host:true}).run({args:['--check','--shared'],extra:'PROVIDER_TOKEN=owned'});success(result);
  assert.match(result.run.stdout,/nothing was started/i);assert.match(result.run.stdout,/missing.*aify-launcher-common\.sh/i);
  assert.equal(result.runtimePacket,null);assert.equal(result.hostPacket,null);assert.deepEqual(result.appServerArgs,[]);
 });
 test(`${client}: absent helper refuses real extra env before any runtime/host/temp effect`,()=>{
  const result=new LauncherCommonProbe({client,missingHelper:true,host:true}).run({extra:'PROVIDER_TOKEN=owned'});
  assert.deepEqual({status:result.run.status,named:/aify-launcher-common\.sh/.test(result.run.stderr),runtime:result.runtimePacket,host:result.hostPacket,appServerArgs:result.appServerArgs,sessionFiles:result.sessionFiles},
   {status:78,named:true,runtime:null,host:null,appServerArgs:[],sessionFiles:{}},'needed-helper refusal and nonmutation must hold together');
 });
 test(`${client}: absent helper refuses shared handoff with a healthy owned host/runtime`,()=>{
  const result=new LauncherCommonProbe({client,missingHelper:true,host:true}).run({args:['--shared']});
  assert.deepEqual({status:result.run.status,named:/aify-launcher-common\.sh/.test(result.run.stderr),runtime:result.runtimePacket,host:result.hostPacket,appServerArgs:result.appServerArgs},
   {status:78,named:true,runtime:null,host:null,appServerArgs:[]},'shared refusal and absence of runtime/host effects must hold together');
 });
 test(`${client}: a check-looking role value cannot bypass a needed-helper refusal`,()=>{
  const result=new LauncherCommonProbe({client,missingHelper:true}).run({args:['--aify-role','--check'],extra:'PROVIDER_TOKEN=owned'});
  assert.deepEqual({status:result.run.status,named:/aify-launcher-common\.sh/.test(result.run.stderr),runtime:result.runtimePacket},
   {status:78,named:true,runtime:null},'a value token must not bypass refusal or start the runtime');
 });
 test(`${client}: an ordinary launch needing neither feature still works without the new helper`,()=>{
  const result=new LauncherCommonProbe({client,missingHelper:true}).run();success(result);assert.ok(result.runtimePacket);
 });
 test(`${client}: shared argv boundaries and cleanup are visible at the actual owned host executable`,()=>{
  const args=['--shared','--aify-agent=common-owned-agent','two words','','$(literal-not-executed)','--shared-neighbor'];
  const result=new LauncherCommonProbe({client,host:true}).run({args});success(result);assert.equal(result.runtimePacket,null);assert.ok(result.hostPacket);
  assert.deepEqual(result.hostPacket.argv,['run','--service','aify-comms','--launcher',result.launcher,'--label','common-owned-agent','--',...args.filter(arg=>arg!=='--shared')]);
  if(client==='claude')assert.deepEqual(result.hostPacket.tempArtifacts,[],'Claude temp configs must be removed before exec');
  if(client==='codex'){
   assert.equal(result.beforePacket?.appServer?.alive,true,'positive control: owned app-server was not live before cleanup');
   assert.equal(result.beforePacket.appServer.pid,result.hostPacket.appServer.pid,'cleanup observation changed its subject');
   assert.equal(result.hostPacket.appServer.alive,false,'Codex app-server survived cleanup into host handoff');
  }
 });
 for(const mode of ['inferred','resident','managed','environment'])test(`${client}: ${mode} session mode crosses shared boundary only when chosen`,()=>{
  const args=['--shared',...(mode==='resident'||mode==='managed'?['--'+mode]:[])];
  const result=new LauncherCommonProbe({client,host:true}).run({args,environment:mode==='environment'?{AIFY_SESSION_MODE:'resident'}:{}});success(result);
  assert.ok(result.hostPacket);assert.deepEqual(result.hostPacket.env.AIFY_SESSION_MODE,mode==='inferred'?{present:false}:{present:true,value:mode==='environment'?'resident':mode});
 });
}
test('Codex missing runtime127 remains ahead of missing common helper78 when both are absent',()=>{
 const result=new LauncherCommonProbe({client:'codex',missingHelper:true}).run({runtime:false,args:['--shared']});
 assert.equal(result.run.status,127,result.run.stderr);assert.match(result.run.stderr,/runtime CLI 'codex' was not found/);assert.equal(result.hostPacket,null);assert.equal(result.runtimePacket,null);
});
