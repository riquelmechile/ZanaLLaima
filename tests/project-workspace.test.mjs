import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProjectWorkspace,getProjectWorkspace,updateProjectWorkspace,listProjectWorkspaces,setProjectWorkspaceArchived} from '../src/project-workspace.mjs';
import {draftProjectPlan} from '../src/project-discovery.mjs';
const client='oauth-operator-one',id='Crear un sitio de gestión de proyectos extensible';
function fixture(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');return db;}
function answers(){return{goal:'Gestionar hitos',users:'Equipos de desarrollo',platform:'Web',features:'Planes',data:'Sin secretos'};}
function plan(brief){return draftProjectPlan({brief,alternatives:[
 {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',sources:[{title:'Node docs',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
 {id:'go',technology:'Go',rationale:'Concurrencia',benefits:'Binario',tradeoffs:'Otro stack',sources:[{title:'Go docs',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]}],
 selectedId:'node',milestones:[{id:'core',objective:'Modelo',acceptance:'Tests',dependsOn:[]}]});}
function update(db,x,args={}){return updateProjectWorkspace(db,{clientId:client,workspaceId:x.workspaceId,expectedVersion:x.version,...args});}
test('crea borrador persistente sin aprobación ni repositorio',()=>{
 const db=fixture();try{const w=createProjectWorkspace(db,{clientId:client,idea:id});
 assert.equal(w.version,0);assert.equal(w.plan,null);assert.equal(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}).brief.idea,id);
 assert.ok(!JSON.stringify(w).includes('ownerClient'));
 }finally{db.close();}
});
test('aislamiento por OAuth y rechazo sin actor válido',()=>{
 const db=fixture();try{const w=createProjectWorkspace(db,{clientId:client,idea:id});
 assert.throws(()=>getProjectWorkspace(db,{workspaceId:w.workspaceId,clientId:'oauth-other'}),/WORKSPACE_NOT_FOUND/);
 assert.throws(()=>createProjectWorkspace(db,{clientId:'x',idea:id}),/WORKSPACE_ACTOR_REQUIRED/);
 assert.throws(()=>getProjectWorkspace(db,{workspaceId:'other',clientId:client}),/WORKSPACE_NOT_FOUND/);
 }finally{db.close();}
});
test('rondas actualizan versión y el control optimista bloquea escritores atrasados',()=>{
 const db=fixture();try{const w=createProjectWorkspace(db,{clientId:client,idea:id});
 const v1=update(db,w,{answers:answers()});assert.equal(v1.version,1);assert.equal(v1.brief.status,'READY_FOR_PLAN');
 assert.throws(()=>update(db,w,{answers:{goal:'Otro'}}),/STALE_REVISION/);
 assert.equal(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}).version,1);
 }finally{db.close();}
});
test('plan exige digest y briefing vigente; cambios invalidan el plan guardado',()=>{
 const db=fixture();try{let w=createProjectWorkspace(db,{clientId:client,idea:id});w=update(db,w,{answers:answers()});
 const p=plan(w.brief);w=update(db,w,{plan:p});assert.equal(w.plan.digest,p.digest);
 const altered={...p,selectedId:'go'};
 assert.throws(()=>update(db,w,{plan:altered}),/PLAN_TAMPERED/);
 const next=update(db,w,{answers:{goal:'Nueva necesidad'}});assert.equal(next.plan,null);
 assert.throws(()=>update(db,next,{plan:p}),/PLAN_BRIEF_MISMATCH/);
 }finally{db.close();}
});
test('un update ambiguo no muta el borrador',()=>{
 const db=fixture();try{const w=createProjectWorkspace(db,{clientId:client,idea:id});
 assert.throws(()=>update(db,w,{}),/INVALID_WORKSPACE_UPDATE/);
 assert.throws(()=>update(db,w,{answers:{goal:'x'},plan:{}}),/INVALID_WORKSPACE_UPDATE/);
 assert.equal(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}).version,0);
 }finally{db.close();}
});
test('un valor almacenado corrupto falla cerrado',()=>{
 const db=fixture();try{const w=createProjectWorkspace(db,{clientId:client,idea:id});
 db.prepare('UPDATE metadata SET value=? WHERE key=?').run('not JSON','zana:workspace:'+w.workspaceId);
 assert.throws(()=>getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}),/WORKSPACE_CORRUPT/);
 }finally{db.close();}
});

test('listado paginado: solo metadatos del mismo OAuth',()=>{
 const db=fixture();try{
   const own=Array.from({length:5},(_,i)=>createProjectWorkspace(db,{clientId:client,idea:id+' '+i}));
   const other=createProjectWorkspace(db,{clientId:'oauth-other',idea:id+' secreto'});
   const seen=[];let cursor=null;
   do{const page=listProjectWorkspaces(db,{clientId:client,cursor,limit:2});
     assert.ok(page.items.length<=2);seen.push(...page.items);
     assert.ok(page.items.every(x=>!('brief' in x)&&!('plan' in x)&&!('ownerClient' in x)));
     cursor=page.nextCursor;
   }while(cursor);
   assert.deepEqual(seen.map(x=>x.workspaceId).sort(),own.map(x=>x.workspaceId).sort());
   assert.ok(!seen.some(x=>x.workspaceId===other.workspaceId));
 }finally{db.close();}
});
test('archivar y restaurar sin pérdida y con revisionado',()=>{
 const db=fixture();try{
   const w=createProjectWorkspace(db,{clientId:client,idea:id});
   const archived=setProjectWorkspaceArchived(db,{clientId:client,workspaceId:w.workspaceId,expectedVersion:0,archived:true});
   assert.equal(archived.version,1);assert.ok(archived.archivedAt);
   assert.equal(listProjectWorkspaces(db,{clientId:client}).items.length,0);
   assert.equal(listProjectWorkspaces(db,{clientId:client,includeArchived:true}).items.length,1);
   assert.throws(()=>updateProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId,expectedVersion:1,answers:answers()}),/WORKSPACE_ARCHIVED/);
   assert.throws(()=>setProjectWorkspaceArchived(db,{clientId:client,workspaceId:w.workspaceId,expectedVersion:0,archived:false}),/STALE_REVISION/);
   const restored=setProjectWorkspaceArchived(db,{clientId:client,workspaceId:w.workspaceId,expectedVersion:1,archived:false});
   assert.equal(restored.version,2);assert.equal(restored.archivedAt,null);
   assert.equal(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}).brief.idea,id);
   assert.equal(listProjectWorkspaces(db,{clientId:client}).items.length,1);
 }finally{db.close();}
});
test('operaciones de listado y archivo rechazan identidad ajena, cursor y límites',()=>{
 const db=fixture();try{
   const w=createProjectWorkspace(db,{clientId:client,idea:id});
   assert.throws(()=>listProjectWorkspaces(db,{clientId:'x'}),/WORKSPACE_ACTOR_REQUIRED/);
   assert.throws(()=>listProjectWorkspaces(db,{clientId:client,cursor:'../etc/passwd'}),/INVALID_CURSOR/);
   assert.throws(()=>listProjectWorkspaces(db,{clientId:client,limit:31}),/INVALID_WORKSPACE_LIST/);
   assert.throws(()=>listProjectWorkspaces(db,{clientId:client,includeArchived:'true'}),/INVALID_WORKSPACE_LIST/);
   assert.throws(()=>setProjectWorkspaceArchived(db,{clientId:'oauth-other',workspaceId:w.workspaceId,expectedVersion:0,archived:true}),/WORKSPACE_NOT_FOUND/);
   assert.throws(()=>setProjectWorkspaceArchived(db,{clientId:client,workspaceId:w.workspaceId,expectedVersion:0,archived:'true'}),/INVALID_WORKSPACE_UPDATE/);
 }finally{db.close();}
});
test('filas corruptas de otro OAuth no bloquean listados propios',()=>{
 const db=fixture();try{
   const w=createProjectWorkspace(db,{clientId:client,idea:id});
   db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('zana:workspace:12345678-1234-4234-8234-123456789012','not JSON');
   assert.deepEqual(listProjectWorkspaces(db,{clientId:client}).items.map(x=>x.workspaceId),[w.workspaceId]);
 }finally{db.close();}
});

test('redacta secretos antes de guardar ideas y respuestas, sin exponerlos al recuperar',()=>{
 const db=fixture();try{
   const secret='sk-'+ 'K'.repeat(28);
   const w=createProjectWorkspace(db,{clientId:client,idea:id+' token='+secret});
   const row=db.prepare('SELECT value FROM metadata WHERE key=?').get('zana:workspace:'+w.workspaceId);
   assert.ok(!row.value.includes(secret));
   assert.ok(!JSON.stringify(w).includes(secret));
   const v=update(db,w,{answers:{...answers(),goal:'Gestionar acceso db_password='+secret}});
   assert.ok(!JSON.stringify(v).includes(secret));
   assert.ok(!db.prepare('SELECT value FROM metadata WHERE key=?').get('zana:workspace:'+w.workspaceId).value.includes(secret));
   assert.ok(!JSON.stringify(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId})).includes(secret));
   const p=plan(v.brief);
   const injected={...p,alternatives:p.alternatives.map((a,i)=>i===0?{...a,rationale:'clave api_key='+secret}:a)};
   assert.throws(()=>update(db,v,{plan:injected}),/WORKSPACE_SECRET_DETECTED/);
   assert.equal(getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId}).plan,null);
 }finally{db.close();}
});
test('legacy: no devuelve secreto previo en get ni lista y no expone digest adulterado',()=>{
 const db=fixture();try{
   const secret='sk-'+ 'P'.repeat(27);
   let w=createProjectWorkspace(db,{clientId:client,idea:id});
   w=update(db,w,{answers:answers()});
   w=update(db,w,{plan:plan(w.brief)});
   const key='zana:workspace:'+w.workspaceId;
   const raw=JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
   raw.brief.idea=id+' password='+secret;
   raw.plan.alternatives[0].benefits='password='+secret;
   db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(raw),key);
   const fetched=getProjectWorkspace(db,{clientId:client,workspaceId:w.workspaceId});
   assert.ok(!JSON.stringify(fetched).includes(secret));
   assert.equal(fetched.plan,null);
   assert.ok(!JSON.stringify(listProjectWorkspaces(db,{clientId:client})).includes(secret));
 }finally{db.close();}
});
test('cuota dura de borradores por OAuth incluye archivados y excluye otros clientes',()=>{
 const db=fixture();try{
   const created=[];
   for(let i=0;i<50;i++)created.push(createProjectWorkspace(db,{clientId:client,idea:id+' '+i}));
   const a=created[0];setProjectWorkspaceArchived(db,{clientId:client,workspaceId:a.workspaceId,expectedVersion:0,archived:true});
   assert.throws(()=>createProjectWorkspace(db,{clientId:client,idea:id+' extra'}),/WORKSPACE_QUOTA_EXCEEDED/);
   assert.equal(createProjectWorkspace(db,{clientId:'oauth-other',idea:id}).version,0);
 }finally{db.close();}
});
