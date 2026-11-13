// Operational identities do not belong in shipped comments or test fixtures. Recognize roles, not a fleet roster.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const ROOT=path.resolve(import.meta.dirname,'..');
const ROLES=['manager','senior-dev','tech-lead','lead','coder','tester','critic','reviewer'];
const NAMES=new RegExp(`\\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:${ROLES.join('|')})(?:-[a-z0-9]+)*\\b`,'gi');
const names=text=>[...text.matchAll(NAMES)].map(m=>m[0]).filter(value=>!ROLES.includes(value.toLowerCase()));

function filesAt(file) {
  const stat=fs.statSync(file);
  return stat.isDirectory()?fs.readdirSync(file).flatMap(name=>filesAt(path.join(file,name))):[file];
}
function violations() {
  const packaged=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8')).files;
  const files=[...new Set([...packaged,'tests/','HERDR.md'].flatMap(name=>filesAt(path.join(ROOT,name))))];
  // Historical .txt/.out/.log captures keep their original bytes; source drivers beside them are checked.
  return files.filter(file=>/\.(?:[cm]?js|sh|in|py|ps1|json|toml|ya?ml|md|html|css)$/i.test(file)).flatMap(file=>{
    const bytes=fs.readFileSync(file);
    assert.equal(bytes.includes(0),false,`cannot inspect source containing NUL: ${file}`);
    return bytes.toString('utf8').split(/\r?\n/).flatMap((line,index)=>{
      const found=names(line);
      return found.length?[`${path.relative(ROOT,file)}:${index+1}: ${found.join(', ')}`]:[];
    });
  });
}

test('the role-derived recognizer accepts roles and neutral fixtures, and catches prefixed identities',()=>{
  for(const role of ROLES) {
    assert.deepEqual(names(role),[],`a role alone is not an agent identity: ${role}`);
    const id=['fixture',role].join('-');
    assert.deepEqual(names(id),[id]);
    assert.deepEqual(names(id+'-2'),[id+'-2'],'a suffix must not hide an identity');
  }
  for(const neutral of ['probe-agent','source-agent','target-agent','fixture.session','agent-2'])assert.deepEqual(names(neutral),[]);
});

test('shipped source, documentation and test fixtures contain no role-suffixed agent names',()=>{
  const found=violations();
  assert.deepEqual(found,[],`replace agent identities with neutral fixtures or describe the incident without names:\n${found.join('\n')}`);
});
