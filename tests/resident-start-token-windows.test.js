// Native Windows omission plus a separately labeled owned-proc-fixture byte-transport control. No live proc file is edited.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {test} from 'node:test';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),slash=p=>p.split(String.fromCharCode(92)).join('/');
function capture(t,{linuxFixture=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'resident-proc-carrier-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const wrapper=path.join(dir,'wrapper'),home=path.join(dir,'home');fs.mkdirSync(home);
 for(const file of ['bin/aify-lease.sh','bin/aify-lifetime.sh','bin/aify-resident-record.mjs','lib/linux-process-token.mjs']){const target=path.join(wrapper,file);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(path.join(ROOT,file)))fs.copyFileSync(path.join(ROOT,file),target);}
 const source=process.env.AIFY_ENV_SCHEMA_REPO??process.env.AIFY_ENV_REPO,shared=JSON.parse(fs.readFileSync(path.join(source,'tests/fixtures/process-identity-v1.json'),'utf8'));
 const stat=path.join(dir,'planted-stat'),boot=path.join(dir,'planted-boot');fs.writeFileSync(boot,shared.token.bootId+'\n');
 const lifetime=path.join(wrapper,'bin/aify-lifetime.sh'),body=fs.readFileSync(lifetime,'utf8');
 fs.writeFileSync(lifetime,body.replaceAll('/proc/$$/stat',slash(stat)).replaceAll('/proc/sys/kernel/random/boot_id',slash(boot)));
 const script=path.join(dir,'owned-carrier.sh');fs.writeFileSync(script,`#!/bin/bash\nset -euo pipefail\n. "$WRAPPER/bin/aify-lease.sh"\n_pid="$(aify_lease_pid "$$")"\nprintf '%s' "\${RAW_STAT/41236/$_pid}" > "$PLANTED_STAT"\n${linuxFixture?'OSTYPE=linux-gnu # fixture-only platform input; this is not a native Linux qualification\n':''}aify_lifetime_start fixture-resident hermes resident\nprintf '%s\\n%s\\n' "$OSTYPE" "$AIFY_RESIDENT_RECORD"\n`);
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
 const raw=linuxFixture?shared.procStat.replace('(hermes shell)','(a )\nname (x))'):shared.procStat;
 Object.assign(env,{HOME:slash(home),USERPROFILE:slash(home),WRAPPER:slash(wrapper),RAW_STAT:raw,PLANTED_STAT:slash(stat)});
 const run=spawnSync('bash',[slash(script)],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,run.stderr);
 const [platform,recordFile]=run.stdout.trim().split('\n'),record=JSON.parse(fs.readFileSync(recordFile,'utf8'));return{platform,record,shared};
}
test('native Windows lifetime omits Linux evidence even beside planted valid proc inputs',{skip:process.platform!=='win32'&&'NOT_RUN: requires native Windows Git Bash'},t=>{
 const {platform,record}=capture(t);assert.match(platform,/^(msys|cygwin)/,'the omission claim must run in an actual Windows shell');
 assert.equal(Object.hasOwn(record,'startToken'),false,'Windows proc-shaped data must never become Linux identity');assert.ok(record.pid>0);
});
test('Bash whole-stat capture preserves multiline comm from an owned proc fixture through the formatter',t=>{
 const {platform,record,shared}=capture(t,{linuxFixture:true});assert.match(platform,/^linux/);
 assert.deepEqual(record.startToken,{...shared.token,pid:record.pid},'whole-stat read must preserve fields after embedded comm newline');
});
