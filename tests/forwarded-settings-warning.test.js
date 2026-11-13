// Warning only: the actual rendered wrapper keeps the operator's native argument unchanged. No merge/native proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {launch} from './launch-to-a-stub-runtime.mjs';
const helper=fs.readFileSync(new URL('../bin/aify-model-selection.sh',import.meta.url),'utf8');
const files={'wrapper/bin/aify-model-selection.sh':helper};
const payload='{"hooks":{},"operatorField":"kept"}';
const warnings=result=>result.run.stderr.split(/\r?\n/).filter(line=>line.includes('forwarded --settings may replace'));
for(const agent of [[],['--aify-agent','probe-agent']])for(const args of [['--settings',payload],[`--settings=${payload}`]]) {
  test(`${agent.length?'named unclaimed':'anonymous'} ${args[0]} warns once and keeps native settings`,()=>{
    const result=launch('claude',['--safe',...agent,...args],{files});
    assert.equal(result.run.status,0,result.run.stderr);assert.ok(Object.keys(result.started).length,'runtime control did not start');
    assert.equal(result.started.AIFY_AGENT_LEASE,undefined,'fixture accidentally qualified the claimed reporter path');
    const said=warnings(result);assert.equal(said.length,1,result.run.stderr);
    assert.match(said[0],/may replace the wrapper's hooks \(status, file activity\); operator settings are unchanged/);
    for(const word of args)assert.ok(result.args.includes(word),'operator settings were rewritten or dropped');
  });
}
test('multiple forwarded settings flags still produce one warning',()=>{
  const result=launch('claude',['--safe','--settings','{}',`--settings=${payload}`],{files});
  assert.equal(result.run.status,0,result.run.stderr);assert.equal(warnings(result).length,1,result.run.stderr);
});
for(const args of [[],['--aify-role','--settings']])test(`no forwarded native settings means no warning, args ${JSON.stringify(args)}`,()=>{
  const result=launch('claude',['--safe',...args],{files});assert.equal(result.run.status,0,result.run.stderr);
  assert.ok(Object.keys(result.started).length);assert.deepEqual(warnings(result),[]);
  assert.equal(result.args.filter(word=>word==='--settings').length,1,'only the wrapper hook carrier should remain');
});
