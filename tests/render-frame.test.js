// Framing is tested independently of render policy, with a private source that records exact positional data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {encodeRenderFrame} from '../lib/render-frame.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const posix=value=>value.split(String.fromCharCode(92)).join('/');
function world(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'render-frame-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const script=path.join(dir,'owned-render.sh'),marker=path.join(dir,'called');fs.writeFileSync(script,`printf called > "${posix(marker)}"\nprintf '%s\\0' "$@"\n`);return{dir,script,marker};}
function run(f,input){return spawnSync('bash',[posix(path.join(ROOT,'bin/aify-render-frame.sh'))],{input,encoding:'utf8',cwd:f.dir,env:{PATH:process.env.PATH,HOME:f.dir,USERPROFILE:f.dir,...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},timeout:10000});}
test('encodeRenderFrame and the receiver preserve exact ordinary, control and empty-value data',t=>{
 const f=world(t),args=[posix(f.script),'template','target','ENDPOINT=before\nafter','CR=before\rafter','EMPTY=','PATH=C:/Program Files/bridge'];
 const frame=encodeRenderFrame(args);assert.equal(typeof frame,'string');const result=run(f,frame);assert.equal(result.status,0,result.stderr);
 assert.deepEqual(result.stdout.split('\0'),[...args.slice(1),'']);assert.equal(fs.readFileSync(f.marker,'utf8'),'called');
});
test('encodeRenderFrame refuses embedded NUL instead of silently adding a field',()=>{
 assert.equal(encodeRenderFrame(['/owned/render','template','target','VALUE=before\0after']),null);
});
for(const [name,make]of [
 ['empty',()=> ''],
 ['truncated field',args=>encodeRenderFrame(args).slice(0,-1)],
 ['unterminated extra tail',args=>encodeRenderFrame(args)+'unexpected-tail'],
 ['truncated declared fields',args=>`${args.length+1}\0${args.join('\0')}\0`],
 ['embedded NUL',args=>encodeRenderFrame(args).replace('VALUE=ordinary','VALUE=before\0after')],
 ['empty required field',args=>`${args.length}\0${args[0]}\0\0${args.slice(2).join('\0')}\0`],
])test(`frame receiver refuses ${name} before sourcing or changing an artifact`,t=>{
 const f=world(t);fs.writeFileSync(f.marker,'old');const args=[posix(f.script),'template','target','VALUE=ordinary'];
 const result=run(f,make(args));assert.equal(result.status,78,result.stderr);assert.match(result.stderr,/frame/i);assert.equal(fs.readFileSync(f.marker,'utf8'),'old');
});
