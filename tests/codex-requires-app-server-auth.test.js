// Rendered Codex behavior: auth material must reach only its intended argv/env fields, never a silent no-auth retry.
import assert from 'node:assert/strict';import {test} from 'node:test';
import {CodexAuthProbe} from './codex-auth-probe.mjs';import {KNOWN} from './launch-to-a-stub-runtime.mjs';
const TOKEN='AIFY_CODEX_APP_SERVER_TOKEN';
const okay=result=>assert.equal(result.run.status,0,result.run.stderr);
function material(result){
 assert.ok(result.server,'owned app-server recorder must run');assert.equal(result.server.token.valid,true,'server needs fresh valid capability material');assert.deepEqual(result.server.pointer,{present:true,value:TOKEN});assert.equal(result.server.digestEnvPresent,false,'verifier is shell material, not inherited env');
 const args=result.appServerArgs,mode=args.indexOf('--ws-auth'),digest=args.indexOf('--ws-token-sha256');assert.ok(mode>=0);assert.equal(args[mode+1],'capability-token');assert.ok(digest>=0);assert.equal(args[digest+1],result.server.token.sha256);assert.match(args[digest+1],/^[0-9a-f]{64}$/);
 assert.equal(result.server.argvLeak,false);assert.equal(result.secretLeak,false);assert.equal(result.fixtureBefore.missingControl,false);assert.deepEqual(result.server.inputsAfter,result.fixtureBefore.inputsBefore);
}
for(const noSetsid of [false,true])for(const resume of [false,true])test(`${noSetsid?'direct':'setsid'} server and ${resume?'resume':'fresh'} TUI share the env-named capability without raw argv`,()=>{
 const files=resume?{['<home>/.codex/sessions/'+KNOWN+'.jsonl']:'{}\n'}:{};
 const result=new CodexAuthProbe({forceNoSetsid:noSetsid}).run({args:resume?['--resume',KNOWN]:[],files});okay(result);material(result);assert.ok(result.tui);assert.equal(result.tui.token.sha256,result.server.token.sha256);assert.equal(result.tui.pointer.value,TOKEN);assert.equal(result.tui.argvLeak,false);assert.equal(result.tui.logLeak,false);assert.ok(result.tui.listener,'the actual listener must have published its identity');assert.equal(result.tui.listener.live,true,'readiness must not kill the server instead of its waiter');assert.equal(result.tui.listener.reachable,true,'the TUI must still be able to reach the same server');assert.equal(result.tui.listener.tokenSha256,result.server.token.sha256);
 const index=result.args.indexOf('--remote-auth-token-env');assert.ok(index>=0);assert.equal(result.args[index+1],TOKEN);assert.equal(result.setsid!==null,!noSetsid);
 if(resume)assert.ok(result.args.includes('resume'),'known handle must exercise the actual resume call');
});
test('each owned launch receives distinct valid material, not an inherited old token',()=>{
 const environment={AIFY_CODEX_APP_SERVER_TOKEN:'owned-stale-token',AIFY_CODEX_REMOTE_AUTH_TOKEN_ENV:'OWNED_OLD_NAME',AIFY_CODEX_APP_SERVER_TOKEN_SHA256:'owned-stale-digest'};
 const one=new CodexAuthProbe().run({environment}),two=new CodexAuthProbe().run({environment});okay(one);okay(two);material(one);material(two);assert.notEqual(one.server.token.sha256,two.server.token.sha256);
});
test('xtrace does not expose the token; an injected log leak is detected by the same instrument',()=>{
 const normal=new CodexAuthProbe({xtrace:true}).run();okay(normal);material(normal);assert.equal(normal.secretLeak,false);assert.equal(normal.tui.logLeak,false);assert.match(normal.run.stderr,/\+ CODEX_APP_SERVER_AUTH=/,'caller xtrace must resume after private material capture');
 const leaking=new CodexAuthProbe().run({environment:{AUTH_INJECT_LOG_LEAK:'1'}});okay(leaking);assert.equal(leaking.server.token.valid,true);assert.equal(leaking.tui.logLeak,true,'positive log control must find the exact raw capability');
 const argvLeak=new CodexAuthProbe().run({edit:text=>{const line='CODEX_APP_SERVER_AUTH=(--ws-auth capability-token --ws-token-sha256 "$AIFY_CODEX_APP_SERVER_TOKEN_SHA256")';assert.equal(text.split(line).length,2);return text.replace(line,()=>line.slice(0,-1)+' "$AIFY_CODEX_APP_SERVER_TOKEN")');}});okay(argvLeak);assert.equal(argvLeak.server.token.valid,true);assert.equal(argvLeak.server.argvLeak,true,'positive argv control must observe a raw capability actually passed to the owned app-server');
});
test('shared host child inherits no superseded token, pointer or verifier',()=>{
 const result=new CodexAuthProbe({host:true}).run({args:['--shared']});okay(result);material(result);assert.ok(result.host);assert.equal(result.tui,null);assert.deepEqual(result.host.token,{present:false,valid:false,sha256:null});assert.deepEqual(result.host.pointer,{present:false});assert.equal(result.host.digestEnvPresent,false);assert.equal(result.host.argvLeak,false);
});
test('shared host re-enters the actual launcher and mints a distinct capability after discarding the first',()=>{
 const result=new CodexAuthProbe({host:true}).run({args:['--shared'],environment:{AUTH_HOST_RELAUNCH:'1'}});okay(result);material(result);assert.ok(result.tui);assert.equal(result.host.token.present,false);assert.equal(result.host.pointer.present,false);assert.equal(result.host.digestEnvPresent,false);assert.equal(result.host.listener.live,false);assert.equal(result.host.listener.reachable,false);assert.notEqual(result.host.listener.tokenSha256,result.server.token.sha256,'host-side launcher must remint, not reuse the discarded capability');assert.equal(result.tui.token.sha256,result.server.token.sha256);
});
test('missing pure auth helper refuses a real launch78 before app-server/TUI effects',()=>{
 const result=new CodexAuthProbe({missingHelper:true}).run();assert.deepEqual({status:result.run.status,named:result.run.stderr.includes('codex-app-server-auth.mjs'),server:result.server,tui:result.tui,args:result.appServerArgs},{status:78,named:true,server:null,tui:null,args:[]});
});
test('check reports required auth without a mint/runtime probe, even with the helper missing',()=>{
 const result=new CodexAuthProbe({missingHelper:true,host:true}).run({args:['--check']});okay(result);assert.match(result.run.stdout,/capability-token required/i);assert.match(result.run.stdout,/not probed by --check/i);assert.equal(result.server,null);assert.equal(result.tui,null);assert.equal(result.host,null);assert.deepEqual(result.appServerArgs,[]);assert.deepEqual(result.sessionFiles,{});
});
for(const [mode,flag]of [['reject-ws-auth','--ws-auth'],['reject-sha256','--ws-token-sha256']])test(`unsupported ${flag} exits78 promptly and never retries unauthenticated`,()=>{
 const result=new CodexAuthProbe({serverMode:mode}).run();assert.equal(result.run.status,78,result.run.stderr);assert.match(result.run.stderr,/does not support.*app.server auth|app.server auth.*unsupported/i);assert.ok(result.run.stderr.includes(flag));assert.equal(result.tui,null);assert.ok(result.wait===null||result.wait.elapsedMs<3000,'dead server must not consume the10s readiness timeout');
});
for(const mode of ['die-non-auth','error-mentions-auth'])test(`${mode} early death retains existing reachability failure, not an auth misdiagnostic or timeout`,()=>{
 const result=new CodexAuthProbe({serverMode:mode}).run();assert.equal(result.run.status,1,result.run.stderr);assert.match(result.run.stderr,/could not reach the local app-server/);assert.doesNotMatch(result.run.stderr,/does not support.*app.server auth|app.server auth.*unsupported/i);assert.equal(result.tui,null);assert.ok(result.wait===null||result.wait.elapsedMs<3000,'non-auth early death must also end readiness promptly');
});
test('owned TUI auth-flag rejection remains visible with its runtime status, without a no-auth retry',()=>{
 const result=new CodexAuthProbe({tuiReject:true}).run();assert.equal(result.run.status,62,result.run.stderr);assert.match(result.run.stderr,/unexpected argument '--remote-auth-token-env'/);assert.ok(result.tui);assert.ok(result.tui.argv.includes('--remote-auth-token-env'));
});
