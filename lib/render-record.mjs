// Existing NUL render-record format, shared by its replayer and read-only provenance reader.
import fs from 'node:fs';
import path from 'node:path';

export function recordDirFor(registryPath) {
 return path.join(path.dirname(registryPath),'launchers');
}
export function parseRecord(bytes) {
 const fields=bytes.toString('utf8').split('\0');
 if(fields.pop()!==''||fields.length<3||!/^[0-9a-f]{64}$/.test(fields[0]))return null;
 const [templateSha,template,targetPair,...pairs]=fields;
 if(!/^[a-z]+-aify\.sh\.in$/.test(template)||!targetPair.startsWith('TARGET=')||!pairs.every(pair=>/^[A-Z0-9_]+=/.test(pair)))return null;
 return {templateSha,template,target:targetPair.slice('TARGET='.length),pairs};
}
export function readRecords(dir,io=fs) {
 let names=[];
 try {names=io.readdirSync(dir).filter(name=>name.endsWith('.args'));}catch{return [];}
 return names.map(name=>{try{return parseRecord(io.readFileSync(path.join(dir,name)));}catch{return null;}}).filter(Boolean);
}
