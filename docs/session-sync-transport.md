# Session Sync Transport — Investigation, Design, and Status

Why `container_configs.transport` exists, what was actually tried and ruled out before landing on it, and the design decisions for the parts not yet built — so this isn't re-investigated or re-decided from scratch later.

Related: [db.md §4](db.md#4-cross-mount-visibility) (the problem this replaces), [db-session.md](db-session.md) (today's `'file'` transport, still the default).

---

## 1. The problem

`inbound.db`/`outbound.db` are bind-mounted into the container so both host and container can open them. On macOS, this corrupts: `SqliteError: attempt to write a readonly database`, `database disk image is malformed`, recurring in production (`logs/nanoclaw.error.log`) across many sessions over weeks.

## 2. What was tried and ruled out (do not re-attempt without new information)

All four were verified empirically, not assumed — see chat history around 2026-08-13 for the full test transcripts if the reasoning here needs re-auditing.

| Approach | Result | Why |
|---|---|---|
| Docker named volumes (container-only storage) | Rejected before building | Host process (`session-manager.ts`) opens these files natively via `better-sqlite3` — a named volume has no host filesystem path at all on macOS (lives inside the Docker Desktop VM). Would require dockerizing the host itself. |
| Docker `--opt type=nfs` local volume, backed by macOS `nfsd` | Never actually worked | Docker Desktop 4.66's volume driver doesn't route `type=nfs` to a real NFS mount at all — every attempt went through Docker's own proprietary volume-backing layer (`backingFsBlockDev`/`metadata.db`, visible in the VM console log), confirmed by zero packets ever reaching `nfsd` on port 2049. True with `UseContainerdSnapshotter` both on and off. Architectural in this Docker Desktop version, not a config problem. |
| Consistency mount flags (`:cached`/`:delegated`) | Ruled out without testing | Legacy osxfs-only flags; no-ops under VirtioFS (Docker's default since 4.6+), which this install uses. |
| Apple Container (native macOS runtime, `container` CLI) | Fails the same class of problem | Stress-tested directly (bypassing Docker/NanoClaw entirely): a bidirectional read/write pattern matching real `inbound.db`/`outbound.db` traffic failed 3/3 runs (`unable to open database file`, `disk I/O error`). Apple Container uses its own VM-per-container VirtioFS-family mount — different implementation, same failure class. No corruption in these runs (`integrity_check` stayed `ok`), but the container process crashed every time. |

**What *is* proven safe**: a plain Docker-internal volume (`docker volume create`, no special driver options, never mounted on the host side at all) survived sustained hammering and a hard `SIGKILL` mid-write across 3 repeated trials — `integrity_check: ok` every time, zero data loss beyond the last committed row. The distinguishing factor across every test: **corruption only happens when the host filesystem-sharing layer (VirtioFS or NFS-over-Docker) is involved at all.** A file that never crosses that boundary is fine, on any runtime.

## 3. The design that follows from that

Don't fight the mount — remove it. Each side gets its own local, never-shared SQLite database; a sync channel reconciles them.

- **Host**: `inbound.db`/`outbound.db` stay exactly as they are today — host-native, host-only-opened, unchanged schema. Never mounted into the container again.
- **Container**: its own local SQLite on a plain Docker volume (the proven-safe kind above) — sole writer, sole reader, entirely internal to the container's own storage.
- **A WebSocket carries synced rows, not file access.** Each side commits locally first (durable immediately, no dependency on the peer being reachable), then pushes the new row to the other side, which commits its own copy and acks. This is what actually closes the durability gap a naive "container calls host, host is the only durable copy" design would have — see reasoning in chat history 2026-08-13, "SQLite has the virtue of durability" thread.
- **Hash-chain checksum**: `chain[n] = hash(chain[n-1] + canonicalize(payload[n]))`, one column, computed independently by whichever side wrote the row. Receiver verifies the chain as it applies each synced row; on mismatch, it sends back its last-known-good `(seq, chain)` and the sender replays from there using its own durable local copy. Implemented in `src/session-sync/protocol.ts` (host) and the container mirror, unit-tested.
- **Reconnect/resync**: "sync me everything since seq X," reusing the existing even/odd (host/container) seq-parity namespace — no new protocol concept.
- **Per-group opt-in**: `container_configs.transport` (`'file'` default, `'sync'` opt-in), materialized into `container.json`. Linux hosts have no VirtioFS layer and no observed corruption — the intent is `'file'` stays the permanent default there, `'sync'` becomes the macOS default only once proven out.

## 4. Transport-layer decisions, priced in ahead of need

Prompted by a live design question: does replacing a shared file with a WebSocket also enable running the container on a separate machine, and — further out — could other host-provided capabilities (channel adapters, filesystem access) become similarly location-independent? Answer: session-sync *does* stop caring where the container runs, but nothing else does yet (see §5). Three decisions were made cheap now specifically because they'd be expensive to retrofit if that direction is ever pursued — everything else stays deferred (§5) since nothing concrete motivates building it.

1. **`wss://` only — no plain `ws://` code path exists at all**, not "disabled by config." Same-box today (self-signed cert is fine), but there's no insecure mode to accidentally carry forward if a socket is ever reached off-box.
2. **Per-connection auth is a signed token** (HMAC over `sessionId + expiry` with a per-install secret), not a bearer string compared with `===`. Verified on WS upgrade.
3. **Message envelope carries a `channel` tag** (`{ channel: string, body: unknown }`), even though Phase 1 only ever sends `channel: 'session-sync'`. Costs one field now; means a hypothetical second channel later multiplexes over the same connection/auth code instead of forcing a protocol migration.
4. **Connection/auth code is factored separately from sync-message handling** — `session-sync/transport.ts` (generic: connect, authenticate, envelope routing) vs. `session-sync/server.ts` / container-side `client.ts` (sync-specific: chain verification, resync, DB writes). Registered as a handler, not hand-rolled per-socket logic.

## 5. Explicitly deferred — do not build without a concrete driver

Noted so the idea isn't lost, and so it isn't quietly reinvented under time pressure either:

- **Remote container execution.** Session-sync becoming location-independent doesn't make the *system* location-independent — `groups/<folder>` (skills, CLAUDE.md, working files), `.claude-shared`, `outbox/`/`inbox/` attachments are all still plain host bind mounts, unaddressed by this design. Spawning itself (`container-runner.ts`) shells out to a local `docker`/`container` binary — a remote target needs a Docker remote context (SSH/TLS) or different orchestration entirely.
- **Host-provided capabilities as remote services** (Telegram/other channel adapters, filesystem access, etc. reachable from a separate machine over the same kind of channel). A real, coherent future direction — genuinely enabled by §4's envelope tag — but there is currently exactly one channel (`session-sync`) and no second use case driving a build. Building service discovery, a capability registry, or a second channel now would be speculative flexibility with no proven need.

## 6. Status

- **Phase 0 (scaffolding)**: done, merged to `main`. `container_configs.transport` column (migration 031), `ContainerConfig.transport`, `ncl groups config update --transport`, `src/session-sync/protocol.ts` + container mirror with tests. Nothing wired into a live spawn path — every existing group resolves to `'file'`, unchanged behavior.
- **Phase 1 (host WebSocket server)**: done, merged to `main`. `src/session-sync/secret.ts` (per-install HMAC secret, `data/session-sync/secret`), `src/session-sync/cert.ts` (self-signed TLS cert via the system `openssl` binary, cached alongside the secret), `src/session-sync/transport.ts` (generic `wss://`-only connection layer: `signToken`/`verifyToken`, `createSyncServer` — auth on upgrade via `Sec-WebSocket-Protocol`, channel-tagged envelope routing, connection registry, a per-connection token-refresh push over `AUTH_CHANNEL` at `tokenTtlMs / 2`; every server-side socket gets an `error` listener so a single flaky connection can't take the host process down via an unhandled EventEmitter `error`), `src/session-sync/server.ts` (session-sync-specific channel handler: resync-from-seq via a `resync_request`/`resync_point` handshake, chain verification through `protocol.ts`, applies synced `outbound`/`ack`/`ack_processing` rows into `outbound.db`). `nextChain`/`verifyChain` fold `seq` into the hash (not just the payload) — a message with a correct payload chain but a forged `seq` is rejected, since `seq` is the resync bookmark callers trust and must be as tamper-evident as the payload. The chain checkpoint is persisted into `outbound.db`'s own dedicated `session_sync_state` table (deliberately separate from the container-owned `session_state` table — see §7) after every applied message, not just held in memory — on cache-miss (e.g. after a host restart) it's re-derived from there, so a restart resumes from the real last-known `(seq, chain)` instead of resetting to `GENESIS_CHAIN` and forcing a full-history resync. Container-side mirror of the generic connection layer only: `container/agent-runner/src/session-sync/transport.ts` — originally Bun's native `WebSocket`, later swapped to the `ws` package once cert pinning (§6 Phase 2, below) showed Bun's client has no TLS options at all. Unit-tested standalone (`transport.test.ts`, `server.test.ts`, `protocol.test.ts`, including a simulated-restart resync test and a forged-seq rejection test); typechecked and tested for real on both host and container (`bun test`, `bun run typecheck`, `bun` 1.3.12 pinned to match `container/Dockerfile`). **Not wired into any live spawn path** — no `container.json` field carries the token/port yet, `container-runner.ts` is untouched, every group still runs `'file'` transport.
- **Phase 2 (container sync client + spawn wiring)**: protocol and connection machinery are done and tested on both sides; **the one piece left is the mount-flip + write-path rewrite** (below) — everything else in this phase is complete as of 2026-08-15.
  - **Host server startup: done.** `createSyncServer` is called unconditionally at host boot in `src/index.ts` (right after central-DB init), with `handlers['session-sync']` wired to `makeSessionSyncHandler(outboundDbPathFor)` — `outboundDbPathFor` resolves `sessionId` → `agent_group_id` via `getSession` (`src/db/sessions.ts`) then reuses `outboundDbPath` (`src/session-manager.ts`). Port: fixed default `58636` ("LUMEN" on a phone keypad) via `SESSION_SYNC_PORT` in `src/config.ts`, overridable in `.env`. Closed cleanly in `shutdown()`. Currently idle — no group has `transport: 'sync'` yet, so the listener accepts no real connections in production.
  - **Container sync client: done.** `container/agent-runner/src/session-sync/client.ts`'s `createSyncClient(outboundDb, applyInboundRow)` tracks chain state for *both* directions in one `session_sync_state` row in `outbound.db` (added to `connection.ts`'s forward-compat schema, mirroring `session_state`/`container_state`): outbound (container is chain authority — `pushOutbound`/`pushAck`/`pushSessionState`/`pushContainerState` compute `nextChain`, send, and resolve once the host acks) and inbound (host is chain authority — a host-pushed `'inbound'`-kind message is chain-verified before `applyInboundRow` runs, then acked or resync-pointed back). A restart re-derives both chains from the persisted row instead of resetting to genesis. `client.test.ts`: 6 tests.
  - **Host-to-container push path: done.** `src/session-sync/server.ts`'s `pushInboundRow(sessionId, ws, outboundDbPathFor, kind, payload)` is chain-authoritative for the host→container direction, symmetric to the container's outbound push — `session_sync_state` gained `inbound_seq`/`inbound_chain` columns (ALTERed forward-compat, since every session's `outbound.db` already had this table from Phase 1's schema). Resolves on the container's ack, rejects on a `resync_point`. `server.test.ts`: 3 new tests under `pushInboundRow`.
  - **Wired into the primary write path: done.** `writeSessionMessage` (`src/session-manager.ts`) calls `notifyInboundWrite` (`src/session-sync/inbound-push.ts`) after every insert — a no-op unless the group is on `'sync'` transport AND has a live connection. `registerSyncServer(syncServer)` wires the connection registry in from `src/index.ts`. **Scope**: only the router's chat-inbound path is covered — task-wake messages, `cli_request` inline replies, and agent-to-agent inbound also write `messages_in` but don't push yet (listed explicitly in `inbound-push.ts`'s header, not a silent gap). `inbound-push.test.ts`: 5 tests.
  - **Per-session credentials + container bootstrap: done.** `src/session-sync/session-credentials.ts` writes a per-**session** `.session-sync.json` (token/port/pinned cert) into the session's own directory — deliberately *not* part of `container.json`, which `materializeContainerJson` writes once per **agent group** and RO-bind-mounts into every container spawned for that group; a session-scoped token living there would be silently overwritten by a sibling session's spawn under any isolation mode allowing concurrent sessions in one group. `container-runner.ts` calls it right after `materializeContainerJson`, using `host.docker.internal` as the reachable address. Container-side `config.ts`/`credentials.ts`/`startup.ts` read `transport`, load the credentials, and call `connectSyncClient`/`createSyncClient`/`attach` at startup in `index.ts`'s `main()` — logging and continuing (never throwing) on any failure, so a misconfigured or unreachable sync connection can't prevent the container from starting. `session-credentials.test.ts` (3), `startup.test.ts` (9).
  - **Cert pinning: resolved** (unchanged from earlier). `connectSyncClient(url, token, pinnedCertPem, handlers)` passes `pinnedCertPem` as the connection's sole `ca` with `rejectUnauthorized: true`. Only the cert's **public half** ever reaches a container — `getInstallCert().cert`, never `.key`, which stays host-side in `data/session-sync/`.
  - **Auth token TTL: 15 minutes**, refresh already pushed over `AUTH_CHANNEL` at half that — the container tracks it via `SyncClient.currentToken()`, but nothing calls `connectSyncClient` again with it after a disconnect yet (see "Reconnect loop" below).
  - **What's actually left — the mount-flip + write-path rewrite.** Today, opting a group into `'sync'` transport changes nothing observable: the container still bind-mounts `inbound.db`/`outbound.db` and every read/write call site (`poll-loop.ts`, `mcp-tools` `send_message`/`edit_message`/`add_reaction`, `session_state`, `container_state`) talks to those files directly, exactly as under `'file'` transport — `initSessionSync()` establishes a connection in parallel but nothing routes through it yet (`applyInboundRow` in `startup.ts` currently just logs and drops). Making `'sync'` transport actually do something requires, together, not separately: (a) `container-runner.ts` skips the `inbound.db`/`outbound.db` bind mount for a `'sync'`-transport session, (b) `connection.ts` opens a local, container-owned `inbound.db` (RW — it's no longer host-owned once nothing mounts it) with real schema, and (c) every one of those call sites is rerouted through `client.ts`'s push functions / the local applied copy. Not splittable into smaller safe increments — flipping (a) before (c) is complete means an opted-in group's agent replies are silently never pushed to the host at all. Not started.
  - **`inbound.db`'s full-schema gap** (`delivered`/`destinations`/`session_routing`, beyond the already-covered `messages_in`) is part of the same rewrite, once there's a real local inbound.db to apply them into.
  - **Reconnect loop** (call `connectSyncClient` again with `currentToken()` after a disconnect) is also naturally part of this same piece of work, since a mid-session reconnect only matters once the connection is load-bearing.
- **Phase 3-5**: real plan below (§8), not built.

## 7. `session_sync_state` vs. `session_state`

`session_sync_state` (schema.ts) is host-internal bookkeeping for the sync transport itself (currently just the outbound chain checkpoint — see §6 Phase 1). `session_state` is container-owned application state (SDK session ID, etc.), synced or not depending on the Phase 2 scope decision above. Kept as two separate tables specifically so sync-internal bookkeeping never shares a keyspace with app state that Phase 2 might start syncing — a collision there would be silent and hard to trace back to this decision.

## 8. Reversible switchover plan (planned 2026-08-15, not built)

Written before the mount-flip + write-path rewrite (§6 Phase 2's last item) rather than after, so the rewrite is built *to* this plan instead of the plan being reverse-engineered from whatever the rewrite happened to make possible.

### 8.1 The invariant the rewrite must preserve

`'sync'` transport must never become the *only* durable copy of anything. Today, host-side `inbound.db`/`outbound.db` are always the complete record regardless of transport (§6 verified this directly: `writeSessionMessage` inserts unconditionally; `notifyInboundWrite` — and after the rewrite, the container's push — is additive on top; `makeSessionSyncHandler` writes into the exact same `outboundDbPath()` `delivery.ts` always reads). The rewrite must keep that true: the container's local DBs become an additional durable copy for the container's own use, not a replacement for the host's. This is what makes switching transport, in either direction, a config change plus a restart rather than a data migration — there is never a moment where a session's history exists in only one place with no fallback.

The one place this invariant is *not* automatically satisfied is a container's own unpushed writes at the exact moment it's killed — see 8.2.

### 8.2 Hard prerequisites (block any real cutover, not just nice-to-haves)

None of these are optional polish — shipping without them means a transport flip can silently lose data, not just degrade:

1. **Reconnect loop** (§6 Phase 2, still open). Without it, any host restart — routine (`ncl groups restart`, a deploy) or crash — permanently kills a `'sync'` session's connection until the *container* itself is separately respawned. A production group on `'sync'` transport would silently stop syncing on the next ordinary host restart.
2. **Drain-before-exit on graceful shutdown.** The rewrite gives the container a local-first outbound write (durable in its own DB immediately) that gets pushed+acked to the host asynchronously. If the container is killed (respawn, `docker stop`, the corruption-exit path's `process.exit(75)`) before an outbound row's push is acked, that row is real and locally durable but the host has never seen it — and since the container is `--rm`, it's gone the moment the process exits. The rewrite must add a shutdown hook that blocks on any in-flight `pushOutbound`/`pushAck`/etc. (with a bounded timeout, then logs loudly rather than hanging forever) before allowing the process to exit. `container-restart.ts`'s existing `killContainer(onExit)` grace-period pattern is the natural place this plugs in.
3. **`inbound.db` full-schema sync** (`delivered`/`destinations`/`session_routing`, §6 Phase 2). Without it, a `'sync'`-transport session silently loses destination resolution and delivery-status tracking — not a crash, a quiet functional regression that's easy to miss in a spot-check.

### 8.3 Mechanism (already exists, nothing new to build)

Switching a group's transport is already just:

```
ncl groups config update --id <group-id> --transport sync    # or: file
ncl groups restart --id <group-id> --message "transport changed"
```

`--message` forces the `on_wake` respawn path (`container-restart.ts`) so the switch takes effect immediately rather than waiting for the next natural wake — and, per 8.2, only after the old container has actually drained and exited (`killContainer`'s existing `onExit` callback already guarantees the old process is gone before the new one spawns).

### 8.4 Staged rollout

1. **Canary group**: one low-stakes agent group (an admin's own personal/test group, not anything a real user depends on) — never the owner agent group, never anything wired to a channel with real traffic, for the first cutover.
2. **Observation window**: a few days of normal use, not a synthetic load test alone — the corruption this whole effort exists to fix only ever showed up under real, sustained traffic patterns (§1).
3. **Per-cutover verification checklist** (grep `logs/nanoclaw.log`/`nanoclaw.error.log`):
   - `Session-sync server listening` at host boot (already always true) and `connected to host session-sync server` from the specific container after its next spawn.
   - No `session-sync: chain resync required` / `resync_point` lines for that session — any occurrence means the two sides' chains diverged, which after the rewrite should never happen in normal operation and is itself an abort signal (8.5).
   - No new `DB_RETRY_EXHAUSTED` lines for that session's ID — the existing `sqlite-corrupt-count-host` shim (`docs/host-shims.md`) already tracks this metric and can be pointed at the canary group directly.
   - A real round-trip: send the canary group a message, confirm the reply, confirm `ncl sessions get` and `ncl tasks list` (if it has scheduled tasks) still behave normally.
4. **Widen gradually**: one more real (but non-critical) group, then the rest, each getting its own few-day observation window — never a single flip-the-default-for-everyone commit.

### 8.5 Rollback

Because of 8.1, rollback is symmetric to cutover and just as cheap:

```
ncl groups config update --id <group-id> --transport file
ncl groups restart --id <group-id> --message "transport changed"
```

The next container spawns back under `'file'` transport, bind-mounts the host's `inbound.db`/`outbound.db` as always, and — per 8.1 — those files were never anything other than the complete record the whole time. No data migration, no "reconcile the two copies" step, because there was only ever one copy that mattered on the host side.

**Abort criteria** — roll back immediately, don't investigate-in-place on live traffic, if any of these show up for a cutover group:
- Any `resync_point`/chain-mismatch log line (8.4's checklist item — the rewrite should make this impossible in normal operation, so seeing one means a real bug, not noise).
- A user-reported message that never arrived or a reply that never sent.
- The container crash-looping or repeatedly failing to reconnect.

### 8.6 Explicitly not in this plan

- **Automatic transport selection** (e.g. "detect VirtioFS corruption and self-heal onto `'sync'`"). Speculative until `'sync'` itself has a real production track record under 8.4.
- **A default-flip for macOS.** §3 already states the eventual intent (`'sync'` becomes the macOS default once proven out), but that's a separate, later decision gated on 8.4 actually completing for real groups, not part of building the switch mechanism itself.
