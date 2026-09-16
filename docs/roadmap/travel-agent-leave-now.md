# `Travel` agent + "leave now" reminders

Discussed 2026-09-16, not started. Follows on from the `routine` agent's
existing pre-event boop/verify pattern ([routine-agent.md](routine-agent.md)) —
this extends it to travel-time-aware departure reminders, which Routine can't
do alone since it has no travel-time calculation tool.

## Decided shape

- New specialist agent, **`Travel`**, domain-scoped (per the
  monotask-agent-domain-lesson memory — scope it to the domain "Travel," not
  a single task like "departure-time calc").
- Routine still owns the calendar read + event lifecycle (existing boop/verify
  tasks). It collaborates with Travel for the travel-time math rather than
  doing it itself.
- Sequence for an off-site event:
  1. Routine identifies an event with a physical location (already has this
     off-site/on-site distinction from the boop logic).
  2. Routine asks Travel to calculate travel time to the event location.
  3. Travel adds a configurable offset (buffer) to the raw travel time.
  4. A scheduled check fires at (event start − travel time − offset) to
     double-check the estimate (traffic conditions change) before committing
     to the "leave now" notification.
  5. On confirmation, notify Lumen with the "leave now" message (mirrors the
     existing boop delivery convention — `send_message(to="Lumen")`, never
     directly to David).
  6. Separately, keep the existing boop cadence: 5 minutes before departure
     time, and at meeting start — same pattern as the existing pre-event
     boop/verify tasks, just anchored to *leave time* instead of *event
     start* for the first one.

## Open / undecided

- Travel-time data source — no travel-time API/tool wired yet (needs its own
  research: Google Maps Distance Matrix, Apple Maps, etc. — check OneCLI
  vault for an existing credential before adding a new one).
- Default offset/buffer value, and whether it's static or itself
  travel-mode-dependent (driving vs. walking vs. transit).
- Exact task-scheduling mechanism: likely mirrors the existing
  `calendar-boop-*`/`calendar-verify-*` one-shot task pattern
  (`ncl tasks create`, per-event, self-created idempotently), but the
  double-check step adds a third task type — needs its own naming/dedup
  convention.
- Whether this whole step sequence (calculate → offset → double-check →
  notify → boop) is worth encoding as a **Skill** so an agent can step
  through it deterministically rather than improvising the sequence each
  time from prose instructions alone — raised as a possibility 2026-09-16,
  not decided.
- Destinations/wiring: Travel needs a wired path to Routine (bidirectional,
  like Computation/Dispatcher) and Routine needs a wired path to Lumen (this
  already exists as of the boop/verify work).

## Addendum 2026-09-16: OneCLI proxy access from host-side mcp-shims

Started on `mcp-shims/lib/mapbox.ts` as prep (no Mapbox key yet) — used a
`MANAGED_BY_ONECLI` dummy in the `access_token` query param, same convention
`container/skills/onecli-gateway/SKILL.md` documents for connected apps, on
the assumption OneCLI's proxy substitutes the real value at egress by host
match.

That substitution only fires if the *process making the request* is running
with OneCLI's proxy env injected. mcp-shims scripts run **host-side** (not
in-container — see `docs/skill-engine-seam.md`'s host-shim CLI transport),
and are invoked directly by NanoClaw's host process, not through any
OneCLI wrapper today.

The OneCLI gateway itself already runs in Docker on this box (container
`onecli`, `127.0.0.1:10254-10255`). The host does have a path to use it:
`onecli run -- <command>` wraps a command with the gateway's env injected
(`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/etc. —
confirmed via `onecli run --dry-run -- echo test`). Not yet wired into how
the host actually spawns mcp-shims scripts.

Open: whether to wrap every mcp-shims script invocation in `onecli run`
(host-shim exec path in `src/modules/host-shim/exec.ts` / wherever
mcp-shims scripts get spawned), or just set the proxy env vars once on the
long-lived NanoClaw host process itself and skip the per-call wrapper.
Needs its own investigation — not blocking `Travel` agent design work, but
blocking that agent's Mapbox calls from actually resolving a real
credential once one exists.
