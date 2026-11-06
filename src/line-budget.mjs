// Presupuesto de líneas de un PR: adiciones + eliminaciones sin lockfiles ni
// .zanallaima.json. Los lockfiles se comparan por nombre base; el puntero de
// memoria solo en la raíz.
export const LOCKFILES=Object.freeze(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock',
  'bun.lockb','Cargo.lock','poetry.lock','uv.lock','Pipfile.lock','composer.lock','Gemfile.lock','go.sum','flake.lock',
  'packages.lock.json','pubspec.lock','mix.lock']);
// Largest budget zana_budget_extend may set.
export const EXTEND_MAX=5000;
export const excluded=path=>{
  const p=String(path);
  return p==='.zanallaima.json'||LOCKFILES.includes(p.split('/').pop());
};
// files: [{filename,additions,deletions}]; truncated: GitHub devolvió el máximo
// de páginas y puede haber más archivos (se trata como sobre el presupuesto).
// changedFiles: pull.changed_files; si la lista tiene otro largo está incompleta.
export function lineBudget(files,{limit,changedFiles,truncated=files.truncated===true}){
  const mismatch=Number.isSafeInteger(changedFiles)&&changedFiles!==files.length;
  truncated||=mismatch;
  let lines=0,lockfileLines=0;
  for(const f of files){
    const n=(Number(f.additions)||0)+(Number(f.deletions)||0);
    if(excluded(f.filename))lockfileLines+=n;else lines+=n;
  }
  return {limit,lines,lockfileLines,files:files.length,over:truncated||lines>limit,...(truncated?{truncated:true}:{}),
    ...(mismatch?{changedFiles}:{})};
}
// Límite vigente de la misión: su extensión (zana_budget_extend) o el del servidor.
export const lineLimit=(rm,config)=>rm?.lineBudgetExtension?.limit??config.prLineBudget;
