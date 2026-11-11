import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProjectWorkspace,getProjectWorkspace,updateProjectWorkspace} from '../src/project-workspace.mjs';
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
