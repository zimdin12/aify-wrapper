// Report existing wrapper decisions, not final runtime policy. Explicit command/source oracles are
// independent of the argument parser; an invoked owned runtime exits91 and records its environment.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launch} from './launch-to-a-stub-runtime.mjs';

const FLAGS={claude:'--dangerously-skip-permissions',codex:'--dangerously-bypass-approvals-and-sandbox',hermes:'--yolo',pi:'--auto-approve'};
const CASES=[
 ['default',[],true,'default'],
 ['auto',['--auto'],true,'--auto'],
 ['safe',['--safe'],false,'--safe'],
 ['no-auto',['--no-auto'],false,'--no-auto'],
 ['auto then safe',['--auto','--safe'],false,'--safe'],
 ['safe then auto',['--safe','--auto'],true,'--auto'],
 ['auto then no-auto',['--auto','--no-auto'],false,'--no-auto'],
 ['no-auto then auto',['--no-auto','--auto'],true,'--auto'],
 ['short auto',['-auto'],true,'-auto'],
];
function options(client,extra={}) {
 return {env:{...(client==='pi'?{AIFY_PI_COMMAND:'pi'}:{}),...extra}};
}
function selection(client,enabled,source) {
 const selected=['claude','codex'].includes(client)?`mode=${enabled?'bypass':'omitted'}`:`flag=${enabled?FLAGS[client]:'<none>'}`;
 return `  wrapper-selected permissions: ${selected}; source=${source}; not final runtime permissions${client==='hermes'?' (default TUI only)':''}`;
}
for(const client of Object.keys(FLAGS)) {
 const cases=[...CASES,
  ['flag-looking role value',['--aify-role','--safe'],client!=='codex',client==='codex'?'--safe':'default'],
  ['yolo spelling',['--yolo'],true,client==='codex'?'default':'--yolo'],
 ];
 if(client==='codex')cases.push(
  ['codex alias',['--no-dangerous-permissions'],false,'--no-dangerous-permissions'],
  ['auto then codex alias',['--auto','--no-dangerous-permissions'],false,'--no-dangerous-permissions'],
  ['codex alias then auto',['--no-dangerous-permissions','--auto'],true,'--auto'],
 );
 // Native bypass is still passthrough on these launchers; Hermes instead consumes --yolo as AUTO.
 if(client!=='hermes')cases.push(['native bypass passthrough',['--safe',FLAGS[client]],false,'--safe']);
 else cases.push(['external yolo policy',['--safe'],false,'--safe']);
 for(const [label,args,enabled,source]of cases) {
  test(`${client} --check reports wrapper selection: ${label}`,()=>{
   const result=launch(client,['--check',...args],options(client,{STUB_EXIT:'91',...(client==='hermes'?{HERMES_YOLO_MODE:'1'}:{})}));
   assert.equal(result.run.status,0,result.run.stderr);
   const lines=result.run.stdout.split(/\r?\n/).filter(line=>line.includes('wrapper-selected permissions:'));
   assert.deepEqual(lines,[selection(client,enabled,source)],result.run.stdout);
   assert.deepEqual([result.started,result.appServerArgs,result.args],[{},[],[]],'--check invoked an owned runtime');
   assert.deepEqual([result.sessionFiles,result.remainingResidents],[{},[]],'--check published launch state');
  });
 }
}

// Codex's later app flags are not its bypass selection; retain the initial argument pass unchanged.
test('codex --check reports bypass selection rather than its whole mixed permission array',()=>{
 const result=launch('codex',['--check'],options('codex',{AIFY_AGENT_ID:'permission-agent',AIFY_MANAGED_VIA_WRAPPER:'1',STUB_EXIT:'91'}));
 assert.equal(result.run.status,0,result.run.stderr);
 const line=result.run.stdout.split(/\r?\n/).find(line=>line.includes('wrapper-selected permissions:'));
 assert.equal(line,selection('codex',true,'default'));
 assert.doesNotMatch(line,/--disable|apps|hook-trust/);
 assert.deepEqual([result.started,result.appServerArgs],[{},[]]);
});

// No existing test asserted these Hermes/Pi permission vectors. Their unchanged-parent vectors are
// captured separately in the owned before/after probe; these permanent tests pin the native behavior.
for(const client of ['hermes','pi'])for(const [label,args,enabled]of CASES) {
 test(`${client} native permission argv is unchanged: ${label}`,()=>{
  const result=launch(client,args,options(client));
  assert.equal(result.run.status,0,result.run.stderr);
  assert.deepEqual(result.args,[...(client==='hermes'?['--tui']:[]),...(enabled?[FLAGS[client]]:[])]);
 });
}
