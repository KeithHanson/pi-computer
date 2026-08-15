#!/usr/bin/env bash
set -euo pipefail
API_BASE="${API_BASE:-http://127.0.0.1:${API_HOST_PORT:-8080}}"
TOKEN="${PI_COMPUTER_API_TOKEN:-local-dev-token-change-me}"
AUTH=( -H "Authorization: Bearer ${TOKEN}" )

echo "checking API health at ${API_BASE}/healthz"
curl -fsS "${API_BASE}/healthz" >/dev/null

echo "checking unauthenticated task API rejection"
unauth_code="$(curl -sS -o /tmp/pi-computer-api-unauth.json -w '%{http_code}' -X POST "${API_BASE}/v1/tasks" -H 'content-type: application/json' -d '{"taskType":"open_url","startUrl":"https://example.com/"}')"
if [ "${unauth_code}" != "401" ]; then
  cat /tmp/pi-computer-api-unauth.json >&2 || true
  echo "expected 401 for unauthenticated submit, got ${unauth_code}" >&2
  exit 1
fi

echo "submitting authenticated browser task"
submit_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks" "${AUTH[@]}" -H 'content-type: application/json' -d '{"taskType":"open_url","startUrl":"https://example.com/","instruction":"Open example.com for smoke validation.","timeoutSeconds":60,"profilePolicy":"ephemeral"}')"
task_id="$(printf '%s' "${submit_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["taskId"])')"
echo "task_id=${task_id}"

for _ in $(seq 1 60); do
  status_json="$(curl -fsS "${API_BASE}/v1/tasks/${task_id}" "${AUTH[@]}")"
  state="$(printf '%s' "${status_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
  echo "state=${state}"
  case "${state}" in
    succeeded) break ;;
    failed|cancelled|expired) printf '%s\n' "${status_json}" >&2; exit 1 ;;
  esac
  sleep 1
done
[ "${state}" = "succeeded" ] || { echo "task did not succeed" >&2; exit 1; }
printf '%s' "${status_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["artifacts"], d; assert d["result"]["artifactIds"], d; print("artifact_ids=" + ",".join(d["result"]["artifactIds"]))'

echo "checking authenticated SSE endpoint headers"
set +e
curl -sS -N --max-time 2 -D /tmp/pi-computer-api-sse.headers "${API_BASE}/v1/tasks/${task_id}/events" "${AUTH[@]}" -o /tmp/pi-computer-api-sse.body
sse_rc=$?
set -e
if [ "${sse_rc}" != "0" ] && [ "${sse_rc}" != "28" ]; then
  echo "SSE curl failed with ${sse_rc}" >&2
  cat /tmp/pi-computer-api-sse.headers >&2 || true
  exit 1
fi
grep -qi 'content-type: text/event-stream' /tmp/pi-computer-api-sse.headers

echo "checking cancel endpoint on completed task is safe/idempotent"
cancel_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks/${task_id}/cancel" "${AUTH[@]}")"
printf '%s' "${cancel_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"] == "succeeded", d; print("cancel_completed_state=" + d["state"])'

echo "api smoke passed"
