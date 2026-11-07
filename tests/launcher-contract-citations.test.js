// The reported contract citations, not every quoted docs path in the repository, must resolve locally.
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {test} from 'node:test';
import {HARNESS_CLIENTS} from './sealed-path.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),contract='docs/contracts/harness-wrapper.md';
function localCitations(text){
 const source=text.replace(/^\s*(?:#|\/\/)\s?/gm,'');
 return [...source.matchAll(/docs\/[A-Za-z0-9_./+-]+\.md/g)].filter(match=>!/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?:\s+|:|\/)$/.test(source.slice(0,match.index))).map(match=>match[0]);
}
for(const client of HARNESS_CLIENTS)test(`${client} template's current contract citation resolves in this package`,()=>{
 const source=fs.readFileSync(path.join(ROOT,'wrappers',client+'-aify.sh.in'),'utf8'),start=source.indexOf('# ── The harness wrapper contract'),end=source.indexOf('HARNESS_ENDPOINT=',start);
 assert.ok(start>=0&&end>start,'the actual contract header must be located before checking citations');
 const citations=localCitations(source.slice(start,end));assert.ok(citations.length>0,'positive control: actual contract header names a document');
 assert.ok(citations.includes(contract),'the old plan is not the current local contract');
 for(const file of citations)assert.ok(fs.statSync(path.join(ROOT,file)).isFile(),file+' does not resolve locally');
});
test('the package publishes current implementation guidance, with the old comms spec identified as history',()=>{
 const text=fs.readFileSync(path.join(ROOT,contract),'utf8');assert.match(text,/current implementation/i);
 assert.match(text,/https:\/\/github\.com\/zimdin12\/aify-comms\/blob\/main\/docs\/superpowers\/specs\/2026-08-19-harness-wrapper-contract\.md/);
 assert.match(text,/histor(?:y|ical)/i);assert.match(text,/read.only.*(?:Node|helper)|(?:Node|helper).*read.only/i,'check does not promise zero operating-system process starts');
});
test('citation checker controls preserve explicit cross-repo references and find an absent local path',()=>{
 assert.deepEqual(localCitations('# docs/contracts/harness-wrapper.md'),[contract]);
 assert.deepEqual(localCitations('// aify-comms\n// docs/history/not-in-this-package.md'),[]);
 assert.deepEqual(localCitations('# other-service/docs/contract.md'),[]);
 const [missing]=localCitations('# docs/no-such-contract-negative-control.md');assert.equal(fs.existsSync(path.join(ROOT,missing)),false);
 assert.deepEqual(localCitations('# no document named here'),[]);
});
