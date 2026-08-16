#!/usr/bin/env bash
set -euo pipefail
API_BASE="${API_BASE:-http://127.0.0.1:${API_HOST_PORT:-8080}}"
NEWS_INSTRUCTION="${NEWS_INSTRUCTION:-Open the top news articles on news.google.com and summarize their contents.}"

poll_task() {
  local task_id="$1"
  local attempts="${2:-120}"
  local state=""
  local status_json=""
  for _ in $(seq 1 "${attempts}"); do
    status_json="$(curl -fsS "${API_BASE}/v1/tasks/${task_id}")"
    state="$(printf '%s' "${status_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
    echo "task=${task_id} state=${state}" >&2
    case "${state}" in
      succeeded)
        printf '%s' "${status_json}"
        return 0
        ;;
      failed|cancelled|expired)
        printf '%s\n' "${status_json}" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  echo "task did not succeed: ${task_id}" >&2
  return 1
}

echo "checking API health at ${API_BASE}/healthz"
health_json="$(curl -fsS "${API_BASE}/healthz")"
printf '%s' "${health_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["piHarness"]["mcpConfigMode"] == "ambient_discovery", d; print("pi_harness_mcp_config=" + d["piHarness"]["mcpConfig"])'

echo "submitting open_url smoke task"
submit_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks" -H 'content-type: application/json' -d '{"taskType":"open_url","startUrl":"https://example.com/","instruction":"Open example.com for smoke validation.","timeoutSeconds":60,"profilePolicy":"ephemeral"}')"
open_task_id="$(printf '%s' "${submit_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["taskId"])')"
echo "open_task_id=${open_task_id}"
open_status_json="$(poll_task "${open_task_id}" 60)"
printf '%s' "${open_status_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["runner"]["kind"] == "browser_mcp_bridge", d; assert d["artifacts"], d; assert d["result"]["artifactIds"], d; print("open_url_artifact_ids=" + ",".join(d["result"]["artifactIds"]))'

echo "submitting Pi harness news summary task"
news_payload="$(python3 - <<'PY' "$NEWS_INSTRUCTION"
import json, sys
instruction = sys.argv[1]
print(json.dumps({
  "taskType": "news_browse_summary",
  "instruction": instruction,
  "timeoutSeconds": 180,
  "profilePolicy": "ephemeral",
  "maxArticles": 3,
}))
PY
)"
news_submit_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks" -H 'content-type: application/json' -d "${news_payload}")"
news_task_id="$(printf '%s' "${news_submit_json}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["taskId"])')"
echo "news_task_id=${news_task_id}"
news_status_json="$(poll_task "${news_task_id}" 180)"
printf '%s' "${news_status_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["runner"]["kind"] == "pi_harness", d; assert d["runner"]["mcpConfigMode"] == "ambient_discovery", d; assert d["result"]["runner"] == "pi_harness", d; assert d["result"]["articleCount"] >= 1, d; assert d["result"]["artifactIds"], d; print("news_artifact_ids=" + ",".join(d["result"]["artifactIds"]))'

echo "checking unauthenticated SSE endpoint headers"
set +e
curl -sS -N --max-time 2 -D /tmp/pi-computer-api-sse.headers "${API_BASE}/v1/tasks/${news_task_id}/events" -o /tmp/pi-computer-api-sse.body
sse_rc=$?
set -e
if [ "${sse_rc}" != "0" ] && [ "${sse_rc}" != "28" ]; then
  echo "SSE curl failed with ${sse_rc}" >&2
  cat /tmp/pi-computer-api-sse.headers >&2 || true
  exit 1
fi
grep -qi 'content-type: text/event-stream' /tmp/pi-computer-api-sse.headers

echo "checking cancel endpoint on completed task is safe/idempotent"
cancel_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks/${news_task_id}/cancel")"
printf '%s' "${cancel_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"] == "succeeded", d; print("cancel_completed_state=" + d["state"])'

echo "api smoke passed"
