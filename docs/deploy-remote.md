# Instalación del modo remoto, paso a paso

Esta guía deja ZanaLLaima funcionando como conector de la app de ChatGPT, desde cero. **La hace el operador**, o sea la persona dueña del servidor y de las cuentas. Ningún agente despliega, crea tokens ni edita el archivo de entorno.

> **Ningún valor real va en este repo.** Tu dominio, tus cuentas de GitHub, tus tokens y la clave del operador viven solo en el archivo de entorno del servidor (`zanallaima.env`, fuera del repo, `chmod 600`). En esta guía se usan marcadores como `<tu-dominio>` o `<cuenta-revisora>`.

## Qué vas a armar

```
App de ChatGPT ──MCP + OAuth──▶ https://zanallaima.<tu-dominio>/mcp ──túnel──▶ ZanaLLaima (loopback, puerto 8787)
                                                                       │
                                     GitHub MCP oficial ◀──token autor──┤
                                     API de GitHub      ◀──token revisora┘
```

- ZanaLLaima corre en tu servidor y escucha solo en loopback. Un túnel HTTPS lo publica en `https://zanallaima.<tu-dominio>/mcp`.
- La app de ChatGPT se conecta con OAuth. El registro es cerrado: solo entran las cuentas que tú das de alta en una ventana de tiempo.
- GPT escribe en GitHub con el **token autor**. La review la publica la **cuenta revisora**, con su propio token.

### Lo que necesitas

| Qué | Detalle |
| --- | --- |
| Un servidor Linux con systemd | Cualquier VPS o VM sirve, por ejemplo una VM de Oracle Cloud. 1 vCPU y 1 GB de RAM alcanzan. No necesita puertos abiertos: el túnel sale hacia afuera. |
| Node.js ≥22.16 y Git | En el servidor. |
| Un dominio con DNS en Cloudflare | Para el túnel. Sirve cualquier otro proxy HTTPS (Caddy, nginx), siempre que reenvíe al loopback IPv4 en el puerto 8787 y conserve el encabezado `Host`. |
| Dos cuentas de GitHub | La **autora** (puede ser la tuya) y la **revisora** (otra cuenta, solo para revisar). |
| ChatGPT con modo desarrollador | Para agregar conectores MCP propios. Qué planes lo permiten, y si dejan usar tools que escriben, depende de OpenAI: revisa su ayuda sobre *Developer mode*. |

## 1. Cuentas de GitHub y tokens

### 1.1 Cuenta autora

Es la cuenta con la que GPT hace commits, abre PR, dispara los checks y mergea. Crea un **token fine-grained** (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens), limitado solo a los repos que ZanaLLaima va a administrar, con estos permisos de repositorio:

| Permiso | Acceso | Para qué |
| --- | --- | --- |
| Contents | lectura y escritura | ramas, archivos, compare/diff y merge |
| Pull requests | lectura y escritura | abrir y editar el PR, leer reviews y comentarios, merge |
| Actions | lectura y escritura | `workflow_dispatch` del workflow de checks, runs y logs de jobs |
| Checks | lectura | check runs del SHA |
| Commit statuses | **lectura** | leer `zana/4r` en `zana_delivery_status` |
| Metadata | lectura | obligatorio |
| Issues | lectura y escritura | solo si agregas el toolset `issues` (para `add_issue_comment`) |

GitHub documenta algunos límites de los tokens fine-grained con la API de Checks. Si `zana_checks_status` responde 403 al leer los check runs, usa para la cuenta autora un token **classic** con el scope `repo`.

**No** le des Administration, Secrets, Variables, Webhooks ni Workflows. Sin el permiso *Workflows*, GitHub rechaza por su cuenta cualquier cambio en `.github/workflows`: es una segunda llave además de la política de ZanaLLaima.

Si los repos son de una organización, el *resource owner* del token es la organización y puede que un admin tenga que aprobarlo.

### 1.2 Cuenta revisora

Es una segunda cuenta de GitHub que **solo** publica reviews y el status `zana/4r`. Nunca hace commits en los PR que revisa: si los hace, `zana_delivery_status` responde `REVIEWER_IS_AUTHOR`.

1. Desde la cuenta dueña del repo, invítala como colaboradora con permiso **Write**. Sin acceso de escritura su aprobación no cuenta para la protección de la rama. Acepta la invitación desde la cuenta revisora.
2. Crea su token:
   - **La revisora es miembro de la organización dueña del repo:** token fine-grained con la organización como *resource owner* y los permisos *Pull requests* lectura y escritura, *Commit statuses* lectura y escritura, *Contents* lectura y *Metadata* lectura.
   - **Cualquier otro caso** (repo de una cuenta personal ajena, o la revisora es *outside collaborator* de la organización): los tokens fine-grained no alcanzan repos donde solo eres colaboradora, así que hace falta un token **classic** con el scope `repo`. Es más amplio: dale vencimiento y guárdalo solo en el servidor.

### 1.3 Clave del operador

Es la clave que escribes en la página de consentimiento OAuth cuando das de alta una cuenta de ChatGPT. Genérala en el servidor y guárdala en tu gestor de contraseñas:

```sh
openssl rand -base64 36
```

## 2. Preparar cada repo administrado

Cada repo que GPT va a tocar necesita tres cosas, y **las haces tú** (ZanaLLaima nunca escribe en `.github/workflows/**`):

1. **El workflow de checks**: copia la plantilla de [checks-workflow.md](checks-workflow.md) a `.github/workflows/zana-checks.yml` y adapta los pasos al lenguaje del repo. Tiene que aceptar `workflow_dispatch`; no le agregues `push` ni `pull_request`, para que cada misión gaste una sola corrida.
2. **Protección de la rama default** (Settings → Branches o Rulesets):
   - exigir PR antes de mergear, con 1 aprobación;
   - exigir que los checks de `zana-checks` estén verdes (si el repo también recibe PR que no son de ZanaLLaima, mira la nota de [checks-workflow.md](checks-workflow.md) para que no queden esperando un check que nadie corre);
   - exigir aprobación del último push y que se resuelvan las conversaciones.
3. **Agregarlo a `ZANA_GITHUB_REPOS`** en el paso 4.

Para la primera prueba conviene un repo sandbox vacío con un `package.json` y un test.

## 3. Instalar el código en el servidor

Usa un usuario sin privilegios (en los ejemplos, `<usuario>`):

```sh
git clone https://github.com/<dueño>/ZanaLLaima /home/<usuario>/zanallaima
cd /home/<usuario>/zanallaima
git checkout <tag o SHA revisado>
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`<dueño>` es el dueño de este repo, o tu fork.

## 4. Archivo de entorno

```sh
mkdir -p /home/<usuario>/.config/zanallaima /home/<usuario>/.local/share/zanallaima
chmod 700 /home/<usuario>/.config/zanallaima /home/<usuario>/.local/share/zanallaima
cp deploy/zanallaima.env.example /home/<usuario>/.config/zanallaima/zanallaima.env
chmod 600 /home/<usuario>/.config/zanallaima/zanallaima.env
```

Edítalo con un editor en el servidor, nunca en el repo ni en un chat. **Rutas absolutas, sin `~`**: systemd no expande `~`, y el servidor y la CLI se niegan a arrancar con rutas relativas.

| Variable | Obligatoria | Qué va |
| --- | --- | --- |
| `ZANA_PUBLIC_HOST` | sí | Tu hostname público, por ejemplo `zanallaima.<tu-dominio>`. Sin esto el servidor no arranca. |
| `ZANA_STATE_FILE` | sí | `/home/<usuario>/.local/share/zanallaima/state.json` |
| `ZANA_OAUTH_DB` | sí | `/home/<usuario>/.local/share/zanallaima/oauth.sqlite` |
| `ZANA_OAUTH_CONSENT_PASSWORD` | sí | La clave del paso 1.3 (32 caracteres o más). |
| `ZANA_GITHUB_REPOS` | sí | `owner/repo` separados por coma. GPT no puede tocar ningún otro. |
| `ZANA_DOWNSTREAM_GITHUB_TOKEN` | sí | Token de la cuenta autora (1.1). |
| `ZANA_REVIEWER_TOKEN` | sí | Token de la cuenta revisora (1.2). |
| `ZANA_REVIEWER_LOGIN` | sí | Login de GitHub de la cuenta revisora. No tiene valor por defecto: sin él el servidor no arranca, y `node src/cli.mjs remote-health` lo muestra como `degraded`. |
| `ZANA_HTTP_PORT` | no | Puerto local, 8787 por defecto. |
| `ZANA_REQUIRED_CHECKS` | no | Nombres de checks que deben estar verdes. Vacío = todos los check runs del SHA. |
| `ZANA_CHECKS_WORKFLOW` | no | Nombre del workflow de checks, `zana-checks.yml` por defecto. |
| `ZANA_MERGE_ENABLED`, `ZANA_MERGE_METHOD` | no | `true` y `squash` por defecto. |
| `ZANA_DISTINCT_REVIEWER_CLIENT` | no | `true` exige otro cliente OAuth para revisar (ver abajo). `false` por defecto. |
| `ZANA_TICKET_TTL_MINUTES`, `ZANA_TICKET_CLAIM_TTL_MINUTES`, `ZANA_TOOL_DEADLINE_MS` | no | Plazos; los valores por defecto están en el ejemplo. |
| `ZANA_REVIEW_MAX_DIFF_BYTES` | no | Tope del diff `base...sha` antes del ticket (`DIFF_TOO_LARGE`, sin excepción). 1800000 por defecto, rango 100000-1900000. |
| `ZANA_PR_LINE_BUDGET` | no | Presupuesto de líneas (adiciones + eliminaciones, sin lockfiles ni `.zanallaima.json`; `OVER_LINE_BUDGET`). 400 por defecto, rango 50-5000; solo `zana_budget_extend` lo sube por misión. |

**Independencia verificable (opcional).** Con `ZANA_DISTINCT_REVIEWER_CLIENT=true`, la conversación revisora tiene que usar **otro cliente OAuth registrado** que el que pidió el ticket y que todos los que actuaron en la misión. ZanaLLaima ve clientes OAuth, no cuentas: que sea otra cuenta de ChatGPT depende de que solo des de alta cuentas distintas. Con `false`, la revisión la hace el mismo GPT en una conversación nueva.

## 5. Servicio `systemd --user`

```sh
mkdir -p /home/<usuario>/.config/systemd/user
cp deploy/zanallaima.service /home/<usuario>/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zanallaima
loginctl enable-linger "$USER"     # que siga corriendo sin sesión abierta
curl -4 -s http://localhost:8787/health
```

La unidad espera el código en `~/zanallaima` y el entorno en `~/.config/zanallaima/zanallaima.env` (usa `%h`, que systemd sí expande). Si instalaste Node con `nvm`, systemd no lo encuentra con `/usr/bin/env node`, porque no carga el perfil del shell. En ese caso pon en `ExecStart` la ruta absoluta que da `command -v node`, por ejemplo `/home/<usuario>/.nvm/versions/node/v22.23.4/bin/node src/http.mjs`, y actualízala al cambiar de versión.

El `/health` local responde `200` con `{"status":"ok","mode":"remote","schemaVersion":7,"reviewerToken":"configured","staleTickets":0,...}`. Si la DB no abre, o falta un token o el login de la revisora, responde `503` con `"status":"degraded"` y la lista `problems`. Los logs están en `journalctl --user -u zanallaima` y nunca contienen tokens.

## 6. Publicarlo por HTTPS con Cloudflare Tunnel

En el servidor, con `cloudflared` instalado:

```sh
cloudflared tunnel login                      # autoriza tu dominio
cloudflared tunnel create zanallaima          # crea el túnel y su archivo de credenciales
cloudflared tunnel route dns zanallaima zanallaima.<tu-dominio>
```

Copia `deploy/cloudflared-zanallaima.yml.example` a `~/.cloudflared/config.yml`, completa el id del túnel, la ruta de credenciales y tu hostname, y deja el servicio de loopback IPv4 en el puerto 8787 tal como está escrito en el ejemplo. No uses `localhost`, que puede resolver a IPv6. Después instálalo como servicio. Con `sudo`, `cloudflared` no busca en tu `~/.cloudflared`, así que pásale la ruta:

```sh
sudo cloudflared --config /home/<usuario>/.cloudflared/config.yml service install
sudo systemctl start cloudflared
```

Comprueba desde afuera:

```sh
curl -s https://zanallaima.<tu-dominio>/health      # {"status":"ok",...} con poco detalle
curl -si https://zanallaima.<tu-dominio>/mcp | head -1   # 401 con WWW-Authenticate
```

Por el túnel `/health` solo expone `status`, `version`, `sessions` y `staleTickets`. El detalle completo queda en el `/health` local y en `node src/cli.mjs remote-health`.

## 7. Conectar la app de ChatGPT

El registro OAuth está cerrado por defecto. Para cada cuenta de ChatGPT que deba entrar:

1. **Abre la ventana de alta** en el servidor, por 1 a 60 minutos:
   ```sh
   cd /home/<usuario>/zanallaima
   node src/cli.mjs remote-enroll 15
   ```
2. **Activa el modo desarrollador** en ChatGPT: *Settings → Apps & Connectors → Advanced settings → Developer mode*. En workspaces Business, Enterprise o Edu puede que tenga que activarlo un admin. Los nombres de los menús pueden cambiar.
3. **Crea el conector**: *Settings → Apps & Connectors → Create*.
   - Nombre: `ZanaLLaima`.
   - URL del servidor MCP: `https://zanallaima.<tu-dominio>/mcp`.
   - Autenticación: OAuth.
4. **Consentimiento.** ChatGPT abre la página de ZanaLLaima. Comprueba que la alta la iniciaste tú, escribe una etiqueta para esta cuenta (por ejemplo `chatgpt-personal`) y la clave del operador.
5. Repite los pasos 3 y 4 con cada cuenta adicional mientras la ventana siga abierta.
6. **Cierra la ventana**:
   ```sh
   node src/cli.mjs remote-enroll-close
   ```
   Fuera de la ventana se rechazan `/register`, `/authorize` y el consentimiento. Las conexiones ya aprobadas siguen funcionando.
7. Para ver y revocar clientes: `node src/cli.mjs remote-clients` y `node src/cli.mjs remote-revoke <clientId>`.

## 8. Primera prueba

1. En una conversación nueva, activa el conector (botón **+** → *More* → ZanaLLaima) y pide: "Con ZanaLLaima, muéstrame `zana_profile` y `zana_session_status`". Si responde, la conexión funciona.
2. Pide una misión chica en el repo sandbox, por ejemplo agregar una función `sum(a,b)` con su test. GPT carga la skill `zana-odd` y sigue el flujo.
3. Cuando GPT entregue un ticket `ZR-…`, abre **otra conversación nueva** y pega "Revisa el ticket ZR-… con ZanaLLaima".
4. Revisa en GitHub la review de la cuenta revisora sobre el SHA y el status `zana/4r`. Luego, en la conversación autora, pide el merge.

La prueba completa, con los casos negativos, está en [host-e2e-remote.md](host-e2e-remote.md).

## 9. CLI del operador

Todos los comandos `node src/cli.mjs ...` cargan el entorno del servidor de forma explícita:

- con `--env-file <ruta>`;
- o con `ZANA_ENV_FILE`;
- o, por defecto, `/home/<usuario>/.config/zanallaima/zanallaima.env` si existe. El archivo por defecto solo completa variables no definidas; uno explícito manda, y el por defecto avisa si `ZANA_STATE_FILE` o `ZANA_OAUTH_DB` del shell difieren de los suyos.

Cada `remote-*` exige solo la DB que usa, con ruta absoluta y ya existente, así que nunca crea una DB nueva por error:

- `remote-enroll`, `remote-enroll-close`, `remote-clients` y `remote-revoke` usan `ZANA_OAUTH_DB`;
- `remote-audit`, `remote-health`, `remote-tickets`, `remote-ticket-abandon` y `remote-merge` usan `ZANA_STATE_FILE`.

## 10. Operación

- **Auditoría:** `node src/cli.mjs remote-audit [limite] [missionId]`.
- **Salud con detalle:** `node src/cli.mjs remote-health`.
- **Tickets:** `node src/cli.mjs remote-tickets [missionId]` y `node src/cli.mjs remote-ticket-abandon <ticketId>`, que queda auditado con categoría `operator`.
  - Un ticket reclamado y no finalizado pasa solo a `ABANDONED` tras `ZANA_TICKET_CLAIM_TTL_MINUTES`.
  - Si un ticket pidió cambios sobre un SHA (veredicto `REQUEST_CHANGES`, o un lente con BLOCKER o CRITICAL que no sea `PREEXISTING`), el autor no puede pedir otro ticket sobre ese SHA (`CHANGES_REQUESTED_SAME_SHA`), y esperar el TTL no lo libera.
  - Al desplegar la versión con `origin`, un ticket `CLAIMED` cuya conversación tenga cacheado el esquema viejo de `zana_review_lens_submit` falla la validación: despliega sin tickets `CLAIMED` o abandónalos con `remote-ticket-abandon`.
  - Solo `remote-ticket-abandon` lo libera, y solo para un ticket no finalizado y sin review publicada. Úsalo solo si el bloqueo fue un error de la revisora.
- **Al desplegar la versión con sesión por conversación:** lo que quedó atado a sesiones de transporte no se migra. Una unidad `RUNNING` con lease vigente pasa a la conversación con `zana_session_rebind`; con el lease vencido, `zana_recover_expired` → `zana_unit_retry` → `zana_start_batch`. Los tickets `OPEN` o `CLAIMED` previos se abandonan con `remote-ticket-abandon`, y una misión con todas sus unidades completas antes del deploy se mergea con `remote-merge`.
- **Reinicios:** los transportes MCP viven en memoria, así que un reinicio del servicio, o un transporte ocioso más de 2 h, corta el flujo y ChatGPT abre uno nuevo. La sesión de ZanaLLaima sigue a la conversación de ChatGPT (`_meta["openai/session"]`), así que la misma conversación conserva su unidad `RUNNING` después de reconectar.
  - La autora completa su unidad **antes** de pedir el ticket, así que la espera de la review no depende de ningún lease.
  - Si se corta a mitad de una unidad con el lease vigente, `zana_session_rebind` la pasa a la sesión nueva sin consumir intento.
  - Si el lease venció: `zana_recover_expired` → `zana_unit_retry` → `zana_start_batch`.
  - Una revisora a medio camino no puede seguir con la sesión nueva (`NOT_REVIEWER`). El ticket queda para el TTL del claim o para `remote-ticket-abandon`, y el autor pide uno nuevo.
- **Plazos:** cada tool tiene un tope total de `ZANA_TOOL_DEADLINE_MS` (45 s por defecto). La REST de GitHub tiene un circuit breaker compartido: 5 fallos seguidos lo abren 30 s.
- **Merge del operador:** `node src/cli.mjs remote-merge <missionId>`, con las mismas condiciones que `zana_merge`.
- **Respaldo:** la DB de misiones se respalda y restaura igual que en stdio ([sqlite-storage.md](sqlite-storage.md)). El ledger OAuth (`ZANA_OAUTH_DB`) es un archivo aparte: respáldalo junto a la DB, porque un restore de misiones no lo toca.
- **Actualizar:** `git fetch && git checkout <SHA nuevo revisado>`, `npm ci --ignore-scripts --no-audit --no-fund`, `systemctl --user restart zanallaima`. Respalda la DB antes de subir de versión.
- **Rollback:** `git checkout <SHA anterior>`, `npm ci` y reinicio. La DB v7 no se puede abrir con una versión que solo entiende v6.

## Problemas comunes

| Síntoma | Causa probable |
| --- | --- |
| El servicio no arranca: `ZANA_PUBLIC_HOST ... must be set` | Falta el hostname público en el env. |
| El servicio no arranca: `ZANA_REVIEWER_LOGIN must be set` | Falta el login de la cuenta revisora. |
| `... must be set to an absolute path` | Una ruta con `~` o relativa en el env. |
| `/health` da `503 degraded` | Mira `problems` en `node src/cli.mjs remote-health`: token faltante o DB que no abre. |
| ChatGPT no puede registrar el conector | La ventana de alta está cerrada (`remote-enroll`) o la URL no termina en `/mcp`. |
| El túnel responde 404 | El `hostname` del ingress de `config.yml` no coincide con el DNS que creaste con `cloudflared tunnel route dns`. |
| ZanaLLaima responde 403 `Host not allowed` | `ZANA_PUBLIC_HOST` no coincide con el hostname del túnel. |
| El servicio no arranca: `... name different hosts` | `ZANA_PUBLIC_HOST` y `ZANA_PUBLIC_MCP_URL` apuntan a hosts distintos; basta con definir uno. |
| `zana_delivery_status` dice `REVIEWER_IS_AUTHOR` | La cuenta revisora tiene commits en el PR. |
| La review de la revisora no cuenta para la protección | La revisora no tiene permiso Write en el repo. |
