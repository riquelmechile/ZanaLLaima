// Borrador con plan guardado (y, si se pide, aprobado por el operador) sobre
// una SQLite en memoria. Para probar lo que depende de un plan aprobado.
import {DatabaseSync} from 'node:sqlite';
import {createProjectWorkspace,updateProjectWorkspace} from '../../src/project-workspace.mjs';
import {draftProjectPlan} from '../../src/project-discovery.mjs';
import {requestPlanApproval,decidePlanApproval} from '../../src/plan-approval.mjs';

export const T0=Date.parse('2026-11-11T12:00:00Z'),HOUR=3600_000;
export const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
export const alternatives=[
  {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',
    sources:[{title:'Node docs',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
  {id:'go',technology:'Go',rationale:'Concurrencia',benefits:'Binario',tradeoffs:'Otro stack',
    sources:[{title:'Go docs',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]}];
export const draft=(brief,objective='Modelo')=>draftProjectPlan({brief,alternatives,selectedId:'node',
  milestones:[{id:'core',objective,acceptance:'Tests',dependsOn:[]}]});
export function planFixture({client='oauth-operator-one',approved=false}={}){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const w0=createProjectWorkspace(db,{clientId:client,idea:'Crear un sitio de gestión de proyectos extensible'});
  const w1=updateProjectWorkspace(db,{clientId:client,workspaceId:w0.workspaceId,expectedVersion:0,answers});
  const w=updateProjectWorkspace(db,{clientId:client,workspaceId:w0.workspaceId,expectedVersion:1,plan:draft(w1.brief)});
  const at={clientId:client,workspaceId:w.workspaceId};
  let planApprovalId=null;
  if(approved){
    planApprovalId=requestPlanApproval(db,{...at,expectedVersion:w.version,now:T0}).approvalId;
    decidePlanApproval(db,{approvalId:planApprovalId,decision:'allow',passwordOk:true,now:T0});
  }
  return {db,w,at,client,planApprovalId};
}

export const client='oauth-panel-owner',makePlan=draft;
export function panelFixture(){
  const {db,w:workspace}=planFixture({client});
  const base={clientId:client,workspaceId:workspace.workspaceId,expectedVersion:workspace.version,
    owner:'riquelmechile',name:'panel-demo',visibility:'private',allowed:()=>true};
  return {db,workspace,base};
}
