// Test-only checkout discovery. The npm runner calls this before sealing HOME; gates only validate its pointers.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// One declaration per source role; supplementary reader inputs stay beside the gate that owns them.
const ROLES={
 AIFY_ENV_REPO:{name:'aify-env',files:['lib/agent-definition-schema.mjs','bin/aify-env-credential.mjs']},
 AIFY_COMMS_REPO:{name:'aify-comms',files:['mcp/stdio/aify-service-endpoint.mjs']},
 AIFY_DASHBOARD_REPO:{name:'aify-dashboard',files:['server/src/bridge/wsl-facts.ts']},
 AIFY_ENV_SCHEMA_REPO:{name:'aify-env',files:['lib/agent-definition-schema.mjs'],explicitOnly:true},
};
const readable=(root,files)=>{
 try {return fs.statSync(root).isDirectory()&&files.every(file=>{fs.readFileSync(path.join(root,file));return true;});}
 catch{return false;}
};

export class SiblingCheckouts {
 constructor({env,wrapperRoot,home,platform=process.platform}){Object.assign(this,{env:{...env},wrapperRoot,home,platform});}
 sameName(left,right){return this.platform==='win32'?left.toUpperCase()===right.toUpperCase():left===right;}
 revision(root){
  try {
   const env=Object.fromEntries(Object.entries(this.env).filter(([key])=>!/^GIT_/i.test(key)));
   const git=(...args)=>execFileSync('git',['-C',root,...args],{env,encoding:'utf8',timeout:2000,windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
   const native=value=>{const real=fs.realpathSync(value);return this.platform==='win32'?real.toLowerCase():real;};
   if(native(git('rev-parse','--show-toplevel'))!==native(root))return null;
   const head=git('rev-parse','HEAD');return /^[0-9a-f]{40}$/.test(head)?head:null;
  }catch{return null;}
 }
 select({variable,role}){
  const entries=Object.entries(this.env).filter(([key])=>this.sameName(key,variable));
  if(new Set(entries.map(([,value])=>value)).size>1)throw new Error(`NOT_RUN: conflicting spellings of explicit ${variable}`);
  if(entries.length){
   const value=entries[0][1];
   if(typeof value!=='string'||!value.trim()||/[\x00-\x1f\x7f]/.test(value))throw new Error(`NOT_RUN: explicit ${variable} is not a usable checkout path`);
   const root=path.resolve(value);
   if(!readable(root,role.files))throw new Error(`NOT_RUN: explicit ${variable} lacks readable ${role.files.join(', ')} at ${JSON.stringify(root)}; refusing fallback`);
   return {variable,root,source:'explicit',revision:this.revision(root)};
  }
  const candidates=role.explicitOnly?[]:[
   {root:path.resolve(this.wrapperRoot,'..',role.name),source:'sibling'},
   {root:path.join(this.home,'projects',role.name),source:'home'},
  ];
  const selected=candidates.find(candidate=>readable(candidate.root,role.files));
  return selected?{variable,...selected,revision:this.revision(selected.root)}:{variable,root:null,source:'unavailable',revision:null};
 }
 resolve(){
  const checkouts=Object.entries(ROLES).map(([variable,role])=>this.select({variable,role}));
  const env=Object.fromEntries(Object.entries(this.env).filter(([key])=>!checkouts.some(row=>this.sameName(key,row.variable))));
  for(const row of checkouts)if(row.root!==null)env[row.variable]=row.root;
  return {env,checkouts};
 }
}

/** No discovery after sealing: required gates refuse, optional coverage names what was not run. */
export function checkoutSource({variable,files,required=false,env=process.env,label=variable}){
 const root=env[variable]??'';
 if(root&&readable(root,files))return {root,skip:false};
 const skip=`NOT_RUN: ${label} needs ${variable} with readable ${files.join(', ')}; not verified`;
 if(required)throw new Error(skip);
 return {root:'',skip};
}
