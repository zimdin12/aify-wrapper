// The existing launch seam must support owned executable fixtures without changing legacy text/function files.
import assert from 'node:assert/strict';import fs from 'node:fs';import {test} from 'node:test';
import {launch} from './launch-to-a-stub-runtime.mjs';
const runtime='#!/bin/bash\nprintf "EXECUTED=owned\\n" > "$STUB_RUNTIME_ENV"\nprintf "%s\\n" "$@" > "$STUB_RUNTIME_ENV.args"\n';
for(const kind of ['string','function'])test(`legacy ${kind} file values still start the existing owned runtime`,()=>{
 const result=launch('claude',[],{files:{'stubs/claude':kind==='string'?runtime:()=>runtime}});
 assert.equal(result.run.status,0,result.run.stderr);assert.equal(result.started.EXECUTED,'owned');
});
for(const kind of ['text','function'])test(`object file ${kind} with mode755 executes an owned stub on the actual launcher path`,()=>{
 const result=launch('claude',[],{runtime:false,files:{'stubs/claude':{text:kind==='text'?runtime:({dir,home,bridge})=>{
  assert.ok(fs.existsSync(dir)&&fs.existsSync(home)&&fs.existsSync(bridge));return runtime;
 },mode:0o755}}});
 assert.equal(result.run.status,0,result.run.stderr);assert.equal(result.started.EXECUTED,'owned');
});
test('the missing owned runtime counterpart cannot start through the sealed launcher path',()=>{
 const result=launch('claude',[],{runtime:false});assert.equal(result.run.status,127,result.run.stderr);assert.deepEqual(result.started,{});
});
test('explicit mode0 is applied rather than lost to a truthiness guard',()=>{
 const result=launch('claude',[],{files:{'mode-control':{text:'owned',mode:0},'stubs/claude':({dir})=>[
  '#!/bin/bash',
  `node -e 'const fs=require("fs");const mode=fs.statSync(process.argv[1]).mode;fs.writeFileSync(process.env.STUB_RUNTIME_ENV,"MODE_WRITE="+(mode & 0o222)+"\\n");' "${dir.replaceAll(String.fromCharCode(92),'/')}/mode-control"`,
 ].join('\n')}});
 assert.equal(result.run.status,0,result.run.stderr);assert.equal(result.started.MODE_WRITE,'0');
});
