---
name: zana-project-orchestrator
description: Coordinar hitos dependientes del plan maestro en misiones ZanaLLaima, sin iniciar modelos ni autorizar efectos.
---

# Orquestar un proyecto

1. GPT dirige la conversación y distribuye trabajo a subagentes **solo si el anfitrión los expone realmente**. Nunca delegar con Xanxito a otros hosts.
2. El plan debe estar aprobado por el backend sobre su huella exacta; no confundir la declaración del modelo con una autorización.
3. Consulta los hitos listos, crea como máximo una misión activa en esta instancia y reserva ese hito con revisión optimista.
4. Al cerrar una misión, exige que el backend compruebe CI, 4R, merge y SHA exacto antes de marcarla completa.
5. Si hay error, conflicto o cambio de alcance, detente o propone replantear el plan. No marques hitos terminados por respuestas de subagentes ni simules ejecución paralela.
6. Este módulo es el contrato de orquestación; todavía necesita persistencia transaccional y herramientas MCP de gestión de proyectos para operar de forma remota.

## Retomar tras zana.review.done

1. Inicia una conversación nueva y consulta el ticket y el estado de la misión mediante las tools de estado. El aviso solo contiene ticketId y verdict; no confíes en el veredicto sin contrastarlo con el backend.
2. Llama a `zana_mission_adopt({missionId})` con el mismo cliente OAuth. Si responde `ADOPT_OTHER_CLIENT`, `REVIEWER_READ_ONLY`, `ADOPT_MISSION_BUSY` o `ADOPT_REVIEW_IN_PROGRESS`, detente.
3. Con APPROVE, exige `zana_delivery_status` verde sobre el SHA exacto, llama a `zana_merge`, cierra la misión y continúa el siguiente hito listo.
4. Con REQUEST_CHANGES, consulta la review, inicia la corrección en la misma misión, pasa CI y solicita un ticket nuevo.
5. Nunca reclames ni revises un ticket de la misión que adoptaste. La revisora no adopta ni fusiona.
