# Monitores permanentes en ChatGPT

ZanaLLaima puede mantener dos monitores permanentes para una sola cuenta: uno revisa y el otro retoma la misión. Un monitor es una tarea o automatización del anfitrión que usa el conector ZanaLLaima, se suscribe con `events/subscribe` a un evento, recibe un webhook firmado con un payload mínimo y despierta una ejecución **nueva**. Un HTTP 2xx solo confirma que el anfitrión recibió el aviso; el despertar se comprueba cuando esa ejecución nueva actúa. Cada suscripción dura como máximo siete días y debe renovarse antes de `refreshBefore`.

## Monitor revisor

Se suscribe a `zana.review.ready`, cuyo payload es `{ticketId}`.

1. Carga la skill `zana-4r`.
2. Llama a `zana_review_claim` con `ticketId` (también puede reclamar sin argumentos el ticket abierto más antiguo de la cuenta).
3. Lee el diff completo, ejecuta los cuatro lentes y finaliza la 4R.
4. Publica la revisión con la cuenta revisora.
5. Nunca escribe código, fusiona ni adopta la misión.

### Prompt de ejemplo

> Al recibir `zana.review.ready`, carga `zana-4r`, reclama exactamente el `ticketId` del evento, ejecuta la revisión 4R completa y publícala con la cuenta revisora. No escribas ni fusiones. Si el ticket no se puede reclamar, informa el bloqueo real. Mantén la suscripción habilitada y renuévala antes de `refreshBefore`.

## Monitor orquestador

Se suscribe a `zana.review.done`, cuyo payload es `{ticketId, verdict}`. El aviso es solo un puntero: contrasta el ticket, el veredicto y la misión en el backend; no confíes en el `verdict` del webhook como autorización.

1. Carga la skill `zana-project-orchestrator`.
2. Resuelve la misión del ticket en el backend y llama a `zana_mission_adopt({missionId})`.
3. Detente ante `ADOPT_OTHER_CLIENT`, `REVIEWER_READ_ONLY`, `ADOPT_MISSION_BUSY` o `ADOPT_REVIEW_IN_PROGRESS`.
4. Con `APPROVE`, exige `zana_delivery_status` completamente verde sobre el SHA exacto antes de llamar a `zana_merge`; después cierra la misión y continúa el siguiente hito listo.
5. Con `REQUEST_CHANGES`, inicia la corrección, modifica solo lo autorizado, vuelve a dejar los checks verdes y pide un ticket nuevo.
6. Nunca revisa un ticket de la misión que adoptó.

### Prompt de ejemplo

> Al recibir `zana.review.done`, carga `zana-project-orchestrator`, contrasta el `ticketId`, el veredicto y la misión en ZanaLLaima y adopta esa misión. Con aprobación, exige delivery verde sobre el SHA exacto antes de fusionar; con cambios pedidos, corrige y solicita un ticket nuevo. Detente ante cualquier error de adopción. Nunca revises un ticket de la misión adoptada. Mantén la suscripción habilitada y renuévala antes de `refreshBefore`.

## Separación con una sola cuenta

La separación autor/revisor se conserva porque cada webhook despierta una sesión nueva y el backend aplica `AUTHOR_SESSION`, `SESSION_WROTE` y `REVIEWER_READ_ONLY`. La sesión revisora no puede escribir ni adoptar; la autora no puede reclamar su propio ticket. El límite es honesto: ambas sesiones pertenecen al mismo dueño. Es separación de sesiones y credenciales de GitHub, no independencia organizacional ni una auditoría externa.
