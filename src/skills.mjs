// Skills served over MCP (zana_skill_list / zana_skill_load). Each skill is
// skills/<name>/SKILL.md with frontmatter name and description. Names are an
// exact allowlist read from the directory: no path is ever built from input
// that was not first matched against that list.
import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SKILLS_DIR=fileURLToPath(new URL('../skills/',import.meta.url));
const NAME=/^[a-z][a-z0-9-]{1,63}$/;
const MAX_BYTES=64_000;

export function parseFrontmatter(text){
  const m=/^---\n([\s\S]*?)\n---\n/.exec(text);
  if(!m)return null;
  const fields={};
  for(const line of m[1].split('\n')){
    const i=line.indexOf(':');
    if(i>0)fields[line.slice(0,i).trim()]=line.slice(i+1).trim();
  }
  return fields;
}
function read(dir,name){
  const path=join(dir,name,'SKILL.md');
  const st=lstatSync(path);
  if(!st.isFile()||st.size>MAX_BYTES)throw new Error('Skill '+name+' is not a regular bounded file');
  const text=readFileSync(path,'utf8');
  const meta=parseFrontmatter(text);
  if(!meta?.name||!meta?.description||meta.name!==name)
    throw new Error('Skill '+name+' lacks frontmatter name/description');
  return {name,description:meta.description,text,
    sha256:createHash('sha256').update(text).digest('hex')};
}
export function listSkills(dir=SKILLS_DIR){
  return readdirSync(dir,{withFileTypes:true})
    .filter(e=>e.isDirectory()&&NAME.test(e.name))
    .map(e=>read(dir,e.name)).map(({name,description,sha256})=>({name,description,sha256}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}
export function loadSkill(name,dir=SKILLS_DIR){
  if(typeof name!=='string'||!NAME.test(name))throw new Error('Invalid skill name');
  const known=listSkills(dir).map(s=>s.name);
  if(!known.includes(name))throw new Error('Unknown skill: '+name);
  return read(dir,name);
}
