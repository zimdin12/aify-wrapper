// Mandatory real Linux/WSL producer composition. Unsupported/missing prerequisites fail NOT_RUN, never a passing skip.
import assert from 'node:assert/strict';import {test} from 'node:test';import {ResidentTokenNativeRuntime} from './resident-token-native-runtime.mjs';
test('native Linux/WSL waiting launcher publishes its own token while the runtime child runs, and env verifies yes',t=>{
 const result=new ResidentTokenNativeRuntime(t).run('launcher');
 assert.equal(result.platform,'linux');assert.equal(result.recordPid,result.shellPid);assert.notEqual(result.runtimeChildPid,result.shellPid);
 assert.ok(result.startToken,'owning Linux shell did not publish startToken');assert.deepEqual(result.startToken,result.probeToken);assert.equal(result.verified,'yes',result.reason);
 console.log('NATIVE_RESIDENT_TOKEN',JSON.stringify({platform:result.platform,node:result.node,kernel:result.kernel,mode:result.mode,verified:result.verified,ownerMatches:true,runtimeIsChild:true}));
});
test('native Linux/WSL current verifier does not adopt a real writer record whose valid token was changed',t=>{
 const result=new ResidentTokenNativeRuntime(t).run('wrong');assert.ok(result.startToken,'real producer prerequisite did not emit a token');
 assert.notDeepEqual(result.submittedToken,result.probeToken);assert.equal(result.verified,'unknown');assert.equal(result.reason,'identity-unconfirmed');
});
test('native Linux/WSL deliberately child-PID record omits the owning shell token and is not adopted',t=>{
 const result=new ResidentTokenNativeRuntime(t).run('child');
 assert.equal(result.platform,'linux');assert.notEqual(result.recordPid,result.shellPid);assert.equal(result.recordPid,result.deliberateChildPid);
 assert.equal(result.startToken,null,'a parent shell token must not identify its runtime child');assert.equal(result.verified,'unknown');
});
