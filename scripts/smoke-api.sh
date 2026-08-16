#!/usr/bin/env bash
set -euo pipefail
API_BASE="${API_BASE:-http://127.0.0.1:${API_HOST_PORT:-8080}}"
NEWS_INSTRUCTION="${NEWS_INSTRUCTION:-Open one top news article on news.google.com and summarize it concisely.}"

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

cleanup() {
  if [[ -n "${SSE_PID:-}" ]]; then
    kill "${SSE_PID}" >/dev/null 2>&1 || true
    wait "${SSE_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

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
  "timeoutSeconds": 300,
  "profilePolicy": "ephemeral",
  "maxArticles": 1,
}))
PY
)"
news_submit_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks" -H 'content-type: application/json' -d "${news_payload}")"
news_task_id="$(printf '%s' "${news_submit_json}" | python3 -c 'import json,sys; payload=json.load(sys.stdin); print(payload["taskId"] + "\n" + payload["progressUrl"] + "\n" + payload["transcriptUrl"])')"
NEWS_TASK_ID="$(printf '%s' "${news_task_id}" | sed -n '1p')"
NEWS_PROGRESS_URL="$(printf '%s' "${news_task_id}" | sed -n '2p')"
NEWS_TRANSCRIPT_URL="$(printf '%s' "${news_task_id}" | sed -n '3p')"
echo "news_task_id=${NEWS_TASK_ID}"
echo "news_progress_url=${NEWS_PROGRESS_URL}"
echo "news_transcript_url=${NEWS_TRANSCRIPT_URL}"

SSE_FILE="/tmp/pi-computer-news-events.$$"
: > "${SSE_FILE}"
curl -fsS -N --max-time 240 "${API_BASE}/v1/tasks/${NEWS_TASK_ID}/events" > "${SSE_FILE}" &
SSE_PID=$!

live_progress_seen="0"
for _ in $(seq 1 120); do
  news_state="$(curl -fsS "${API_BASE}/v1/tasks/${NEWS_TASK_ID}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')"
  progress_text="$(curl -fsS "${API_BASE}${NEWS_PROGRESS_URL}")"
  transcript_text="$(curl -fsS "${API_BASE}${NEWS_TRANSCRIPT_URL}")"
  if grep -Eq 'Pi called|Pi received|Pi:' <<<"${progress_text}" && grep -q 'event: pi.progress' "${SSE_FILE}"; then
    if [[ "${news_state}" == "succeeded" || "${news_state}" == "failed" || "${news_state}" == "cancelled" || "${news_state}" == "expired" ]]; then
      echo "task completed before transcript progress was observed live" >&2
      exit 1
    fi
    live_progress_seen="1"
    echo "live transcript-backed progress observed before completion"
    break
  fi
  if [[ "${news_state}" == "succeeded" || "${news_state}" == "failed" || "${news_state}" == "cancelled" || "${news_state}" == "expired" ]]; then
    echo "task reached terminal state before transcript-backed progress became visible" >&2
    printf '%s\n' "${progress_text}" >&2
    printf '%s\n' "${transcript_text}" >&2
    exit 1
  fi
  sleep 1
done

if [[ "${live_progress_seen}" != "1" ]]; then
  echo "did not observe transcript-backed live progress" >&2
  exit 1
fi

news_status_json="$(poll_task "${NEWS_TASK_ID}" 300)"
printf '%s' "${news_status_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["runner"]["kind"] == "pi_harness", d; assert d["runner"]["mcpConfigMode"] == "ambient_discovery", d; assert d["runner"]["transcriptMirror"], d; assert d["result"]["runner"] == "pi_harness", d; assert d["result"]["articleCount"] >= 1, d; assert len(d["result"]["artifactIds"]) >= 4, d; print("news_artifact_ids=" + ",".join(d["result"]["artifactIds"]))'

final_progress="$(curl -fsS "${API_BASE}${NEWS_PROGRESS_URL}")"
final_transcript="$(curl -fsS "${API_BASE}${NEWS_TRANSCRIPT_URL}")"
grep -Eq 'Pi called|Pi received|Pi:' <<<"${final_progress}"
grep -q '"type":"message"' <<<"${final_transcript}"
grep -q 'event: pi.progress' "${SSE_FILE}"

echo "checking cancel endpoint on completed task is safe/idempotent"
cancel_json="$(curl -fsS -X POST "${API_BASE}/v1/tasks/${NEWS_TASK_ID}/cancel")"
printf '%s' "${cancel_json}" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"] == "succeeded", d; print("cancel_completed_state=" + d["state"])'

echo "api smoke passed"
