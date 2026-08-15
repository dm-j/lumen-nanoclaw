# Container runner as a pluggable interface

## What was decided (2026-08-15)

Today, `container-runner.ts` both decides *when* a container is needed and *how* to get one running, and "how" is hardcoded to shelling out to a local `docker`/`container` CLI binary. The user wants to split those: a small `ContainerRunner` interface the host talks to (`ensure(sessionId, config) → address`, roughly), with today's local-Docker behavior as one implementation of it — not the only possible one.

The motivating shape discussed: a tiny standalone runner service that registers itself with the host and waits for work, rather than the host reaching out and spawning a process directly. That registration model is what makes a runner on a different machine ("some rando environment", multiple systems) plausible — the host doesn't need to know how to reach the runner, the runner announces itself and pulls work.

## Why session-sync has to land first

This isn't a coincidence of timing — it's a dependency. [Session-sync WebSocket transport](../session-sync-transport.md) already removes the one thing that made "local" load-bearing: the bind-mounted session DBs. Once host and container talk exclusively over `wss://` with no shared filesystem, there's no remaining reason a container has to be on the same machine as the host. Building the runner-interface split before session-sync exists would mean solving "how does a remote container reach inbound.db/outbound.db" twice, once badly (mount-over-network, which is exactly the corruption problem session-sync exists to kill) and once for real.

`docs/session-sync-transport.md` §5 currently lists "remote container execution" as an explicit non-goal, with the reasoning: "Spawning itself (`container-runner.ts`) shells out to a local `docker`/`container` binary — a remote target needs a Docker remote context (SSH/TLS) or different orchestration entirely." This item is that follow-on work — once session-sync Phase 2+ is done, that non-goal becomes reachable.

## What's still open (not decided, needs real design work before building)

- **Interface shape.** Sketched only as "ensure a container is running for a session, return where to reach it" — no concrete method signatures, no decision on sync vs. async, no decision on how config (image, mounts, resource limits) crosses the interface boundary.
- **Registration protocol.** How a remote runner announces itself to the host, how the host verifies it's legitimate (same kind of auth-token problem session-sync's `secret.ts`/token refresh already solved once — likely reusable, not re-invented), what happens if a registered runner goes silent mid-session.
- **Liveness/ownership.** Today, `killContainer`+`onExit` guarantees the old container is gone before a new one spawns (see CLAUDE.md's Container Restart section) — that invariant gets harder to guarantee across a network boundary. Needs a real answer, not an assumption it still holds.
- **What crosses the boundary besides the DB sync channel.** CLAUDE.md's `groups/<folder>/` bind mount (skills, CLAUDE.md, working files), `.claude-shared`, `outbox/`/`inbox/` attachments are all still plain host bind mounts per session-sync-transport.md §5 — a remote runner needs an answer for all of these, not just the session DBs.
- **Whether local-Docker stays the only implementation for a while.** No concrete need for a second (remote) implementation yet — this could sit as "interface exists, one implementation" for a long time without anyone building the exotic case, and that's fine.

## Not started

No code exists for this yet. Depends on session-sync Phase 2 (container sync client) landing first — see [session-sync-transport.md](../session-sync-transport.md) §6.
