// Presupuesto de líneas de un PR: adiciones + eliminaciones sin lockfiles ni
// .zanallaima.json. Se compara por nombre base de la ruta.
export const LOCKFILES=Object.freeze(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock',
  'bun.lockb','Cargo.lock','poetry.lock','uv.lock','Pipfile.lock','composer.lock','Gemfile.lock','go.sum','flake.lock',
  'packages.lock.json','pubspec.lock','mix.lock']);
export const EXCLUDED=Object.freeze([...LOCKFILES,'.zanallaima.json']);
export const excluded=path=>{
  const base=String(path).split('/').pop();
  return EXCLUDED.includes(base)||base.endsWith('.lock');
};
// files: [{filename,additions,deletions}]; truncated: GitHub devolvió el máximo
// de páginas y puede haber más archivos (se trata como sobre el presupuesto).
export function lineBudget(files,{limit,truncated=files.truncated===true}){
  let lines=0,lockfileLines=0;
  for(const f of files){
    const n=(Number(f.additions)||0)+(Number(f.deletions)||0);
    if(excluded(f.filename))lockfileLines+=n;else lines+=n;
  }
  return {limit,lines,lockfileLines,files:files.length,over:truncated||lines>limit,...(truncated?{truncated:true}:{})};
}
// Límite vigente de la misión: su extensión (zana_budget_extend) o el del servidor.
export const lineLimit=(rm,config)=>rm?.lineBudgetExtension?.limit??config.prLineBudget;
