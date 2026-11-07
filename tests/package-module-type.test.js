// Package typing must remove detection warnings without breaking generated CommonJS or existing node-e children.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {npmCliBeside} from '../lib/package-install.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),NPM=npmCliBeside(process.execPath);
const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
function owned(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'package-module-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const env={...process.env,HOME:root,USERPROFILE:root,NPM_CONFIG_USERCONFIG:path.join(root,'npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(root,'npm-globalrc'),NPM_CONFIG_CACHE:path.join(root,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false'};
 delete env.NODE_TEST_CONTEXT;
 return {root,env};
}
test('the shipped package explicitly declares module syntax',()=>assert.equal(pkg.type,'module'));
test('existing node-e require still works from the package directory',t=>{
 const {env}=owned(t),run=spawnSync(process.execPath,['-e','console.log(typeof require("node:fs").readFileSync)'],{cwd:ROOT,env,encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'function');
});
test('a generated package keeps its own CommonJS build.js when its parent is module typed',t=>{
 const {root,env}=owned(t);fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 const child=path.join(root,'generated');fs.mkdirSync(child);
 fs.writeFileSync(path.join(child,'package.json'),JSON.stringify({name:'owned-commonjs',version:'1.0.0',scripts:{prepare:'node build.js'}}));
 fs.writeFileSync(path.join(child,'build.js'),'require("node:fs").writeFileSync("built", "owned-commonjs");');
 const run=spawnSync(process.execPath,[NPM,'run','prepare'],{cwd:child,env,encoding:'utf8',timeout:20000});
 assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(fs.readFileSync(path.join(child,'built'),'utf8'),'owned-commonjs');
});
test('a real .js test fixture imports without MODULE_TYPELESS detection warnings',t=>{
 const {env}=owned(t),url=new URL('./fixtures/module-type-probe.js',import.meta.url).href;
 const run=spawnSync(process.execPath,['--input-type=module','-e',`const {moduleTypeProbe}=await import(${JSON.stringify(url)});console.log(moduleTypeProbe);`],{cwd:ROOT,env,encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),'owned-module-fixture');assert.doesNotMatch(run.stderr,/MODULE_TYPELESS_PACKAGE_JSON/);
});
test('actual npm pack inventory distinguishes ESM entrypoints from the historical .js evidence witness',t=>{
 const {env}=owned(t),run=spawnSync(process.execPath,[NPM,'pack','--dry-run','--json','--ignore-scripts'],{cwd:ROOT,env,encoding:'utf8',timeout:30000});
 assert.equal(run.status,0,run.stdout+run.stderr);
 const [packed]=JSON.parse(run.stdout),files=packed.files.map(file=>file.path);
 assert.ok(files.includes('lib/session-http.mjs'),'inventory missed a known consumer import');
 assert.ok(files.includes('bin/aify-wrapper-check.mjs'),'inventory missed a known bin');
 assert.ok(!files.includes('tests/fixtures/module-type-probe.js'),'test fixture leaked into the package');
 const loaders=files.filter(file=>/\.(?:js|cjs)$/.test(file));
 console.log('PACKAGED_JS_CJS',JSON.stringify(loaders));
 assert.deepEqual(loaders.filter(file=>!file.startsWith('docs/evidence/')||file.endsWith('.cjs')),[],'new consumer JavaScript loader requires explicit module compatibility coverage');
 for(const entry of Object.values(pkg.bin))assert.match(entry,/\.(?:mjs|sh)$/);
});
