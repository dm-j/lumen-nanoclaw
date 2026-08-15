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
- **Phase 1 (host WebSocket server)**: done, not yet merged. `src/session-sync/secret.ts` (per-install HMAC secret, `data/session-sync/secret`), `src/session-sync/cert.ts` (self-signed TLS cert via the system `openssl` binary, cached alongside the secret), `src/session-sync/transport.ts` (generic `wss://`-only connection layer: `signToken`/`verifyToken`, `createSyncServer` — auth on upgrade via `Sec-WebSocket-Protocol`, channel-tagged envelope routing, connection registry, a per-connection token-refresh push over `AUTH_CHANNEL` at `tokenTtlMs / 2`; every server-side socket gets an `error` listener so a single flaky connection can't take the host process down via an unhandled EventEmitter `error`), `src/session-sync/server.ts` (session-sync-specific channel handler: resync-from-seq via a `resync_request`/`resync_point` handshake, chain verification through `protocol.ts`, applies synced `outbound`/`ack`/`ack_processing` rows into `outbound.db`). `nextChain`/`verifyChain` fold `seq` into the hash (not just the payload) — a message with a correct payload chain but a forged `seq` is rejected, since `seq` is the resync bookmark callers trust and must be as tamper-evident as the payload. The chain checkpoint is persisted into `outbound.db`'s own dedicated `session_sync_state` table (deliberately separate from the container-owned `session_state` table — see §7) after every applied message, not just held in memory — on cache-miss (e.g. after a host restart) it's re-derived from there, so a restart resumes from the real last-known `(seq, chain)` instead of resetting to `GENESIS_CHAIN` and forcing a full-history resync. Container-side mirror of the generic connection layer only: `container/agent-runner/src/session-sync/transport.ts` (Bun's native `WebSocket`, no new dependency). Unit-tested standalone (`transport.test.ts`, `server.test.ts`, `protocol.test.ts`, including a simulated-restart resync test and a forged-seq rejection test); typechecked on both host and container tsconfigs. **Not wired into any live spawn path** — no `container.json` field carries the token/port yet, `container-runner.ts` is untouched, every group still runs `'file'` transport.
- **Phase 2 (container sync client)**: designed at a high level (two decisions below resolved, not yet built). The container-side sync-specific handler (mirrors `server.ts`: chain state, resync bookkeeping, applying synced `inbound` rows into the container's local `inbound.db`) plus the `container.json` wiring (token, host port/URL) to actually connect at spawn time.
  - **Sync scope: all four tables per DB, not just the messages tables.** Phase 1's `server.ts` only applies `messages_out`/`processing_ack` — under `'sync'` transport the host's local `outbound.db` never gets `session_state` (SDK session ID — breaks Chat SDK resumption) or `container_state` (stuck-tool sweep window) unless those are synced too. No reason for coverage to stop at 2 of 4; Phase 2 extends `SyncMessageKind` (or an equivalent) to cover the full schema on both `inbound.db` and `outbound.db`, not just the messages tables.
  - **Auth token TTL: 15 minutes, opening bid.** Short enough to bound a leaked-token impersonation window. Refresh is solved: `createSyncServer` (Phase 1, `src/session-sync/transport.ts`) pushes a fresh token over the reserved `AUTH_CHANNEL` at `tokenTtlMs / 2`, well before the current one expires. The container-side `transport.ts` mirror tracks the latest pushed token (`SyncClient.currentToken()`). What Phase 2 still owes: the actual reconnect loop that calls `connectSyncClient` again with `currentToken()` after a disconnect — the token itself is kept fresh, but nothing yet *uses* it to reconnect.
- **Phase 3-5**: designed at a high level (verification-before-cutover, rollout), not built.

## 7. `session_sync_state` vs. `session_state`

`session_sync_state` (schema.ts) is host-internal bookkeeping for the sync transport itself (currently just the outbound chain checkpoint — see §6 Phase 1). `session_state` is container-owned application state (SDK session ID, etc.), synced or not depending on the Phase 2 scope decision above. Kept as two separate tables specifically so sync-internal bookkeeping never shares a keyspace with app state that Phase 2 might start syncing — a collision there would be silent and hard to trace back to this decision.
