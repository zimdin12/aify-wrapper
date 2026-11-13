// Real process uid, rendered launcher, private HOME and a stub Claude. No native provider process is run.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launch} from './launch-to-a-stub-runtime.mjs';
const root=process.platform!=='win32'&&process.geteuid?.()===0;
const rootOnly={skip:!root&&'requires an actual POSIX uid-0 process'};
for(const env of [{},{IS_SANDBOX:'1'},{AIFY_ROOT_SANDBOX:'0',IS_SANDBOX:'1'}])test(`root bypass refuses without explicit sandbox consent ${JSON.stringify(env)}`,rootOnly,()=>{
  const result=launch('claude',[],{env});
  assert.equal(result.run.status,78,result.run.stderr);assert.deepEqual(result.started,{});
  const lines=result.run.stderr.split(/\r?\n/).filter(line=>line.includes('AIFY_ROOT_SANDBOX'));
  assert.equal(lines.length,1,result.run.stderr);assert.match(lines[0],/non-root/);
});
test('explicit root sandbox consent exports the native exemption only to the owned runtime',rootOnly,()=>{
  const result=launch('claude',[],{env:{AIFY_ROOT_SANDBOX:'1'}});
  assert.equal(result.run.status,0,result.run.stderr);assert.equal(result.started.IS_SANDBOX,'1');
  assert.ok(result.args.includes('--dangerously-skip-permissions'));
});
test('root safe mode omits wrapper bypass without requiring a sandbox exemption',rootOnly,()=>{
  const result=launch('claude',['--safe']);assert.equal(result.run.status,0,result.run.stderr);
  assert.equal(result.started.IS_SANDBOX,undefined);assert.equal(result.args.includes('--dangerously-skip-permissions'),false);
});
test('root check remains a read-only report rather than starting a runtime',rootOnly,()=>{
  const result=launch('claude',['--check']);assert.equal(result.run.status,0,result.run.stderr);assert.deepEqual(result.started,{});
});
test('ordinary non-root launch keeps its default bypass and invents no sandbox exemption',
  {skip:root&&'the non-root control runs under an actual non-root uid separately'},()=>{
  const result=launch('claude',[]);assert.equal(result.run.status,0,result.run.stderr);
  assert.ok(result.args.includes('--dangerously-skip-permissions'));assert.equal(result.started.IS_SANDBOX,undefined);
});
