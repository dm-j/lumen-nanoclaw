#!/bin/sh
# netwatch.sh — probe the router and the internet; 60 s cadence, 30 s while either target is failing.
# Logs one line per probe plus DOWN / RECOVERED events (outage length = first failed probe -> first good one,
# so resolution is the fast interval). UTC timestamps. Usage: scripts/netwatch.sh [logfile]
OUT=${1:-logs/net/netwatch.log}
ROUTER=${NETWATCH_ROUTER:-192.168.0.1}
INTERNET=${NETWATCH_INTERNET:-1.1.1.1}
SLOW=${NETWATCH_SLOW:-60}   # seconds between probes while healthy
FAST=${NETWATCH_FAST:-30}   # seconds between probes while any target is down
MAX=${NETWATCH_MAX:-0}      # stop after N rounds (0 = run forever; for tests)
mkdir -p "$(dirname "$OUT")"

down_router=; down_internet=

check() { # name host
  rtt=$(ping -c 1 -W 2000 "$2" 2>/dev/null | sed -n 's/.*time=\([0-9.]*\) ms.*/\1/p')
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
  { check router "$ROUTER"; check internet "$INTERNET"; } >> "$OUT"
  n=$((n + 1)); [ "$MAX" -gt 0 ] && [ "$n" -ge "$MAX" ] && break
  if [ -n "$down_router$down_internet" ]; then sleep "$FAST"; else sleep "$SLOW"; fi
done
