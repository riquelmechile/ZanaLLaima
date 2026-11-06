# Deploy del modo remoto (zana-main)

**El deploy lo hace el operador.** Ningún agente despliega, crea tokens ni edita el archivo de entorno. Esta guía es para ZanaLLaima 0.6.0 en el servidor de Oracle `zana-main`, con `systemd --user`, Cloudflare tunnel y el listener solo en loopback IPv4 (`ZANA_HTTP_PORT`, 8787 por defecto).

## 1. Código y dependencias

```sh
git clone https://github.com/riquelmechile/ZanaLLaima /home/<usuario>/zanallaima
cd /home/<usuario>/zanallaima
git checkout <SHA revisado>
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Node.js ≥22.16.

## 2. Tokens (solo en el servidor)

1. **Autor:** PAT fine-grained de `riquelmechile`, limitado a los repos administrados. Va en `ZANA_DOWNSTREAM_GITHUB_TOKEN` y lo usan el downstream, `zana_checks_*`, `zana_delivery_status` y `zana_merge`. Permisos de repositorio:

   | Permiso | Acceso | Para qué |
   | --- | --- | --- |
   | Contents | lectura y escritura | ramas, archivos, compare/diff y merge |
   | Pull requests | lectura y escritura | abrir y editar el PR, leer reviews y comentarios, merge |
   | Actions | lectura y escritura | `workflow_dispatch` del workflow de checks, runs y logs de jobs |
   | Checks | lectura | check runs del SHA |
   | Commit statuses | **lectura** | leer `zana/4r` en `zana_delivery_status` |
   | Metadata | lectura | obligatorio |
   | Issues | lectura y escritura | solo si se agrega el toolset `issues` para `add_issue_comment` |

   **Sin** Administration, Secrets, Variables, Webhooks ni Workflows (sin *Workflows* GitHub además rechaza cualquier cambio en `.github/workflows`, una segunda llave).
2. **Revisora:** token de `sebastianriquelme95-max` en los mismos repos, en `ZANA_REVIEWER_TOKEN`: *Pull requests* lectura y escritura (publicar y leer reviews), *Commit statuses* lectura y escritura (`zana/4r`), *Contents* y *Metadata* lectura. Esta cuenta no debe tener commits en los PR que revisa (si los tiene, `zana_delivery_status` da `REVIEWER_IS_AUTHOR`).
3. **Consentimiento OAuth:** una clave aleatoria de 32+ caracteres en `ZANA_OAUTH_CONSENT_PASSWORD`.

```sh
mkdir -p /home/<usuario>/.config/zanallaima && chmod 700 /home/<usuario>/.config/zanallaima
cp deploy/zanallaima.env.example /home/<usuario>/.config/zanallaima/zanallaima.env
chmod 600 /home/<usuario>/.config/zanallaima/zanallaima.env
# editar los valores con un editor local; nunca en el repo ni en un chat
```

Completar también `ZANA_STATE_FILE` (por ejemplo `/home/<usuario>/.local/share/zanallaima/state.json`), `ZANA_OAUTH_DB` y `ZANA_GITHUB_REPOS` (`owner/repo` separados por coma). **Rutas absolutas, sin `~`**: systemd no expande `~` en el archivo de entorno, y el servidor y la CLI se niegan a arrancar con rutas relativas.

Independencia verificable entre clientes (opcional): `ZANA_DISTINCT_REVIEWER_CLIENT=true` exige que la conversación revisora use **otro cliente OAuth registrado** que el que pidió el ticket y que todos los que actuaron en la misión (creadora, unidades, escrituras). Que sea otra cuenta de ChatGPT depende de que el operador solo dé de alta cuentas distintas (por ejemplo GPT-B, en la ventana con otra etiqueta de host): ZanaLLaima ve clientes OAuth, no cuentas. Por defecto es `false`: el mismo GPT en una conversación nueva.

## 3. Servicio `systemd --user`

```sh
mkdir -p /home/<usuario>/.config/systemd/user
cp deploy/zanallaima.service /home/<usuario>/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zanallaima
loginctl enable-linger "$USER"
curl -4 -s http://localhost:8787/health
```

Con `nvm` (u otro gestor de versiones) `/usr/bin/env node` puede no encontrar Node, porque systemd no carga el perfil del shell. En ese caso poner en `ExecStart` la ruta absoluta que da `command -v node`, por ejemplo `ExecStart=/home/<usuario>/.nvm/versions/node/v22.23.4/bin/node src/http.mjs`, y actualizarla al cambiar de versión.

`/health` local (loopback, sin encabezado del túnel) responde `200` con `{"status":"ok","name":"zana-llaima","mode":"remote","schemaVersion":7,"reviewerToken":"configured","staleTickets":0,...}`, o `503` con `"status":"degraded"` y `problems` (texto con rutas) si la DB no abre o falta un token. Por el túnel solo se exponen `status`, `version`, `sessions` y `staleTickets`, con el mismo código HTTP; el detalle queda en el `/health` local, en los logs y en `node src/cli.mjs remote-health`. `staleTickets` cuenta tickets reclamados más viejos que el TTL. El proceso escucha solo en loopback IPv4; por eso `curl -4`.

## 4. Cloudflare tunnel

Agregar a la configuración del túnel (ejemplo en `deploy/cloudflared-zanallaima.yml.example`) el hostname `zanallaima.quintoestado.com` hacia el servicio de loopback IPv4 en el puerto 8787 (tal como está escrito en el ejemplo; no usar `localhost`, que puede resolver a IPv6) y reiniciar `cloudflared`. Comprobar `https://zanallaima.quintoestado.com/health` y que `https://zanallaima.quintoestado.com/mcp` sin token responde `401` con `WWW-Authenticate`.

## 5. CLI del operador

Todos los comandos `node src/cli.mjs ...` cargan el entorno del servidor de forma explícita: `--env-file <ruta>`, o `ZANA_ENV_FILE`, o por defecto `/home/<usuario>/.config/zanallaima/zanallaima.env` si existe (el archivo por defecto solo completa variables no definidas; uno explícito manda). Cada `remote-*` exige solo la DB que usa, con ruta absoluta y ya existente (nunca crea una DB nueva por error): `remote-enroll`, `remote-enroll-close`, `remote-clients` y `remote-revoke` usan `ZANA_OAUTH_DB`; `remote-audit`, `remote-health`, `remote-tickets`, `remote-ticket-abandon` y `remote-merge` usan `ZANA_STATE_FILE`. El archivo por defecto avisa si `ZANA_STATE_FILE` o `ZANA_OAUTH_DB` del shell difieren de los suyos. Ejemplo: `node src/cli.mjs remote-audit 50 --env-file /home/<usuario>/.config/zanallaima/zanallaima.env`.

## 6. Alta de las cuentas de Zana (registro cerrado)

1. Abrir la ventana de alta en el servidor: `node src/cli.mjs remote-enroll 15` (1 a 60 minutos).
2. En la app de ChatGPT, agregar el conector con la URL `https://zanallaima.quintoestado.com/mcp`. En la página de consentimiento: comprobar que la iniciaste tú, escribir la etiqueta del host (por ejemplo `zana-chatgpt`) y la clave del operador.
3. Repetir con cada cuenta de Zana que deba entrar.
4. Cerrar: `node src/cli.mjs remote-enroll-close`. Fuera de la ventana, `/register`, `/authorize` y el consentimiento se rechazan; las conexiones aprobadas siguen funcionando.
5. Ver y revocar: `node src/cli.mjs remote-clients` y `node src/cli.mjs remote-revoke <clientId>`.

## 7. Repos administrados

Cada repo de `ZANA_GITHUB_REPOS` necesita el workflow de checks (`docs/checks-workflow.md`), que **agrega el operador**, y protección de `main` con checks requeridos y review requerida.

## 8. Operación

- Auditoría: `node src/cli.mjs remote-audit [limite] [missionId]`.
- Salud con detalle: `node src/cli.mjs remote-health`.
- Tickets: `node src/cli.mjs remote-tickets [missionId]` y `node src/cli.mjs remote-ticket-abandon <ticketId>` (queda auditado, categoría `operator`). Un ticket reclamado y no finalizado pasa solo a `ABANDONED` tras `ZANA_TICKET_CLAIM_TTL_MINUTES`. Si ese ticket (o cualquier otro, en cualquier estado) pidió cambios sobre un SHA (veredicto `REQUEST_CHANGES` o un lente con BLOCKER/CRITICAL), el autor no puede pedir otro ticket sobre ese SHA (`CHANGES_REQUESTED_SAME_SHA`): esperar el TTL no lo libera. Solo `remote-ticket-abandon` lo libera, y solo para un ticket no finalizado y sin review publicada en GitHub; úsalo solo si el bloqueo fue un error de la revisora.
- **Reinicios:** las sesiones MCP viven en memoria. Un reinicio del servicio (o una sesión ociosa más de 2 h) corta los flujos: ChatGPT abre una sesión nueva. Como la autora completa su unidad **antes** de pedir el ticket, la espera de la review no depende de ningún lease. Si se corta a mitad de una unidad: con el lease vigente, `zana_session_rebind` la pasa a la sesión nueva sin consumir intento; con el lease vencido, `zana_recover_expired` → `zana_unit_retry` → `zana_start_batch`. Una revisora a medio camino no puede seguir con la sesión nueva (`NOT_REVIEWER`): el ticket queda para el TTL del claim o para `remote-ticket-abandon`, y el autor pide uno nuevo (si ese ticket ya tenía un BLOCKER sobre el SHA, rige la regla de arriba).
- Plazos: cada tool tiene un tope total de `ZANA_TOOL_DEADLINE_MS` (45 s por defecto) y la REST de GitHub un circuit breaker compartido (5 fallos seguidos lo abren 30 s).
- Merge del operador: `node src/cli.mjs remote-merge <missionId>` (mismas condiciones que `zana_merge`).
- Respaldo y restore de la DB de misiones: igual que en stdio (`docs/sqlite-storage.md`). El ledger OAuth (`ZANA_OAUTH_DB`) es un archivo aparte: respaldarlo junto a la DB; un restore de misiones no lo toca.
- Logs: `journalctl --user -u zanallaima`. Nunca contienen tokens.
- Rollback: `git checkout <SHA anterior>`, `npm ci`, `systemctl --user restart zanallaima`. La DB v7 no se puede abrir con una versión que solo entiende v6: respaldarla antes de subir de versión.
