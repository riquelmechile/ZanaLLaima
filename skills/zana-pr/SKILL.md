---
name: zana-pr
description: Reglas del autor para commits y PR — commits como unidades con sus tests en conventional commits en español, cuerpo con qué y por qué, plan de pruebas con evidencia real y una línea Risk con categorías cerradas.
---

# zana-pr: commits y cuerpo del PR

Cárgala con `zana_skill_load` antes de abrir el PR (`zana-odd`, paso 5) y síguela también al editar el cuerpo con `update_pull_request`.

## Commits

- Cada commit es una unidad: un cambio con sus tests, que se entiende y pasa por sí solo. Nada de "wip" ni de tests en un commit aparte del código que prueban (salvo el test negativo que falla antes del fix, que va primero).
- Mensaje en conventional commits, en español: `feat:`, `fix:`, `test:`, `docs:` (también `refactor:` y `chore:` si de verdad lo son). Primera línea corta, en imperativo, diciendo qué cambia.

## Cuerpo del PR

Lleva tres partes, en este orden:

1. **Qué cambia y por qué.** El comportamiento nuevo o corregido y la razón (la spec, el hallazgo, el issue). Sin pegar el diff.
2. **Plan de pruebas.** Nombra los checks que de verdad corrieron y su resultado: el `checkId` y el SHA de `zana_checks_status`, cada job con `SUCCESS` o `FAILURE`, y los tests nuevos por nombre. **Ninguna casilla marcada sin evidencia.** Lo que no se pudo correr va sin marcar y con el motivo; si el setup falló, dilo ("0 tests corridos" y el error), no lo des por bueno.
3. **Línea `Risk:`** en una línea propia. Vale `Risk: none` o una o más de estas categorías, separadas por coma, cada una con una frase de por qué:
   - `irreversible-data`: migración, borrado o escritura que no se deshace;
   - `security`: auth, permisos, secretos, entradas no confiables o redacción;
   - `public-contract`: cambia una tool, un código de error, un esquema o un formato que otros consumen;
   - `concurrency`: locks, leases, transacciones, carreras o reintentos;
   - `ci-or-deps`: CI, scripts de build, dependencias o lockfiles;
   - `untestable`: una parte que ningún test ejecuta (di cuál).

   Ejemplo: `Risk: public-contract (zana_review_claim devuelve baseSha nuevo), concurrency (el ticket se reemplaza con el lock de la misión)`.

   `none` solo si el diff no toca nada de esa lista. La revisora compara la línea con el diff: si falta o no calza, es un hallazgo.

## Tamaño

El PR completo cabe en 400 líneas (adiciones + eliminaciones, sin lockfiles ni `.zanallaima.json`). Si pasa, divídelo o pide autorización como dice `zana-odd` (paso 5.3): pregunta al usuario el número exacto y solo con su sí llama `zana_budget_extend`. Nunca la llames sin preguntar.
