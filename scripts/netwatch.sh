#!/bin/sh
# netwatch.sh — probe the router, the internet and api.telegram.org; 60 s cadence, 30 s while either target is failing.
# Logs one line per probe plus DOWN / RECOVERED events (outage length = first failed probe -> first good one,
# so resolution is the fast interval). UTC timestamps. Usage: scripts/netwatch.sh [logfile]
OUT=${1:-logs/net/netwatch.log}
ROUTER=${NETWATCH_ROUTER:-192.168.0.1}
INTERNET=${NETWATCH_INTERNET:-1.1.1.1}
TELEGRAM=${NETWATCH_TELEGRAM:-https://api.telegram.org/}  # HTTPS, so it sees path/TLS trouble a ping to 1.1.1.1 can't
SLOW=${NETWATCH_SLOW:-60}   # seconds between probes while healthy
FAST=${NETWATCH_FAST:-30}   # seconds between probes while any target is down
MAX=${NETWATCH_MAX:-0}      # stop after N rounds (0 = run forever; for tests)
mkdir -p "$(dirname "$OUT")"

down_router=; down_internet=; down_telegram=

# Each probe prints the round-trip in ms on success and nothing on failure.
probe_ping() { ping -c 1 -W 2000 "$1" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p'; }
probe_http() { curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' "$1" 2>/dev/null | awk '$1 != "000" { printf "%.1f", $2 * 1000 }'; }

check() { # name probe target
  rtt=$("$2" "$3")
  eval d=\$down_$1
  if [ -n "$rtt" ]; then
    echo "$now $1 up ${rtt}ms"
    if [ -n "$d" ]; then echo "$now $1 RECOVERED outage=$((s - d))s"; eval down_$1=; fi
  else
    echo "$now $1 FAIL"
    if [ -z "$d" ]; then echo "$now $1 DOWN"; eval down_$1=$s; fi
  fi
}

n=0
while :; do
  now=$(date -u +%FT%TZ); s=$(date +%s)
  { check router probe_ping "$ROUTER"; check internet probe_ping "$INTERNET"; check telegram probe_http "$TELEGRAM"; } >> "$OUT"
  n=$((n + 1)); [ "$MAX" -gt 0 ] && [ "$n" -ge "$MAX" ] && break
  if [ -n "$down_router$down_internet$down_telegram" ]; then sleep "$FAST"; else sleep "$SLOW"; fi
done
