#!/usr/bin/env bash
# REEA-37 QA verification against the deployed URL (AC-1..AC-4, AC-6).
# Usage: BASE=https://reemco.vercel.app bash scripts/verify-deployed-funnel.sh
set -u
B="${BASE:-https://reemco.vercel.app}"
pass=0; fail=0
ok(){ echo "PASS $1"; pass=$((pass+1)); }
no(){ echo "FAIL $1"; fail=$((fail+1)); }

# 1) full funnel batch (catalog item id from the seeded feed)
R=$(curl -s -X POST $B/api/events -H 'content-type: application/json' -d '{"events":[
 {"type":"search_submitted","query":"wireless mouse","result_count":3},
 {"type":"result_impressed","query":"wireless mouse","rank":0,"item_id":"logitech-pro-x-tkl"},
 {"type":"item_clicked","query":"wireless mouse","rank":0,"item_id":"logitech-pro-x-tkl","outbound_url":"https://www.amazon.com/dp/B09HM94VDS"},
 {"type":"zero_results","query":"zzzqx"}
]}')
echo "$R" | grep -q '"accepted":4' && ok "AC-1/2 funnel batch accepted" || no "funnel batch: $R"

# 2) privacy: no Set-Cookie on ingestion
SC=$(curl -s -D - -o /dev/null -X POST $B/api/events -H 'content-type: application/json' -d '{"type":"zero_results","query":"ck"}' | grep -ci "set-cookie")
[ "$SC" = "0" ] && ok "AC-3 no set-cookie" || no "AC-3 set-cookie present"

# 3) report reconciliation
REP=$(curl -s "$B/api/events/report?days=7")
echo "report: $REP"
echo "$REP" | jq -e '.searches >= 1 and .click_outs >= 1 and .zero_results >= 1 and .click_out_rate != null and .zero_result_rate != null and (.top_queries|length) >= 1' >/dev/null \
  && ok "AC-4 report reconciles" || no "AC-4 report: $REP"

# 4) hardening negatives
CT=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/api/events -H 'content-type: text/plain' -d '{}')
[ "$CT" = "415" ] && ok "AC-6 415 non-JSON" || no "AC-6 content-type: $CT"
head -c 20001 /dev/zero | tr '\0' 'a' > /tmp/big.json
BIG=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/api/events -H 'content-type: application/json' --data-binary @/tmp/big.json)
[ "$BIG" = "413" ] && ok "AC-6 413 oversized" || no "AC-6 oversized: $BIG"
MAL=$(curl -s -X POST $B/api/events -H 'content-type: application/json' -d '{"type":"search_submitted","query":"x"}' | grep -c '"rejected":1')
[ "$MAL" = "1" ] && ok "AC-6 malformed rejected" || no "AC-6 malformed"
RL="0"
for i in $(seq 1 130); do C=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/api/events -H 'content-type: application/json' -d '{"type":"zero_results","query":"rl"}'); [ "$C" = "429" ] && RL=1; done
[ "$RL" = "1" ] && ok "AC-6 rate limit 429" || no "AC-6 rate limit never hit"

echo "----"; echo "PASS=$pass FAIL=$fail"
[ "$fail" = "0" ]
