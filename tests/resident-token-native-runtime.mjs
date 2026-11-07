// Owned Linux/WSL producer rig. No native agent, env entry point, live profile or process outside this rig.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {checkoutSource} from './sibling-checkouts.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function linuxPath(value){
 const text=value.split(String.fromCharCode(92)).join('/');
 if(process.platform==='linux')return text;
 const match=/^([A-Za-z]):\/(.*)$/.exec(text);assert.ok(match,`NOT_RUN: native fixture path has no WSL drive mapping: ${text}`);return`/mnt/${match[1].toLowerCase()}/${match[2]}`;
}
const OWNER=`#!/bin/bash
set -euo pipefail
wrapper="$1"; contract="$2"; observer="$3"; mode="$4"; done_file="$5"; runtime="$6"
. "$wrapper/bin/aify-lease.sh"
child=""
cleanup() { if [ -n "$child" ]; then : > "$done_file"; wait "$child" || true; fi; aify_lifetime_release; }
trap cleanup EXIT
if [ "$mode" = child ]; then
  /usr/bin/node "$runtime" "$done_file" &
  child=$!
  aify_lease_pid() { printf '%s' "$child"; }
fi
aify_lifetime_start fixture-resident hermes resident
/usr/bin/node "$observer" "$AIFY_RESIDENT_RECORD" "$$" "$contract" "$mode" "$child"
`;
const OBSERVER=`import fs from 'node:fs';import os from 'node:os';import {pathToFileURL} from 'node:url';
const[file,shell,root,mode,child]=process.argv.slice(2),pid=Number(shell);
const {parseLifetimeRecord,verifyLifetime}=await import(pathToFileURL(root+'/lib/resident-lifetimes.mjs'));
const {ProcessIdentityProbe}=await import(pathToFileURL(root+'/lib/process-identity.mjs'));
const raw=JSON.parse(fs.readFileSync(file,'utf8'));
const submitted=mode==='wrong'&&raw.startToken?{...raw,startToken:{...raw.startToken,startTicks:raw.startToken.startTicks+'0'}}:raw;
const parsed=parseLifetimeRecord(JSON.stringify(submitted),file.split('/').at(-1));
if(!parsed.ok)throw new Error(parsed.problem);
const probe=new ProcessIdentityProbe().probeSync([raw.pid]).get(raw.pid),result=verifyLifetime(parsed.record,probe);
process.stdout.write(JSON.stringify({platform:process.platform,node:process.version,kernel:os.release(),mode,shellPid:pid,runtimeChildPid:process.pid,recordPid:raw.pid,deliberateChildPid:Number(child)||null,startToken:raw.startToken??null,submittedToken:submitted.startToken??null,probeToken:probe?.startToken??null,verified:result.verified,reason:result.reason})+'\\n');
`;
const RUNTIME=`import fs from 'node:fs';const poll=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(poll);}},10);setTimeout(()=>process.exit(91),5000).unref();`;
export class ResidentTokenNativeRuntime {
 constructor(t){
  this.dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-resident-token-'));t.after(()=>fs.rmSync(this.dir,{recursive:true,force:true}));
  const {root:contract}=checkoutSource({variable:process.env.AIFY_ENV_SCHEMA_REPO!==undefined?'AIFY_ENV_SCHEMA_REPO':'AIFY_ENV_REPO',files:['lib/process-identity.mjs','lib/resident-lifetimes.mjs'],required:true});
  this.contract=contract;
  this.files={owner:path.join(this.dir,'owned-launcher.sh'),observer:path.join(this.dir,'runtime-observer.mjs'),runtime:path.join(this.dir,'runtime-child.mjs'),done:path.join(this.dir,'done')};
  fs.writeFileSync(this.files.owner,OWNER);fs.writeFileSync(this.files.observer,OBSERVER);fs.writeFileSync(this.files.runtime,RUNTIME);
 }
 run(mode){
  assert.ok(process.platform==='win32'||process.platform==='linux','NOT_RUN: native Linux/WSL producer requires Linux or Windows with WSL');
  const home=linuxPath(path.join(this.dir,'home'));fs.mkdirSync(path.join(this.dir,'home'));
  const args=['--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin',`HOME=${home}`,`USERPROFILE=${home}`,`TMPDIR=${linuxPath(this.dir)}`,'/usr/bin/timeout','--kill-after=2s','18s','/bin/bash','--noprofile','--norc',linuxPath(this.files.owner),linuxPath(ROOT),linuxPath(this.contract),linuxPath(this.files.observer),mode,linuxPath(this.files.done),linuxPath(this.files.runtime)];
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC)$/i.test(key)));
  const run=process.platform==='win32'?spawnSync('wsl.exe',args,{env,encoding:'utf8',timeout:25000}):spawnSync('/usr/bin/env',args.slice(2),{env,encoding:'utf8',timeout:25000});
  assert.equal(run.status,0,`NOT_RUN or producer failure: native Linux/WSL leg did not complete: ${run.error?.message??''}\n${run.stdout}\n${run.stderr}`);
  const rows=run.stdout.trim().split('\n');assert.equal(rows.length,1,'native producer must output only its private observation');return JSON.parse(rows[0]);
 }
}
