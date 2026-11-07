// Read-only launcher source evidence. Generated declarations are literal data, never shell code.
import fs from 'node:fs';
import path from 'node:path';
import {launcherAliases} from './launcher-names.mjs';
import {readRecords,recordDirFor} from './render-record.mjs';
import {compareTemplateSource,sha256Bytes,isTemplateFilename} from './template-source.mjs';

function declarations(text,name) {
 if(typeof text!=='string'||!/^[A-Z0-9_]+$/.test(name))return [];
 return [...text.matchAll(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`,'gm'))];
}
/** Restricted double-quoted / printf-%q-safe word reader. Expansion, ANSI quoting and duplicates fail closed. */
function literalAssignment(text,name) {
 const matches=declarations(text,name);
 if(matches.length!==1)return null;
 const raw=matches[0][1].replace(/[ \t\r]+$/,'');
 const quoted=/^"((?:\\.|[^"\\])*)"$/.exec(raw);
 const body=quoted?quoted[1]:raw;
 let value='';
 for(let i=0;i<body.length;i++){
  const char=body[i];
  if(char==='\\'){
   const next=body[i+1];if(next===undefined)return null;
   if(!quoted||'\\"$`'.includes(next)){value+=next;i++;}else value+=char;
  }else{
   if(quoted?char==='$'||char==='`':/[\s$`'";|&<>()*?\[\]{}!#~]/.test(char))return null;
   value+=char;
  }
 }
 return /[\x00-\x1f\x7f-\x9f]/.test(value)?null:value;
}

const knownVersion=value=>typeof value==='string'&&value.trim()!==''&&value.trim().toLowerCase()!=='unknown'&&!/[\x00-\x1f\x7f-\x9f]/.test(value);

export class LauncherProvenanceReader {
 constructor({registryPath,io=fs,platform=process.platform}) {
  this.registryPath=registryPath;this.io=io;this.platform=platform;
  this.paths=platform==='win32'?path.win32:path.posix;
 }
 native(value) {
  if(typeof value!=='string'||!value)return null;
  const absolute=this.platform==='win32'?/^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(value):value.startsWith('/');
  return absolute?this.paths.resolve(value):null;
 }
 same(a,b) {
  const left=this.native(a),right=this.native(b);if(!left||!right)return false;
  return this.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
 }
 nameSame(a,b) {return this.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}
 ownerOf(text) {
  const baked=literalAssignment(text,'AIFY_WRAPPER_DIR_FWD');
  if(!baked||(!baked.startsWith('/')&&!this.native(baked)))return {ownerRoot:null,detail:'the baked helper package is missing, relative or not a literal'};
  const stamped=literalAssignment(text,'HARNESS_TEMPLATE_OWNER_ROOT');
  if(stamped===null&&declarations(text,'HARNESS_TEMPLATE_OWNER_ROOT').length)return {ownerRoot:null,detail:'generated owner marker is ambiguous or not a literal'};
  const declared=this.native(baked);
  if(stamped&&stamped!=='unavailable'){
   const native=this.native(stamped);
   if(!native)return {ownerRoot:null,detail:'the owning package path is not native on this platform'};
   if(declared&&!this.same(declared,native))return {ownerRoot:null,detail:'generated owner and baked helper package disagree'};
   return {ownerRoot:native};
  }
  return declared?{ownerRoot:declared}:{ownerRoot:null,detail:'the owning package path cannot be resolved natively; re-render it with provenance'};
 }
 read({name,text,path:target,bytes}) {
  const {ownerRoot,detail}=this.ownerOf(text);
  const remedy=`re-run the installer for ${ownerRoot?`owning package ${ownerRoot}`:'the owning package'} to stamp provenance`;
  const unknown=message=>({source:'provenance',state:'unknown',installed:null,expected:null,ownerRoot,detail:message,remedy});
  if(!ownerRoot)return unknown(detail);
  let primary=target;
  for(const [parent,aliases]of launcherAliases(ownerRoot)){
   if(!aliases.some(alias=>this.nameSame(alias,name)))continue;
   if(!/^[a-z0-9][a-z0-9-]*-aify$/.test(parent))return unknown('alias primary name is invalid');
   primary=this.paths.join(this.paths.dirname(target),parent);
   let primaryBytes;
   try {primaryBytes=this.io.readFileSync(primary);}catch{return unknown(`alias primary ${parent} is unavailable`);}
   const actual=bytes??Buffer.from(text??'','utf8');
   if(!actual.equals(primaryBytes))return {source:'alias',state:'stale',installed:sha256Bytes(actual),expected:sha256Bytes(primaryBytes),ownerRoot,detail:`alias differs from primary ${parent}`,remedy};
   break;
  }
  const record=readRecords(recordDirFor(this.registryPath),this.io).find(record=>this.same(record.target,primary));
  const template=literalAssignment(text,'HARNESS_TEMPLATE_NAME'),templateSha=literalAssignment(text,'HARNESS_TEMPLATE_SHA256');
  const usable=/^[0-9a-f]{64}$/.test(templateSha??'')&&isTemplateFilename(template);
  const recordState=!record?'none':!usable?'legacy-unbound':record.template===template&&record.templateSha===templateSha?'marker-coherent':'superseded';
  const recordEvidence={recordState,...(record?{recordTarget:record.target}:{})};
  if(usable){
   const comparison=compareTemplateSource({wrapperRoot:ownerRoot,template,templateSha,io:this.io});
   return {...comparison,...recordEvidence,...(comparison.state==='current'?{}:{remedy})};
  }
  const installed=literalAssignment(text,'HARNESS_WRAPPER_VERSION');
  let expected=null;
  try {expected=this.io.readFileSync(this.paths.join(ownerRoot,'VERSION'),'utf8').trim()||null;}catch{}
  if(knownVersion(installed)&&knownVersion(expected)&&installed!==expected)return {source:'version',state:'stale',installed,expected,ownerRoot,detail:'version changed without usable generated template provenance',remedy,...recordEvidence};
  return {...unknown(templateSha==='unavailable'?'template provenance unavailable: no SHA256 tool answered':'template provenance unavailable: no usable generated marker; version equality is not proof'),...recordEvidence};
 }
}
