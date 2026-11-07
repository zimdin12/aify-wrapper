// One data block, two strict readers: malformed category data must not become a partial install.
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {test} from 'node:test';
import {sealedPath} from './sealed-path.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
const BEGIN='# AIFY_REGISTRY_PAIR_CATEGORIES_BEGIN',END='# AIFY_REGISTRY_PAIR_CATEGORIES_END';
const expected={recomputed:['REGISTRY_FINGERPRINT','STRICT_EXTRA_MCP_B64','SESSION_MCP_B64','SESSION_HTTP_B64'],clientSpecific:['SESSION_MCP_CODEX_B64'],serviceOverride:['MCP_TRANSPORT']};
const source=rows=>['# ordinary surrounding source',BEGIN,...rows,END,'# unrelated tail'].join('\n');
const healthy=source(['ONE recomputed','TWO client-specific','THREE service-override']);
const healthyExpected={recomputed:['ONE'],clientSpecific:['TWO'],serviceOverride:['THREE']};
async function nodeRead(text,{fromPackage=false}={}){const {RegistryPairCategories,readRegistryPairCategories}=await import('../lib/registry-pair-categories.mjs');const value=fromPackage?readRegistryPairCategories():RegistryPairCategories.fromRenderer(text);return {recomputed:[...value.recomputed],clientSpecific:[...value.clientSpecific],serviceOverride:[...value.serviceOverride]};}
function shellRead(text){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'registry-categories-')),file=path.join(dir,'render.sh');fs.writeFileSync(file,text);
 const helper=path.join(ROOT,'bin/aify-registry-pair-categories.sh').replaceAll('\\','/');
 const script=['set -eu',`. '${helper}'`,'aify_registry_pair_categories_read "$1" || exit $?','printf "recomputed=%s\\n" "${AIFY_REGISTRY_RECOMPUTED_NAMES[*]}"','printf "clientSpecific=%s\\n" "${AIFY_REGISTRY_CLIENT_NAMES[*]}"','printf "serviceOverride=%s\\n" "${AIFY_REGISTRY_OVERRIDE_NAMES[*]}"'].join('\n');
 const seal=sealedPath([]);
 try{
  const run=spawnSync('bash',['-c',script,'owned-category-reader',file.replaceAll('\\','/')],{env:{...process.env,PATH:seal.PATH},encoding:'utf8',timeout:10000});
  const values=Object.fromEntries(run.stdout.trim().split('\n').filter(Boolean).map(line=>{const split=line.indexOf('=');return [line.slice(0,split),line.slice(split+1).split(' ').filter(Boolean)];}));
  return {...run,values};
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
const invalid=[
 ['malformed row',source(['ONE recomputed extra','TWO client-specific','THREE service-override'])],
 ['duplicate name',source(['ONE recomputed','ONE client-specific','THREE service-override'])],
 ['unknown category',source(['ONE invented-kind','TWO client-specific','THREE service-override'])],
 ['missing start marker',['ONE recomputed','TWO client-specific','THREE service-override',END].join('\n')],
 ['missing end marker',[BEGIN,'ONE recomputed','TWO client-specific','THREE service-override'].join('\n')],
 ['duplicate start marker',healthy+'\n'+BEGIN],
 ['duplicate end marker',healthy+'\n'+END],
 ['expanding name',source(['$(touch_no_file) recomputed','TWO client-specific','THREE service-override'])],
];
for(const reader of ['node','shell']){
 test(`${reader} reader derives all three categories from the actual self-contained render.sh`,async()=>{
  const text=fs.readFileSync(path.join(ROOT,'render.sh'),'utf8');
  if(reader==='node')assert.deepEqual(await nodeRead(text,{fromPackage:true}),expected);
  else{const result=shellRead(text);assert.equal(result.status,0,result.stderr);assert.deepEqual(result.values,expected);}
 });
 test(`${reader} reader has a healthy standalone data-block control`,async()=>{
  if(reader==='node')assert.deepEqual(await nodeRead(healthy),healthyExpected);
  else{const result=shellRead(healthy);assert.equal(result.status,0,result.stderr);assert.deepEqual(result.values,healthyExpected);}
 });
 for(const [name,text] of invalid)test(`${reader} reader refuses ${name} instead of returning partial categories`,async()=>{
  if(reader==='node')await assert.rejects(nodeRead(text),/registry (?:pair )?categories/i);
  else{const result=shellRead(text);assert.equal(result.status,78,result.stderr);assert.equal(result.stdout,'','no partial result published');assert.match(result.stderr,/registry (?:pair )?categories/i);}
 });
 test(`${reader} reader follows a category changed ONLY in actual render.sh bytes`,async()=>{
  const text=fs.readFileSync(path.join(ROOT,'render.sh'),'utf8'),needle='SESSION_HTTP_B64 recomputed';
  assert.equal(text.split(needle).length-1,1,'the actual data declaration must be unique');
  const mutant=text.replace(needle,'SESSION_HTTP_B64 client-specific');
  const changed={...expected,recomputed:expected.recomputed.filter(name=>name!=='SESSION_HTTP_B64'),clientSpecific:['SESSION_HTTP_B64','SESSION_MCP_CODEX_B64']};
  if(reader==='node')assert.deepEqual(await nodeRead(mutant),changed);
  else{const result=shellRead(mutant);assert.equal(result.status,0,result.stderr);assert.deepEqual(result.values,changed);}
 });
}
