// Pure byte-to-material composition; freshness belongs to the launcher's random source, not this transform.
import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {test} from 'node:test';
const load=async()=> (await import('../lib/codex-app-server-auth.mjs')).codexAuthMaterial;
const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
test('CONTROL: crypto and URL-safe reference encoding distinguish a token from its seed',()=>{
 assert.equal(createHash('sha256').update('').digest('hex'),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
 assert.equal(Buffer.alloc(32).toString('base64url'),'A'.repeat(43));assert.notEqual(digest('A'.repeat(43)),createHash('sha256').update(Buffer.alloc(32)).digest('hex'));
});
test('zero seed produces a fixed token and hashes its UTF8 text, not the random bytes',async()=>{
 const mint=await load(),value=mint(Buffer.alloc(32));assert.deepEqual(Object.keys(value).sort(),['sha256','token']);assert.equal(value.token,'A'.repeat(43));assert.equal(value.sha256,digest('A'.repeat(43)));assert.notEqual(value.sha256,createHash('sha256').update(Buffer.alloc(32)).digest('hex'));
});
test('binary seed produces unpadded URL-safe text and the server verifier for that exact text',async()=>{
 const mint=await load(),seed=Buffer.alloc(32,255),reference=seed.toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');const value=mint(seed);
 assert.equal(value.token,reference);assert.match(value.token,/^[A-Za-z0-9_-]{43}$/);assert.ok(value.token.includes('_'));assert.equal(value.sha256,digest(reference));
});
test('the transform leaves input bytes unchanged and repeats only when its explicit seed repeats',async()=>{
 const mint=await load(),seed=Buffer.from(Array.from({length:32},(_,index)=>index)),before=Buffer.from(seed),one=mint(seed),two=mint(seed);
 assert.deepEqual(seed,before);assert.deepEqual(one,two);assert.notDeepEqual(one,mint(Buffer.alloc(32,123)));
});
for(const [name,seed]of [['missing',undefined],['null',null],['string','A'.repeat(32)],['non-Buffer array',new Uint8Array(32)],['empty',Buffer.alloc(0)],['short',Buffer.alloc(31)],['long',Buffer.alloc(33)]])test(`mint refuses ${name} input instead of making invalid capability material`,async()=>{
 const mint=await load();assert.throws(()=>mint(seed),/32.*bytes|bytes.*32/i);
});
