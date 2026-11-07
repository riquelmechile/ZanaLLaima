# Skills servidas por MCP

ZanaLLaima sirve estas skills con `zana_skill_list` y `zana_skill_load(name)`. Son instrucciones para el anfitrión, no capacidades: no autorizan escrituras ni sustituyen los gates del servidor.

- `zana-odd`: flujo de la conversación autora.
- `zana-pr`: commits, cuerpo del PR, plan de pruebas y línea `Risk:` (la carga `zana-odd` antes de abrir el PR).
- `zana-4r`: conversación revisora y reglas del verificador.
- `review-discipline`, `review-risk`, `review-readability`, `review-reliability`, `review-resilience`: los lentes de la 4R.

Procedencia de los lentes `review-*` y `review-discipline`: adaptados al español desde los agentes `review-*` de [Gentleman-Programming/gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) en el commit `3210886c79360a9f47ac3ca0cd2c1edf43b2432e` (licencia MIT, Copyright (c) 2025 Mario Zechner), tal como los vendoriza `panter-ai@1a99048` en `vendor/gentle-shell/assets/agents/`. La copia de Xanxito no estaba accesible al escribir esta versión; ver `ROADMAP.md`.
