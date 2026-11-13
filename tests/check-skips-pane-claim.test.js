// Inspect the real helper call boundary and claim files, with private HOME and no real Herdr or runtime.
import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {launch} from './launch-to-a-stub-runtime.mjs';
const fwd=value=>value.replaceAll('\\','/');
const recorder=`import fs from 'node:fs';import path from 'node:path';
const action=process.argv[2];fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'helper',action,args:process.argv.slice(2),directory:fs.existsSync(path.join(process.env.HOME,'.aify/herdr')),log:fs.existsSync(path.join(process.env.HOME,'.aify/herdr/claim.log'))})+'\\n');if(action==='claim')process.stdout.write('claimed');`;
const snapshot=`import fs from 'node:fs';import path from 'node:path';
fs.appendFileSync(process.env.STUB_LOOKUPS,JSON.stringify({kind:'exit',directory:fs.existsSync(path.join(process.env.HOME,'.aify/herdr')),log:fs.existsSync(path.join(process.env.HOME,'.aify/herdr/claim.log'))})+'\\n');`;
function options(client,extra={}) {
  return {env:{HERDR_ENV:'1',HERDR_PANE_ID:'fixture-pane',...(client==='pi'?{AIFY_PI_COMMAND:'pi'}:{}),
    BASH_ENV:({dir})=>fwd(path.join(dir,'probe.sh')),CHECK_SNAPSHOT:({dir})=>fwd(path.join(dir,'snapshot.mjs')),...extra},
    files:{'wrapper/bin/aify-herdr-pane.mjs':recorder,'snapshot.mjs':snapshot,
      'probe.sh':`case "$0" in *-aify) trap 'node "$CHECK_SNAPSHOT"' EXIT ;; esac\n`}};
}
function checked(result) {
  assert.equal(result.run.status,0,result.run.stderr);assert.deepEqual(result.started,{});
  assert.deepEqual(result.asked.filter(row=>row.kind==='helper'),[],'check invoked the pane helper');
  assert.deepEqual(result.asked.filter(row=>row.kind==='exit'),[{kind:'exit',directory:false,log:false}],'check created a claim directory or log');
}
for(const client of ['claude','codex','hermes','pi'])test(`${client} check inside and outside Herdr leaves no claim files; a real safe launch still claims`,()=>{
  checked(launch(client,['--check'],options(client)));
  checked(launch(client,['--check'],options(client,{HERDR_ENV:'0'})));
  const real=launch(client,['--safe'],options(client));
  assert.equal(real.run.status,0,real.run.stderr);assert.ok(Object.keys(real.started).length,'control never reached the owned runtime');
  const claims=real.asked.filter(row=>row.action==='claim');assert.equal(claims.length,1);
  assert.equal(claims[0].directory,true);assert.equal(claims[0].log,true);
  assert.deepEqual(claims[0].args.slice(claims[0].args.indexOf('--')+2),['--safe'],'original argv changed');
});
test('a Claude role value spelled --check remains a real launch, with its original claim argv',()=>{
  const argv=['--aify-role','--check','--safe'],result=launch('claude',argv,options('claude'));
  assert.equal(result.run.status,0,result.run.stderr);assert.ok(Object.keys(result.started).length);
  const claim=result.asked.find(row=>row.action==='claim');assert.ok(claim);
  assert.deepEqual(claim.args.slice(claim.args.indexOf('--')+2),argv);
});
test('Codex pane-file mode stays read-only for check and still configures its helper on launch',()=>{
  const configured=options('codex',{HERDR_ENV:'0',AIFY_HERDR_PANE_FILE:({dir})=>fwd(path.join(dir,'managed-pane'))});
  checked(launch('codex',['--check'],configured));
  const real=launch('codex',['--safe'],configured);assert.equal(real.run.status,0,real.run.stderr);
  assert.ok(Object.keys(real.started).length);assert.equal(real.asked.filter(row=>row.action==='claim').length,0);
  const hooks=real.asked.find(row=>row.action==='codex-hooks');assert.ok(hooks,'pane-file setup was lost');
  assert.equal(hooks.directory,true);assert.match(hooks.args[hooks.args.indexOf('--state-script')+1],/aify-herdr-state\.sh$/);
});
