export const PANEL_URI='ui://zanallaima/approval-panel-v1.html';
export const PANEL_MIME='text/html;profile=mcp-app';

export function panelHtml(){
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aprobar proyecto</title>
<style>
:root{color-scheme:light dark;--bg:var(--color-background-primary,light-dark(#fff,#171717));--card:var(--color-background-secondary,light-dark(#f5f5f5,#242424));--text:var(--color-text-primary,light-dark(#171717,#fafafa));--muted:var(--color-text-secondary,light-dark(#555,#bbb));--border:var(--color-border-primary,light-dark(#ddd,#444));--ok:var(--color-background-success,light-dark(#147d3f,#36a269));--danger:var(--color-background-danger,light-dark(#b42318,#d65a52));font-family:var(--font-sans,system-ui,sans-serif)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}main{width:min(100%,420px);margin:auto;padding:16px}.card{background:var(--card);border:1px solid var(--border);border-radius:var(--border-radius-lg,14px);padding:14px;margin:10px 0}h1{font-size:1.25rem;margin:0 0 6px}h2{font-size:1rem;margin:14px 0 6px}h3{font-size:.95rem;margin:10px 0 4px}p,li{font-size:.9rem;line-height:1.45}.muted{color:var(--muted)}ul{padding-left:20px}.actions{display:grid;gap:8px;margin-top:14px}button{border:0;border-radius:10px;padding:11px 12px;font:inherit;font-weight:650;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.approve{background:var(--ok);color:white}.deny{background:var(--danger);color:white}.link{background:transparent;color:var(--text);border:1px solid var(--border);width:100%;margin-top:8px}
</style></head><body><main id="app"><h1>Panel de aprobación</h1><p id="status" class="muted">Conectando con el host…</p><section id="plan"></section><div id="actions" class="actions" hidden><button id="approve" class="approve">Aprobar y crear el repositorio</button><button id="deny" class="deny">Rechazar</button></div></main>
<script>
(function(){
'use strict';
var nextId=1,pending=new Map(),ready=false,panel=null,nonce=null;
var status=document.getElementById('status'),planBox=document.getElementById('plan'),actions=document.getElementById('actions');
var approve=document.getElementById('approve'),deny=document.getElementById('deny');
function post(message){window.parent.postMessage(message,'*');}
function request(method,params){
  var id=nextId++;post({jsonrpc:'2.0',id:id,method:method,params:params});
  return new Promise(function(resolve,reject){pending.set(id,{resolve:resolve,reject:reject});});
}
function notify(method,params){post({jsonrpc:'2.0',method:method,params:params});}
function node(tag,text,className){
  var item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);
  if(className)item.className=className;return item;
}
function addSection(title,body){
  var card=node('section',undefined,'card');card.appendChild(node('h2',title));body(card);planBox.appendChild(card);
}
function showPanel(value,meta){
  panel=value;nonce=meta&&meta.panelId===value.panelId?meta.nonce:null;planBox.textContent='';
  addSection('Proyecto',function(card){
    card.appendChild(node('h3',value.plan&&value.plan.idea||'Sin idea'));
    var answers=value.plan&&value.plan.answers||{};
    Object.keys(answers).forEach(function(key){card.appendChild(node('p',key+': '+answers[key]));});
  });
  addSection('Alternativas',function(card){
    (value.plan&&value.plan.alternatives||[]).forEach(function(option){
      var chosen=option.id===value.plan.selectedId?' (elegida)':'';
      card.appendChild(node('h3',option.technology+chosen));
      card.appendChild(node('p','Razón: '+option.rationale+' · Beneficios: '+option.benefits+' · Costos: '+option.tradeoffs));
      var sources=node('ul');(option.sources||[]).forEach(function(source){
        sources.appendChild(node('li',source.title+' — '+source.url+' ('+source.checkedOn+')'));
      });card.appendChild(sources);
    });
  });
  addSection('Hitos',function(card){
    var list=node('ul');(value.plan&&value.plan.milestones||[]).forEach(function(step){
      var deps=(step.dependsOn||[]).length?' · depende de '+step.dependsOn.join(', '):'';
      list.appendChild(node('li',step.objective+' — '+step.acceptance+deps));
    });card.appendChild(list);
  });
  addSection('Repositorio',function(card){
    var visibility=value.repository&&value.repository.visibility==='public'?'público':'privado';
    card.appendChild(node('p',(value.repository&&value.repository.fullName||'Sin repositorio')+' · '+visibility));
    card.appendChild(node('p','El panel vence: '+value.expiresAt,'muted'));
  });
  if(typeof nonce!=='string'||!nonce){
    status.textContent='Este panel no puede aprobar; usa la página del operador';actions.hidden=true;return;
  }
  status.textContent='Revisa todo el plan antes de decidir.';actions.hidden=false;
}
function resultOf(callResult){
  if(callResult&&callResult.isError){
    var text=callResult.content&&callResult.content[0]&&callResult.content[0].text;
    throw new Error(text||'TOOL_ERROR: la herramienta falló');
  }
  return callResult&&callResult.structuredContent||{};
}
function disable(){approve.disabled=true;deny.disabled=true;}
function context(text){
  return request('ui/update-model-context',{content:[{type:'text',text:text}]}).catch(function(){
    return request('ui/message',{role:'user',content:{type:'text',text:text}});
  });
}
function showExecution(value){
  var label=value.state||'SIN_ESTADO';
  if(label==='DONE'&&value.created){
    status.textContent='DONE: repositorio creado '+value.created.fullName;
    if(value.created.htmlUrl){
      var link=node('button','Abrir '+value.created.fullName,'link');
      link.addEventListener('click',function(){request('ui/open-link',{url:value.created.htmlUrl}).catch(function(error){status.textContent=error.message;});});
      planBox.appendChild(link);
    }
  }else if(label==='OUTCOME_UNKNOWN')status.textContent='OUTCOME_UNKNOWN: resultado incierto, GPT debe reconciliar';
  else status.textContent=label+(value.lastError?': '+value.lastError:'');
  return label;
}
function decide(decision){
  disable();status.textContent='Procesando decisión…';
  request('tools/call',{name:'zana_panel_decide',arguments:{panelId:panel.panelId,nonce:nonce,decision:decision}})
    .then(resultOf).then(function(value){
      if(decision==='deny'){
        status.textContent=value.status||'DENIED';
        return context('El operador rechazó en el panel.');
      }
      if(value.status!=='APPROVED'){
        status.textContent=(value.status||'DENEGADO')+(value.attemptsLeft===undefined?'':' · intentos restantes: '+value.attemptsLeft);
        return context('El operador intentó aprobar en el panel. estado='+(value.status||'DENEGADO'));
      }
      return request('tools/call',{name:'zana_bootstrap_execute',arguments:{operationId:value.operationId}})
        .then(resultOf).then(function(execution){
          var state=showExecution(execution);
          return context('El operador aprobó en el panel. operationId='+value.operationId+', estado='+state);
        });
    }).catch(function(error){
      var message=String(error&&error.message||error);
      status.textContent=message.includes('OUTCOME_UNKNOWN')?message+' — resultado incierto, GPT debe reconciliar':message;
    });
}
approve.addEventListener('click',function(){decide('allow');});
deny.addEventListener('click',function(){decide('deny');});
window.addEventListener('message',function(event){
  if(event.source!==window.parent)return;
  var data=event.data||{};
  if(data.id!==undefined&&pending.has(data.id)){
    var slot=pending.get(data.id);pending.delete(data.id);
    if(data.error)slot.reject(new Error(data.error.message||'JSON_RPC_ERROR: solicitud rechazada'));
    else slot.resolve(data.result);return;
  }
  if(!ready)return;
  if(data.method==='ui/notifications/tool-result'){
    var params=data.params||{},meta=params._meta&&params._meta['zana-llaima/panel'];
    if(params.structuredContent&&params.structuredContent.panel)showPanel(params.structuredContent.panel,meta);
  }
});
request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'zana-approval-panel',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}})
  .then(function(){ready=true;notify('ui/notifications/initialized',{});status.textContent='Esperando el plan…';})
  .catch(function(error){status.textContent='HOST_INIT_FAILED: '+error.message;});
}());
</script></body></html>`;
}
