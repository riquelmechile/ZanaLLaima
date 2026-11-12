import {DatabaseSync} from 'node:sqlite';
import {createProjectWorkspace,updateProjectWorkspace} from '../../src/project-workspace.mjs';
import {draftProjectPlan} from '../../src/project-discovery.mjs';

export const client='oauth-panel-owner',T0=Date.parse('2026-11-12T00:00:00Z');
const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
const alternatives=[
  {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',sources:[{title:'Node',url:'https://nodejs.org/docs/',checkedOn:'2026-11-11'}]},
  {id:'go',technology:'Go',rationale:'Concurrencia',benefits:'Binario',tradeoffs:'Stack',sources:[{title:'Go',url:'https://go.dev/doc/',checkedOn:'2026-11-11'}]}];
export function makePlan(brief,objective='Modelo'){
  return draftProjectPlan({brief,alternatives,selectedId:'node',milestones:[{id:'core',objective,acceptance:'Tests',dependsOn:[]}]});
}
export function panelFixture(){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  let workspace=createProjectWorkspace(db,{clientId:client,idea:'Crear una plataforma de proyectos extensible'});
  workspace=updateProjectWorkspace(db,{clientId:client,workspaceId:workspace.workspaceId,expectedVersion:0,answers});
  workspace=updateProjectWorkspace(db,{clientId:client,workspaceId:workspace.workspaceId,expectedVersion:1,plan:makePlan(workspace.brief)});
  const base={clientId:client,workspaceId:workspace.workspaceId,expectedVersion:workspace.version,owner:'riquelmechile',name:'panel-demo',visibility:'private',allowed:()=>true};
  return {db,workspace,base};
}
