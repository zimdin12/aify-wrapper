// Common-helper scenarios reuse launch's maintained render/home/process seal; only owned recorder/stub files vary.
import fs from 'node:fs';import path from 'node:path';
import {launch} from './launch-to-a-stub-runtime.mjs';
import {READER_FILES} from './definition-reader-wrapper.mjs';
const ROOT=path.resolve(import.meta.dirname,'..'),slash=value=>value.replaceAll(String.fromCharCode(92),'/');
const NODE=slash(process.execPath),COMMON='bin/aify-launcher-common.sh';
const RECORDER=`import fs from 'node:fs';import path from 'node:path';
const [kind,...argv]=process.argv.slice(2),keys=JSON.parse(process.env.COMMON_RECORD_KEYS||'[]');
const env=Object.fromEntries(keys.map(key=>[key,{present:Object.hasOwn(process.env,key),value:process.env[key]}]));
let appServer=null;
if(process.env.COMMON_APP_PID&&fs.existsSync(process.env.COMMON_APP_PID)){
 const pid=Number(fs.readFileSync(process.env.COMMON_APP_PID,'utf8'));if(pid===process.pid)throw new Error('liveness probe counted itself');let alive=true;
 try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
 appServer={pid,alive};
}
const tempArtifacts=fs.readdirSync(process.env.TMPDIR).filter(name=>/^aify-(?:mcp|hooks)[.]/.test(name));
const folder=path.join(process.env.HOME,'.aify','sessions','common-probe');
fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,kind+'.json'),JSON.stringify({argv,env,appServer,tempArtifacts}));
`;
export class LauncherCommonProbe {
 constructor({client,missingHelper=false,host=false}){Object.assign(this,{client,missingHelper,host});}
 run({args=[],extra='',keys=[],runtime=true,edit,environment={}}={}){
  const files={'common-recorder.mjs':RECORDER};
  if(this.missingHelper)for(const file of READER_FILES.filter(file=>file!==COMMON))files['wrapper/'+file]=fs.readFileSync(path.join(ROOT,file));
  if(runtime)files['stubs/'+this.client]=({dir})=>{
   const original=fs.readFileSync(path.join(dir,'stubs',this.client),'utf8');
   const observed=original.replace('env > "$STUB_RUNTIME_ENV"',`env > "$STUB_RUNTIME_ENV"\n"${NODE}" "${slash(dir)}/common-recorder.mjs" runtime "$@"`);
   // The real owned listener records its own PID and has a self-exit bound if a cleanup mutant orphans it.
   const resetSafe=observed.replace('createServer(s => s.end())','createServer(s => { s.on("error",()=>{}); s.end(); })');
   return resetSafe.replace('require("net").createServer','require("fs").writeFileSync(process.env.COMMON_APP_PID,String(process.pid));setTimeout(()=>process.exit(0),30000).unref();require("net").createServer');
  };
  if(this.host)files['stubs/aify-env']={mode:0o755,text:({dir})=>`#!/bin/bash\nexec "${NODE}" "${slash(dir)}/common-recorder.mjs" host "$@"\n`};
  const env={HARNESS_EXTRA_ENV:extra,COMMON_RECORD_KEYS:JSON.stringify([...new Set([...keys,'AIFY_SESSION_MODE'])]),
   COMMON_WORLD:({dir})=>slash(dir),COMMON_APP_PID:({dir})=>slash(path.join(dir,'common-app.pid')),
   ...(this.client==='pi'?{AIFY_PI_COMMAND:({dir})=>slash(path.join(dir,'stubs/pi'))}:{}),...environment};
  const verifyHost=text=>{
   const seal=this.host?'_common_stubs="$(cd "$COMMON_WORLD/stubs" && pwd)"\nexport PATH="$_common_stubs:$PATH"\n[ "$(command -v aify-env || true)" = "$_common_stubs/aify-env" ] || { echo "NOT_RUN: owned host executable not selected" >&2; exit 91; }\n':'';
   const newline=text.indexOf('\n');let sealed=text.slice(0,newline+1)+seal+text.slice(newline+1);
   if(this.client==='codex'&&this.host){
    const branch='if [ "$CODEX_AIFY_SHARED" = true ]; then';
    if(sealed.split(branch).length-1!==1)throw new Error('owned Codex shared branch is ambiguous');
    sealed=sealed.replace(branch,branch+`\n  "${NODE}" "$COMMON_WORLD/common-recorder.mjs" before`);
   }
   return edit?edit(sealed):sealed;
  };
  const result=launch(this.client,args,{reader:!this.missingHelper,files,env,runtime,edit:verifyHost});
  const packet=kind=>{const raw=result.sessionFiles[`common-probe/${kind}.json`];return raw?JSON.parse(raw):null;};
  return {...result,runtimePacket:packet('runtime'),hostPacket:packet('host'),beforePacket:packet('before')};
 }
}
