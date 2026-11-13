// The chain can ask its policy owner before connect, without bridge files, writes, Claude or elevation.
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import * as installer from '../lib/channel-install.mjs';
import {withOurChannel} from '../lib/channel-policy.mjs';

const MODULE=fileURLToPath(new URL('../lib/channel-install.mjs',import.meta.url));
const admitted=withOurChannel(null).text;
const fail=()=>assert.fail('a read-only readiness call attempted a write, plugin operation or process start');
function readiness(extra={}) {
  assert.equal(typeof installer.channelPolicyReadiness,'function','the policy owner has no read-only pre-connect export');
  return installer.channelPolicyReadiness({clients:['claude'],platform:'linux',uid:1000,
    env:{HOME:'/original-user-home'},read:()=>null,write:fail,writeFiles:fail,claude:fail,...extra});
}

test('unselected Claude needs no policy inspection',()=>{
  assert.deepEqual(readiness({clients:['codex','hermes'],read:fail}),
    {state:'ready',command:null,reason:'the selected clients do not install the Claude channel'});
});
for(const clients of [undefined,null,'claude',[null],['']])test(`invalid client selection ${JSON.stringify(clients)} refuses before reading`,()=>{
  const result=readiness({clients,read:fail});assert.equal(result.state,'refused');assert.equal(result.command,null);
  assert.match(result.reason,/selected clients/);
});
test('omitted uid uses the host identity and refuses if that identity is unavailable',()=>{
  const result=readiness({uid:undefined});
  assert.equal(result.state,Number.isInteger(process.geteuid?.())?'needs-action':'refused');
});
for(const uid of [null,-1,1.5])test(`unknown POSIX uid ${uid} refuses before reading`,()=>{
  const result=readiness({uid,read:fail});
  assert.equal(result.state,'refused');assert.equal(result.command,null);assert.match(result.reason,/known.*uid/);
});
for(const [platform,file] of [['linux','/etc/claude-code/managed-settings.json'],['darwin','/Library/Application Support/ClaudeCode/managed-settings.json']]) {
  for(const uid of [0,1000])test(`${platform} absent policy returns one policy-only argv, uid ${uid}`,()=>{
    const env={HOME:"/original user/O'Brien",USERPROFILE:'/original-profile'},before={...env},reads=[];
    const result=readiness({platform,uid,env,read:source=>{reads.push(source);return null;}});
    assert.equal(result.state,'needs-action');
    assert.deepEqual(result.command,{file:process.execPath,args:[MODULE,'prepare-policy','--path',file],elevate:uid!==0});
    assert.ok(path.isAbsolute(result.command.file));assert.deepEqual(env,before,'original user environment changed');
    assert.ok(reads.length>0,'positive control: the policy owner was actually consulted');
  });
  test(`${platform} admitted policy is ready for a known user`,()=>{
    const result=readiness({platform,read:source=>source.kind==='file'?admitted:null});
    assert.equal(result.state,'ready');assert.equal(result.command,null);
  });
  for(const policy of ['{','{}','', {unreadable:'denied'}])test(`${platform} existing policy ${JSON.stringify(policy)} cannot be overwritten`,()=>{
    const result=readiness({platform,read:source=>source.kind==='file'?policy:null});
    assert.equal(result.state,'refused');assert.equal(result.command,null);
  });
  test(`${platform} drop-in policy is not mistaken for absent`,()=>{
    const result=readiness({platform,read:source=>source.kind==='dir'?{unreadable:'drop-ins'}:null});
    assert.equal(result.state,'refused');assert.equal(result.command,null);
  });
}

test('Windows absent per-user policy stays ready for the existing installer write path, without writing',()=>{
  let reads=0,policy=null;const calls=[],env={ProgramFiles:'C:/Program Files',HOME:'C:/original-home'};
  const read=source=>{reads++;return source.admin?null:policy;};
  const result=readiness({platform:'win32',uid:undefined,env,read});
  assert.equal(result.state,'ready');assert.equal(result.command,null);assert.match(result.reason,/installer.*writes.*verifies/);
  assert.ok(reads>0);assert.deepEqual(calls,[]);
  const installed=installer.installChannel({platform:'win32',env,read,home:env.HOME,bridgeDir:'/fixture-bridge',
    readScript:()=> 'export const CHANNEL_PRODUCER_GATE = 1;',
    write:(key,text)=>{calls.push('write-policy');policy=text;return {ok:true};},
    writeFiles:()=>calls.push('render'),claude:()=>({ok:true}),route:()=>({route:'plugin'})});
  assert.equal(installed.ok,true,installed.reason);
  assert.deepEqual(calls,['write-policy','render'],'the preserved install path must still write and read back before rendering');
});
test('Windows admitted per-user policy is ready',()=>{
  const result=readiness({platform:'win32',env:{ProgramFiles:'C:/Program Files'},read:source=>source.admin?null:admitted});
  assert.equal(result.state,'ready');assert.equal(result.command,null);
});
for(const policy of ['{}','{',{unreadable:'denied'}])test(`Windows administrator policy ${JSON.stringify(policy)} refuses`,()=>{
  const result=readiness({platform:'win32',env:{ProgramFiles:'C:/Program Files'},read:source=>source.admin?policy:null});
  assert.equal(result.state,'refused');assert.equal(result.command,null);
});
