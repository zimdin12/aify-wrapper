// The renderer is copied alone by external installers: its marked literal block owns pair categories.
import fs from 'node:fs';
const BEGIN='# AIFY_REGISTRY_PAIR_CATEGORIES_BEGIN';
const END='# AIFY_REGISTRY_PAIR_CATEGORIES_END';
const fail=reason=>{throw new Error(`registry pair categories: ${reason}`);};
export class RegistryPairCategories {
  constructor(rows){
    this.rows=Object.freeze(rows.map(row=>Object.freeze({...row})));
    this.recomputed=Object.freeze(rows.filter(row=>row.category==='recomputed').map(row=>row.name));
    this.clientSpecific=Object.freeze(rows.filter(row=>row.category==='client-specific').map(row=>row.name));
    this.serviceOverride=Object.freeze(rows.filter(row=>row.category==='service-override').map(row=>row.name));
    Object.freeze(this);
  }
  static fromRenderer(source){
    if(typeof source!=='string')fail('renderer source is missing');
    const lines=source.split(/\r?\n/),begins=lines.flatMap((line,i)=>line===BEGIN?[i]:[]),ends=lines.flatMap((line,i)=>line===END?[i]:[]);
    if(begins.length!==1||ends.length!==1||begins[0]>=ends[0])fail('expected unique ordered start/end markers');
    const groups={'recomputed':[], 'client-specific':[], 'service-override':[]},seen=new Set(),rows=[];
    for(const line of lines.slice(begins[0]+1,ends[0])){
      const match=/^([A-Z][A-Z0-9_]*) ([-a-z]+)$/.exec(line);
      if(!match)fail('malformed NAME CATEGORY row');
      const [,name,category]=match;
      if(!Object.hasOwn(groups,category))fail(`unknown category ${category}`);
      if(seen.has(name))fail(`duplicate name ${name}`);
      seen.add(name);groups[category].push(name);rows.push({name,category});
    }
    if(Object.values(groups).some(names=>names.length===0))fail('each category must have a declared member');
    return new RegistryPairCategories(rows);
  }
  pairsFrom(values){
    return this.rows.flatMap(({name,category})=>{
      if(!Object.hasOwn(values,name))fail(`no calculation for ${name}`);
      if(category==='service-override'&&!values[name])return [];
      return [`${name}=${values[name]}`];
    });
  }
}
export function readRegistryPairCategories(){
  return RegistryPairCategories.fromRenderer(fs.readFileSync(new URL('../render.sh',import.meta.url),'utf8'));
}
