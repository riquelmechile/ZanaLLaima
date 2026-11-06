---
name: zana-4r
description: Procedimiento de la conversación revisora — reclamar el ticket primero, leer todo el diff paginado, cuatro lentes con contexto fresco, enviar cada lente desde esta conversación y finalizar una vez.
---

# zana-4r: conversación revisora

Eres la conversación **revisora**, abierta por el usuario con un mensaje como "Revisa el ticket ZR-XXXX con ZanaLLaima". Tu sesión queda en **solo lectura** sobre esa misión.

## 1. Reclamar antes que nada

1. Tu **primera** tool es `zana_review_claim(ticket)`. No llames tools de misión antes: cualquier escritura en la misión te impide reclamar (`SESSION_WROTE`).
2. Se rechaza con `AUTHOR_SESSION`, `SESSION_WROTE`, `SESSION_PREDATES_TICKET`, `SAME_CLIENT` (si el operador exige otra cuenta OAuth), `TICKET_ALREADY_CLAIMED` o `TICKET_EXPIRED`. No intentes rodearlo: pide al usuario una conversación nueva.
3. La respuesta trae la spec, el SHA, los checks y el **manifiesto del diff** (`diffManifest`: archivos y páginas).

## 2. Leer el diff completo

`zana_review_diff(ticket, page)` para cada página de `0` a `totalPages-1`. Cada respuesta dice qué páginas faltan (`unread`). `zana_review_finalize` rechaza con `DIFF_NOT_FULLY_READ` si queda alguna.

## 3. Cuatro lentes con contexto fresco

1. Carga `review-discipline` una vez.
2. Si el anfitrión permite subagentes, lanza **4 en paralelo**, uno por lente (`review-risk`, `review-readability`, `review-reliability`, `review-resilience`). Cada uno recibe **solo** la spec, el diff completo y los checks, y el texto de su skill: si el subagente no tiene el conector de ZanaLLaima, pégale el texto que devolvió `zana_skill_load`.
3. Los subagentes **devuelven sus hallazgos** a esta conversación; no envían nada a ZanaLLaima.
4. Sin subagentes, corre los 4 lentes **en secuencia** aquí, cada uno desde cero con solo esos insumos, y decláralo.

## 4. Enviar los lentes desde esta conversación

Esta conversación hace los cuatro `zana_review_lens_submit(ticket, lens, findings[], evidence[])`, uno por lente. Cada hallazgo lleva `severity` (`BLOCKER`, `CRITICAL`, `WARNING` o `SUGGESTION`), `location` (`archivo:línea`) y `evidence`. Un lente limpio envía `findings: []` con evidencia concreta. **Los lentes no corrigen código.**

## 5. Finalizar una vez

`zana_review_finalize(ticket, execution)` con `PARALLEL_SUBAGENTS` o `SEQUENTIAL_SAME_CONVERSATION`, lo que de verdad ocurrió. Si el head del PR cambió, `STALE_SHA` y no se publica nada. Si no, se publica la review con la cuenta revisora y el status `zana/4r`. Si la respuesta se cortó, vuelve a llamar a finalize: adopta la review ya publicada y no duplica.

Lo que esto prueba y lo que no: `docs/solo-rdd.md`.
