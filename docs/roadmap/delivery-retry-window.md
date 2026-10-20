# Delivery retry window: stop short network outages from dropping replies

Proposed 2026-10-13, written up 2026-10-20. **Not built, not yet approved.**

## The problem

`src/delivery.ts` retries a failed channel delivery `MAX_DELIVERY_ATTEMPTS = 3` times, about 1.3 s apart, then gives up permanently ("Message delivery failed permanently"). Any network outage longer than ~3 seconds loses the reply for good. This happened at least twice on 2026-10-13 (02:15Z and 02:49Z, `msg-1791857699401-sqghoz` and `msg-1791859748752-8wim52`): both Telegram `sendMessage` `NetworkError`s while the Wi-Fi link was bad. The nightly router reboot (~3 minutes, see [network reliability](network-reliability.md)) would drop anything delivered during it.

## Proposed change

Retry network-class errors (not 4xx rejections) with growing gaps over a window of roughly **5–10 minutes** (e.g. 6+ attempts, exponential back-off capped around a minute), and keep the current fast give-up for errors that retrying cannot fix. A reply then arrives late instead of never. Review how the retry state is stored (`attempts` on the delivery row) so a host restart mid-window does not reset or lose it.

## Why

It is independent of fixing the radio: it protects against every short outage (reboot, ISP blip, Telegram hiccup) at the cost of a delayed reply. A late reply at 3 AM is fine; a silent drop is what David noticed ("Lumen takes a long time and doesn't respond reliably").

## Open

- Exact window and back-off (5–10 min proposed).
- Whether to tell the sender when a delivery is retrying for a long time.
- Whether the same treatment should apply to inbound media download (`getFile` also failed during bad periods).
