---
name: zana-4r
description: Procedimiento de la conversación revisora — reclamar el ticket, cuatro lentes con contexto fresco, enviar cada lente con evidencia, consolidar una vez y finalizar.
---

# zana-4r: conversación revisora

Eres la conversación **revisora**, abierta por el usuario con un mensaje como "Revisa el ticket ZR-XXXX con ZanaLLaima". Tu sesión queda en **solo lectura** sobre esa misión: no escribas en GitHub ni toques unidades.

## 1. Reclamar

1. `zana_review_claim(ticket)`. Se rechaza si esta sesión es la autora, si escribió en la misión, si se creó antes que el ticket o si el ticket ya se usó o venció. No intentes rodear el rechazo: pide al usuario una conversación nueva.
2. La respuesta trae la spec de la misión, el diff del PR, el SHA y los checks. Es todo lo que cada lente recibe.

## 2. Cuatro lentes con contexto fresco

1. Carga `review-discipline` una vez.
2. Si el anfitrión permite subagentes, lanza **4 subagentes en paralelo**, uno por lente (`review-risk`, `review-readability`, `review-reliability`, `review-resilience`). Cada uno carga su skill con `zana_skill_load` y recibe **solo** la spec de la misión, el diff y los checks; nada de esta conversación.
3. Si el anfitrión no permite subagentes, corre los 4 lentes **en secuencia** en esta conversación, cada uno empezando desde cero con solo esos tres insumos, y decláralo al finalizar.

## 3. Enviar cada lente

`zana_review_lens_submit(ticket, lens, findings[], evidence[])`, uno por lente; un reenvío del mismo lente se rechaza. Cada hallazgo lleva `severity` (`BLOCKER`, `CRITICAL`, `WARNING` o `SUGGESTION`), `location` (`archivo:línea`) y `evidence`. Un lente limpio envía `findings: []` y evidencia concreta de lo revisado. **Los lentes no corrigen código.**

## 4. Consolidar una vez y finalizar

`zana_review_finalize(ticket, execution)` con `execution` = `PARALLEL_SUBAGENTS` o `SEQUENTIAL_SAME_CONVERSATION`, lo que de verdad ocurrió. El servidor vuelve a leer el head del PR: si cambió, el ticket queda `STALE_SHA` y no se publica nada. Si sigue igual y los checks siguen verdes, publica la review con la cuenta revisora (`APPROVE` sin BLOCKER ni CRITICAL, `REQUEST_CHANGES` si los hay) y el status `zana/4r`.

Lo que esto prueba y lo que no: ver `docs/solo-rdd.md`. El modelo y el contexto fresco de los subagentes son palabra del anfitrión.
