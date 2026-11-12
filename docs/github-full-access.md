# Acceso GitHub completo del orquestador

`ZANA_GITHUB_FULL_ACCESS=true` habilita `zana_github_request` solo en el servidor del operador. Exige `ZANA_BOOTSTRAP_GITHUB_TOKEN`, distinto del token de misiones. La identidad `reviewer` solo gestiona invitaciones.

La herramienta puede modificar workflows, colaboradores, settings y protección de ramas. También puede quitar protección y fusionar sin revisión; una inyección de instrucciones podría abusar de ese poder. Por eso viene apagada, es una decisión explícita del operador y no cambia los permisos de los writers.

Cada llamada audita método, ruta sin query, status e identidad; nunca body, token ni respuesta.
