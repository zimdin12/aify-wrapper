// The single common filter keeps working after an accepted PATH= removes every external command.
// Per-client behavioral export/diagnostic coverage lives in launcher-common.test.js; this owns the builtin boundary.
import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {test} from 'node:test';
const ROOT=path.resolve(import.meta.dirname,'..'),WRAPPERS=path.join(ROOT,'wrappers'),COMMON=path.join(ROOT,'bin/aify-launcher-common.sh');
const templates=fs.readdirSync(WRAPPERS).filter(name=>name.endsWith('-aify.sh.in'));
for(const template of templates)test(`${template}: the moved filter is sourced and invoked at its caller`,()=>{
 const text=fs.readFileSync(path.join(WRAPPERS,template),'utf8');
 assert.match(text,/bin\/aify-launcher-common\.sh/);assert.match(text,/aify_extra_env_apply "\$HARNESS_EXTRA_ENV"/);
 assert.equal(text.includes('while IFS= read -r _pair'),false,'the common filter body is still duplicated');
});
test('the common protected-prefix filter works with every command removed from PATH',()=>{
 const script=['set -euo pipefail','. "$COMMON"',
  'HARNESS_EXTRA_ENV="$(printf \'PROVIDER_TOKEN=kept\\nPATH=/nowhere\\nAIFY_MANAGED_MODEL=m-forced\\nharness_role=forced\')"',
  'aify_extra_env_apply "$HARNESS_EXTRA_ENV"',
  'printf "%s|%s|%s" "${PROVIDER_TOKEN-unset}" "${AIFY_MANAGED_MODEL-unset}" "${harness_role-unset}"',
 ].join('\n');
 const run=spawnSync('bash',['--noprofile','--norc','-c',script],{encoding:'utf8',env:{PATH:process.env.PATH,SYSTEMROOT:process.env.SYSTEMROOT??'',COMMON:COMMON.replaceAll(String.fromCharCode(92),'/')}});
 assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,'kept|unset|unset');
 assert.match(run.stderr,/may not set AIFY_MANAGED_MODEL, which aify owns; skipped/);assert.match(run.stderr,/may not set harness_role, which aify owns; skipped/);
});
