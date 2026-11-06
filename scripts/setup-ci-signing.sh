#!/usr/bin/env bash
# Configuración local: ejecutar solo por Zana. No mostrar llaves privadas.
set -euo pipefail
IFS=$'\n\t'
REPO='riquelmechile/ZanaLLaima'
ENVIRONMENT='ci-attestation'
REVIEWER='sebastianriquelme95-max'
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
KEY_DIR="$HOME/.config/zana-llaima"
PRIVATE_KEY="$KEY_DIR/ci-attest-private.pem"
OPERATOR_PUBLIC="$KEY_DIR/operator-public.pem"
if [[ -n "$(printenv ZANA_OPERATOR_PUBLIC_KEY_PATH || true)" ]]; then
  OPERATOR_PUBLIC="$ZANA_OPERATOR_PUBLIC_KEY_PATH"
fi
PUBLIC_FILE="$ROOT/keys/ci-verifier.pub"
TMP_PUBLIC=''
TMP_PRIVATE=''
fail() { printf 'Configuración CI rechazada: %s\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$TMP_PUBLIC" ]]; then rm -f -- "$TMP_PUBLIC"; fi
  if [[ -n "$TMP_PRIVATE" ]]; then rm -f -- "$TMP_PRIVATE"; fi
}
trap cleanup EXIT

if [[ "${1:-}" == '--dry-run' && "$#" -eq 1 ]]; then
  printf '%s\n' \
    'SIMULACIÓN: ningún archivo, llave, secreto ni configuración GitHub será modificado.' \
    '1. Validar pública del operador y que sea distinta de la pública CI.' \
    '2. Conservar la privada CI existente o generar Ed25519 local con modo 0600.' \
    '3. Desactivar atestación y restringir firmas a main con revisor independiente.' \
    '4. Cargar el secreto CI únicamente por stdin; no mostrar su contenido.' \
    '5. Publicar solo la llave pública keys/ci-verifier.pub.' \
    '6. Requerir aprobación humana antes de activar la atestación.'
  exit 0
fi
if [[ "$#" -ne 0 ]]; then fail 'Único argumento permitido: --dry-run'; fi
for program in openssl gh mktemp sha256sum chmod stat cut cmp grep mv mkdir; do
  command -v "$program" >/dev/null 2>&1 || fail "Falta comando requerido: $program"
done
[[ -f "$OPERATOR_PUBLIC" && ! -L "$OPERATOR_PUBLIC" ]] ||
  fail 'Falta llave pública válida del operador. Configurar ZANA_OPERATOR_PUBLIC_KEY_PATH.'
[[ -d "$ROOT/keys" && ! -L "$ROOT/keys" ]] ||
  fail 'Directorio keys/ inexistente o inseguro.'
# Inspección de públicas únicamente; nunca imprimir material privado.
operator_fp="$(openssl pkey -pubin -in "$OPERATOR_PUBLIC" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)" ||
  fail 'No se pudo validar la llave pública del operador.'
[[ "$operator_fp" =~ ^[[:xdigit:]]{64}$ ]] || fail 'Huella pública del operador inválida.'
umask 077
mkdir -p -- "$KEY_DIR"
if [[ -L "$PRIVATE_KEY" ]]; then fail 'La ruta de la llave CI no puede ser symlink.'; fi
if [[ ! -e "$PRIVATE_KEY" ]]; then
  # Generar, validar y mover sin sobrescribir. SIGKILL no deja una llave privada truncada.
  TMP_PRIVATE="$(mktemp "$KEY_DIR/.ci-private.XXXXXXXX")" ||
    fail 'No se pudo crear el temporal privado en KEY_DIR.'
  chmod 0600 "$TMP_PRIVATE"
  openssl genpkey -algorithm Ed25519 -out "$TMP_PRIVATE" >/dev/null ||
    fail 'Falló genpkey; revisar el sistema local y eliminar el temporal antes de reintentar.'
  openssl pkey -in "$TMP_PRIVATE" -noout >/dev/null 2>&1 ||
    fail 'Llave Ed25519 temporal inválida. No publicar ni cargar un secreto.'
  mv -n -- "$TMP_PRIVATE" "$PRIVATE_KEY" ||
    fail 'No se pudo mover llave CI temporal a su destino.'
  [[ ! -e "$TMP_PRIVATE" ]] || fail 'Otra llave CI apareció concurrentemente; no se sobrescribe.'
  TMP_PRIVATE=''
fi
[[ -f "$PRIVATE_KEY" && ! -L "$PRIVATE_KEY" ]] || fail 'Llave CI inválida.'
[[ "$(stat -c '%a' "$PRIVATE_KEY")" == '600' ]] ||
  fail 'La llave privada existente debe tener modo 0600; no se modifica automáticamente.'
TMP_PUBLIC="$(mktemp "$ROOT/keys/.ci-public.XXXXXXXX")"
chmod 0600 "$TMP_PUBLIC"
openssl pkey -in "$PRIVATE_KEY" -pubout -out "$TMP_PUBLIC" >/dev/null ||
  fail 'No se pudo derivar llave pública CI: comprobar PEM Ed25519, modo 0600 y regenerar localmente solo si está dañada.'
ci_fp="$(openssl pkey -pubin -in "$TMP_PUBLIC" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)" ||
  fail 'No se pudo calcular la huella pública CI.'
[[ "$ci_fp" =~ ^[[:xdigit:]]{64}$ ]] || fail 'Huella pública CI inválida.'
[[ "$ci_fp" != "$operator_fp" ]] ||
  fail 'La llave CI coincide con la del operador: firmantes deben ser distintos.'

# Desactivar antes de configurar. No se habilita automáticamente al terminar.
gh variable set ZANA_CI_ATTESTATION_READY --repo "$REPO" --body false >/dev/null
reviewer_id="$(gh api "users/$REVIEWER" --jq '.id')" ||
  fail 'No se pudo consultar al revisor independiente.'
[[ "$reviewer_id" =~ ^[0-9]+$ ]] || fail 'ID inválido de revisor.'
gh api --method PUT "repos/$REPO/environments/$ENVIRONMENT" \
  -F "reviewers[0][id]=$reviewer_id" \
  -f 'reviewers[0][type]=User' \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true' \
  -F 'prevent_self_review=true' >/dev/null
policy_api="repos/$REPO/environments/$ENVIRONMENT/deployment-branch-policies"
existing="$(gh api --paginate "$policy_api" --jq '.branch_policies[] | [.id,.name] | @tsv')"
while IFS=$'\t' read -r id policy; do
  [[ -z "$id" ]] && continue
  [[ "$id" =~ ^[0-9]+$ ]] || fail "ID de policy inválido: $id"
  if [[ "$policy" != main ]]; then
    gh api --method DELETE "$policy_api/$id" >/dev/null ||
      fail "No se pudo eliminar policy insegura: $policy"
  fi
done <<< "$existing"
verified="$(gh api --paginate "$policy_api" --jq '.branch_policies[].name')"
if ! grep -Fxq main <<< "$verified"; then
  gh api --method POST "$policy_api" -f 'name=main' -f 'type=branch' >/dev/null
fi
verified="$(gh api --paginate "$policy_api" --jq '.branch_policies[].name')"
[[ "$verified" == main ]] || fail "Branch policy insegura: $verified"
reviewers="$(gh api "repos/$REPO/environments/$ENVIRONMENT" \
  --jq '.protection_rules[] | select(.type=="required_reviewers") | .reviewers[]? | .reviewer.login')"
grep -Fxq "$REVIEWER" <<< "$reviewers" ||
  fail "El environment no requiere aprobación de $REVIEWER."
self_review="$(gh api "repos/$REPO/environments/$ENVIRONMENT" --jq '.prevent_self_review')"
[[ "$self_review" == true ]] || fail 'El environment permite self-review; no configurar la firma CI.'

# La llave privada se transmite al secreto exclusivamente por stdin.
gh secret set ZANA_CI_SIGNING_KEY --repo "$REPO" --env "$ENVIRONMENT" < "$PRIVATE_KEY" >/dev/null
chmod 0644 "$TMP_PUBLIC"
if ! cmp -s "$TMP_PUBLIC" "$PUBLIC_FILE"; then
  mv -f -- "$TMP_PUBLIC" "$PUBLIC_FILE"
  TMP_PUBLIC=''
fi
printf 'Huella SHA-256 de llave pública CI: %s\n' "$ci_fp"
printf '%s\n' \
  'Siguientes pasos:' \
  '1. Confirmar el reviewer requerido y la policy main-only del environment.' \
  '2. Commitear solo keys/ci-verifier.pub y ejecutar CI sobre el SHA nuevo.' \
  '3. Activar manualmente ZANA_CI_ATTESTATION_READY=true después de aprobar el código.' \
  '4. Comprobar artifact firmado y delivery-check; no realizar merge automático.'
