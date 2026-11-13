# Monitores permanentes en ChatGPT

ZanaLLaima puede mantener dos monitores permanentes para una sola cuenta: uno revisa y el otro retoma la misión. Un monitor es una tarea o automatización del anfitrión que usa el conector ZanaLLaima, se suscribe con `events/subscribe` a un evento, recibe un webhook firmado con un payload mínimo y despierta una ejecución **nueva**. Un HTTP 2xx solo confirma que el anfitrión recibió el aviso; el despertar se comprueba cuando esa ejecución nueva actúa. Cada suscripción dura como máximo siete días y el anfitrión debe renovarla antes de `refreshBefore`. Si se borra la tarea del monitor, la suscripción termina venciendo y hay que crear de nuevo la tarea y su suscripción.

## Monitor revisor

Se suscribe a `zana.review.ready`, cuyo payload es `{ticketId}`.

**Advertencia de separación estricta:** con `ZANA_DISTINCT_REVIEWER_CLIENT=true`, este monitor revisor no sirve. Los eventos se entregan solo al cliente OAuth autor y el reclamo desde ese cliente responde `SAME_CLIENT`. En ese modo la revisión debe hacerse manualmente desde otro cliente OAuth, usando el código `ZR-`.

1. Carga la skill `zana-4r`.
2. Llama a `zana_review_claim` con `ticketId` (también puede reclamar sin argumentos el ticket abierto más antiguo del mismo cliente OAuth).
3. Lee el diff completo, ejecuta los cuatro lentes y finaliza la 4R.
4. Publica la revisión con la cuenta revisora.
5. Nunca escribe código, fusiona ni adopta la misión. **Esta debe ser una tarea dedicada solo a revisar**: si la conversación escribe/adopta cualquier misión, crea una misión o solicita un ticket, pierde la excepción para reclamar tickets futuros desde la misma sesión.

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

La separación autor/revisor no depende de que cada webhook abra una conversación nueva: el anfitrión puede reusar la misma sesión para varios tickets. En ese caso el backend permite la antigüedad solo a la **revisora pura** (sin ninguna `remote_activity` en ninguna misión, sin crear misiones ni pedir tickets) y sigue aplicando `AUTHOR_SESSION`, `SAME_CLIENT` cuando está configurado, `SESSION_WROTE` y `REVIEWER_READ_ONLY`. La sesión revisora no puede escribir ni adoptar; la autora no puede reclamar su propio ticket. El límite es honesto: ambas sesiones pertenecen al mismo dueño. Es separación de sesiones y credenciales de GitHub, no independencia organizacional ni una auditoría externa.
