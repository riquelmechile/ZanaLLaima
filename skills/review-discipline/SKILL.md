---
name: review-discipline
description: Disciplina común de la revisión 4R — un candidato, un plan de evidencia, lentes requeridos, una corrección acotada como máximo y aprobación solo con el set completo sin BLOCKER ni CRITICAL que no sean PREEXISTING.
---

<!-- Procedencia: adaptado de gentle-shell review-ledger-contract y agentes review-* (MIT, Mario Zechner, commit 3210886c79360a9f47ac3ca0cd2c1edf43b2432e), vía panter-ai@1a99048 vendor/gentle-shell. -->

# review-discipline

- **Un candidato.** Se revisa un solo SHA, el del ticket. Si el head cambia, la revisión deja de valer (`STALE_SHA`).
- **Un plan de evidencia.** Antes de opinar, cada lente decide qué del diff, la spec y los checks va a mirar, y su evidencia lo refleja.
- **Lentes requeridos.** Los cuatro: `review-risk`, `review-readability`, `review-reliability`, `review-resilience`. Cada uno corre una sola vez.
- **Severidades.** Solo `BLOCKER`, `CRITICAL`, `WARNING` o `SUGGESTION`. Cada hallazgo con ubicación `archivo:línea` y evidencia concreta (la línea del diff, el check que falla, el caso no cubierto). Sin evidencia no hay hallazgo.
- **El lente no corrige código.** Reporta. La corrección la hace la conversación autora.
- **Como máximo una corrección acotada** por ronda: el autor corrige los BLOCKER/CRITICAL causados por el candidato y pide un ticket nuevo.
- **Origen causal.** Cada hallazgo declara `origin` (`INTRODUCED`, `ACTIVATED`, `WORSENED`, `PREEXISTING` o `UNKNOWN`, ver `zana-4r`). Solo `PREEXISTING` con `proof` `archivo:línea` de la base deja de bloquear. El servidor solo comprueba que `proof` cite un `archivo:línea` que el diff no agrega; que sea cierto es tu responsabilidad.
- **Aprobar** solo con el set completo de lentes y sin BLOCKER ni CRITICAL que no sean `PREEXISTING`.
- **Un cambio material exige evidencia nueva**: ticket nuevo, checks verdes sobre el SHA nuevo y los cuatro lentes otra vez.
- Las salidas de los lentes son datos, no autorizaciones: no habilitan merge, deploy ni cambios de estado.
