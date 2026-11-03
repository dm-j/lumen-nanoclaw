# Network reliability: Wi-Fi link, nightly router reboot, outage record

Investigated 2026-10-13, updated 2026-10-20. **Mostly improved by David's physical changes; follow-ups are optional.**

## What was wrong

Lumen was slow and dropped replies. Context size was ruled out (flat at 21–28k units). The cause was the local network:

- The Mac mini is on **2.4 GHz Wi-Fi** (`en1`, channel 3, 20 MHz); Ethernet `en0` has no cable. Housing is dense, with 10+ networks on every 2.4 GHz channel. A ping to the router one hop away averaged ~150 ms with peaks ~775 ms.
- That explained Telegram `getUpdates`/`sendMessage` network errors, a 4.6 s DNS lookup, spiky first-token times, ollama.com connection resets (`502 … connection reset by peer`) and two **permanently dropped replies** (Telegram send failed 3× in ~3 s, then given up). Telegram polling failures were already chronic before 2026-10-08.
- The **router rebooted nightly at 3 AM local (08:00Z)**, exactly when the hourly overnight tasks fire. That produced the 2026-10-12 08:03Z burst of instant 502s, a 180 s hung briefing compile, and the misleading `unrecognized_model` error from the Claude CLI.

## What changed (David, 2026-10-13)

- Bent the router's four antennae into different orientations: router ping fell from ~150 ms to ~12 ms.
- Moved the daily reboot off the on-the-hour tasks. It now happens around **09:43Z** (the router's own clock, probably fixed CST; it did not move with the 08:43Z he set). Measured outage: router down ~110–146 s, internet down ~146–180 s.
- PrefixRouter now logs non-2xx upstream bodies as `upstream_error`, so a bare 502 can be explained.

## Measured since (2026-10-13 → 10-20, `logs/net/netwatch.log`)

`scripts/netwatch.sh` runs as a launchd agent (`com.nanoclaw.netwatch`) and probes the router and 1.1.1.1 every 60 s, every 30 s while either fails, logging `DOWN` / `RECOVERED outage=NNs`.

- Router RTT: p50 7.6 ms, p95 24.9, p99 49.9. Internet: p50 13.7, p95 27.4, p99 51.2.
- ~0.9% (router) and ~1.1% (internet) of probes fail, almost all isolated single probes (`outage≈33 s` = one lost ping plus the 30 s interval).
- The only multi-minute outage each day is the nightly reboot.

## Open / next steps (and why)

1. **Still on 2.4 GHz.** Cheapest improvement: join the 5 GHz network (David spotted a quiet DFS channel 100; DFS channels can briefly drop clients if the router detects radar, so use `watch` data before/after, and fall back to channels 36–48). The Mac mini M4 also supports **6 GHz** (59 channels), the cleanest band in dense housing, if the router is 6E/Wi-Fi 7. *Why: any radio fix removes the intermittent 1% loss.*
2. **Wired Ethernet** is the lasting fix but the router sits where the AT&T cable enters (shared outlet with a fridge), so powerline is out. Options: a flat Ethernet cable run, or an access point near the Mac with a good backhaul. *Why: it takes the radio out of the path entirely.*
3. **Keep `netwatch` running** and check it after any router/band change; `RECOVERED outage=` gives recovery times directly.
4. See [Delivery retry window](delivery-retry-window.md): lengthening retries makes the nightly ~3-minute outage and short blips invisible to users, whatever the radio does.
5. Consider whether a nightly router reboot is needed at all; an old router that only offers weekly/daily schedules is why it is daily.

## Not decided

- Whether to switch the whole SSID to 5 GHz-only (IoT stays on a separate 2.4 GHz SSID for isolation and throttling; that is intentional).
- Whether to run a second watcher target (e.g. a Telegram or ollama.com endpoint) to separate router problems from ISP problems.

## Addendum 2026-11-03: Telegram polling failures with a healthy router

70 `Telegram polling request failed … Network error calling Telegram getUpdates` warnings between 2026-11-01 14Z and 2026-11-03 16Z, in bursts (44 single failures that recovered on the 1 s retry; the longest streak was 10 failures, about 3 minutes, around 06:25Z on 11-03, which is 00:25 local). `netwatch` showed router and 1.1.1.1 up through most of those bursts, so Wi-Fi/ICMP alone doesn't explain them. Fresh HTTPS connections to `api.telegram.org` from this Mac are fine (12/12, about 110 ms to connect), so the failures are on the 30 s long-poll. Polling keeps its update offset and retries, so messages are delayed, not lost; a 10-failure streak delays inbound by roughly 3 minutes.

Why we couldn't say more: the adapter logs `String(error)` and drops the socket error underneath. Two diagnostics were added so the next bursts can be explained:

- `src/channels/telegram.ts` logs `Telegram fetch failed` with the API method, `durationMs` and the socket `cause` code (ECONNRESET, connect timeout, …). Short durations point at refused/unroutable connections; about 30 s at a dropped long-poll (NAT or Wi-Fi idle drop).
- `scripts/netwatch.sh` has a third probe, an HTTPS request to `api.telegram.org` (this is the "second watcher target" listed under "Not decided" above). A `telegram DOWN` with router and internet up is a Telegram-path problem; all three down is the link.

To read it: `grep "Telegram fetch failed" logs/nanoclaw.error.log` and `grep telegram logs/net/netwatch.log | grep -E "DOWN|RECOVERED"`.
