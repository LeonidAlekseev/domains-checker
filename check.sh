#!/bin/bash
# Check .ru domain availability. Names from stdin (space/comma/newline separated, without ".ru").
#   Stage 1: DNS NS via 1.1.1.1, 40 parallel -> has NS = taken-delegated.
#   Stage 2: registry whois via whois.ru, only for the rest -> catches registered-but-undelegated.
# Output (sorted): FREE name | taken-delegated name | taken-whois name (STATE) | ERR name (whois didn't answer, re-run)
# Usage: echo "teef zvom" | ./check.sh      ./gen.sh CVCV | ./check.sh > result.txt
# Needs: bash, dig (dnsutils/bind-utils), curl.
# WHOIS_P: whois threads. whois.ru shows a captcha after a few thousand fast requests; keep it low.
WHOIS_P=${WHOIS_P:-2}
q(){ s=$(dig NS "$1.ru" @1.1.1.1 +time=3 +tries=2 | grep -o 'status: [A-Z]*' | cut -d' ' -f2); [ "$s" = NOERROR ] && echo "taken-delegated $1" || echo "check $1"; }
w(){ n=$1; for i in 1 2 3; do o=$(curl -s -m 20 "https://whois.ru/$n.ru" | sed 's/<[^>]*>/\n/g')
    if echo "$o" | grep -q "свободен"; then echo "FREE $n"; return
    elif s=$(echo "$o" | grep -m1 "state:"); then echo "taken-whois $n ($(echo $s | cut -d: -f2 | xargs))"; return
    elif echo "$o" | grep -q "защиту от роботов"; then echo "captcha: whois.ru blocked, stop and retry later" >&2; echo "ERR $n"; return; fi
    sleep 2; done; echo "ERR $n"; }
export -f q w
tmp=$(mktemp)
tr ' ,' '\n\n' | tr 'A-Z' 'a-z' | grep -xE '[a-z0-9-]+' | sort -u | xargs -P 40 -I{} bash -c 'q {}' > "$tmp"
{ grep ^taken "$tmp"; grep ^check "$tmp" | awk '{print $2}' | xargs -P "$WHOIS_P" -I{} bash -c 'w {}'; } | sort
rm -f "$tmp"
