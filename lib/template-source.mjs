// One template-byte comparison for connect and the read-only checker. No launcher is executed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {harnessClientsFrom} from './detect-harnesses.mjs';

export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const isTemplateFilename = name => harnessClientsFrom([name]).length===1;

/** Explicit owner tree in, source evidence out. An unreadable source is not agreement. */
export function compareTemplateSource({wrapperRoot,template,templateSha,io=fs}) {
 const base={source:'template',installed:templateSha??null,expected:null,ownerRoot:wrapperRoot??null};
 if(!wrapperRoot||!isTemplateFilename(template)||!/^[0-9a-f]{64}$/.test(templateSha??'')) {
  return {...base,state:'unknown',detail:'template provenance is missing or invalid'};
 }
 let expected;
 try {expected=sha256Bytes(io.readFileSync(path.join(wrapperRoot,'wrappers',template)));}
 catch {return {...base,state:'unknown',detail:`cannot read ${template} in the owning package`};}
 return {...base,expected,state:expected===templateSha?'current':'stale',detail:expected===templateSha?'template unchanged':`template changed: ${template}`};
}
