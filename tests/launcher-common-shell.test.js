// Direct v1 shell contract: explicit launcher argument differs from $0; source-only guards have real controls.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {test} from 'node:test';
import {HARNESS_CLIENTS,sealedPath} from './sealed-path.mjs';
const COMMON=path.resolve(import.meta.dirname,'../bin/aify-launcher-common.sh'),slash=value=>value.replaceAll(String.fromCharCode(92),'/');
function owned(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'common-shell-')),bin=path.join(root,'bin');fs.mkdirSync(bin);const seal=sealedPath([]);
 t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(seal.dir,{recursive:true,force:true});});
 const env={PATH:bin+path.delimiter+seal.PATH,SYSTEMROOT:process.env.SYSTEMROOT??'',HOME:root,USERPROFILE:root,COMMON_HELPER:slash(COMMON),COMMON_OUTPUT:slash(path.join(root,'out')),COMMON_POSITIVE:slash(path.join(root,'positive')),COMMON_UNEXPECTED:slash(path.join(root,'unexpected'))};
 const write=(name,text)=>fs.writeFileSync(path.join(bin,name),text,{mode:0o755});
 const run=(script,caller='owned-caller',args=[])=>spawnSync('bash',['--noprofile','--norc','-c',script,caller,...args],{env,encoding:'utf8',timeout:10000});
 return {root,bin,env,write,run};
}
test('sourcing v1 defines the API without starting node or the host, with positive and negative executable controls',t=>{
 const f=owned(t),guard='#!/bin/bash\nif [ "${1:-}" = --positive ]; then printf positive > "$COMMON_POSITIVE"; exit 91; fi\nprintf unexpected > "$COMMON_UNEXPECTED"\nexit 91\n';
 f.write('node',guard);f.write('aify-env',guard);
 const run=f.run('set -euo pipefail\nnode --positive || [ "$?" = 91 ]\n[ -f "$COMMON_POSITIVE" ]\n. "$COMMON_HELPER"\nprintf source-loaded');
 assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,'source-loaded');assert.equal(fs.readFileSync(f.env.COMMON_POSITIVE,'utf8'),'positive');assert.equal(fs.existsSync(f.env.COMMON_UNEXPECTED),false);
 const header=fs.readFileSync(COMMON,'utf8');assert.match(header,/common API v1/);assert.match(header,/Keep these v1 names\/positions compatible or add v2 names/);
});
test('v1 handoff uses explicit launcher/label/argv, never the sourced function caller $0',t=>{
 const f=owned(t);f.write('aify-env','#!/bin/bash\nprintf "%s\\0" "$@" > "$COMMON_OUTPUT"\n');
 const args=['selected-service','/explicit/launcher path','opaque label','','two words','$(literal)'];
 const run=f.run('set -euo pipefail\n. "$COMMON_HELPER"\naify_shared_require_host\naify_shared_handoff "$@"','wrong-decoy-caller',args);
 assert.equal(run.status,0,run.stderr);assert.deepEqual(fs.readFileSync(f.env.COMMON_OUTPUT,'utf8').split('\0').slice(0,-1),['run','--service',args[0],'--launcher',args[1],'--label',args[2],'--',...args.slice(3)]);
});
for(const client of HARNESS_CLIENTS)test(`${client}: missing-host diagnostic names the sourced function caller and retains69`,t=>{
 const f=owned(t);
 const run=f.run('set -euo pipefail\ncommand -v printf >/dev/null\nif command -v definitely_missing_common_control; then exit 93; fi\nif command -v aify-env; then echo "NOT_RUN: a real host command leaked into sealed tools" >&2; exit 92; fi\n. "$COMMON_HELPER"\naify_shared_require_host',client+'-aify');
 assert.equal(run.status,69,run.stdout+run.stderr);assert.ok(run.stderr.startsWith(`${client}-aify: --shared needs aify-env on PATH;`),run.stderr);
});
