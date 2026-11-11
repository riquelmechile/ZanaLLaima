---
name: zana-project-workspace
description: Persistir y retomar entrevistas, briefings y planes de proyecto sin crear repositorios ni conceder aprobaciones.
---

# Espacio de proyecto

1. Para una idea nueva, inicia un borrador con `zana_workspace_create` usando el OAuth del operador.
2. Ejecuta rondas de preguntas y actualiza el borrador con `zana_workspace_update`, enviando la `expectedVersion` leída previamente; no sobrescribas cambios concurrentes.
3. Genera el plan con `zana_project_plan_draft` y persistelo con `zana_workspace_update` solo si el digest y el briefing siguen vigentes.
4. Para retomar otra conversación utiliza `zana_workspace_get`. El usuario conserva el identificador del espacio de trabajo.
5. La persistencia no constituye autorizacion. Mantén la creación del repositorio, los merges, el deploy y los permisos por separado.
6. El servidor vincula cada borrador a la conexión OAuth: no copies planes sensibles entre clientes ni asumas que diferentes clientes representan al mismo operador.
