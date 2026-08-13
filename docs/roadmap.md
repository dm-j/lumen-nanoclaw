# Roadmap

Open items, roughly in priority order. Not a commitment or schedule — just what's known to be outstanding.

## 1. Reconcile host-shim trunk templates

`src/host-shim-templates/briefing-host` has drifted far behind the live copy at `host-shims/lumen-dmj/briefing-host` — predates the `--agent` → foreground-dispatch switch, the `BRIEFING_MODEL`/PrefixRouter routing, and the 2026-08-10 narration-forwarding fix. New groups seeded from the template inherit none of these fixes. Needs a pass to fold the accumulated live-copy fixes back into the template (or decide which parts are genuinely per-group and which are bugfixes that belong in trunk).

## 2. .ics handling

No calendar/`.ics` ingestion or generation yet.

## 3. Email handling

No email channel/adapter yet (see `docs/customizing.md` for the channel-skill pattern this would follow).

## 4. Task handling

Scope TBD — clarify against the existing `ncl tasks` scheduled-task system (`docs/scheduled-tasks.md`, `docs/ncl-tasks-migration.md`) before treating this as new work; may already be partially covered.

## 5. Re-implement or drop `wikilink-query`

Vault shim `Meta/scripts/wikilink-query` (used by `briefer.md`'s fan-out step) pointed at `/Users/lumen/Projects/nanoclaw/scripts/wikilink-query.ts` — a v1 nanoclaw memory-briefing helper that never got ported to v2's projected-sessions system. Calling it threw `ERR_MODULE_NOT_FOUND`, which the briefer model (running on a small model under load) misreported to the user as an Anthropic API key problem — actually unrelated. Removed from `briefer.md`'s tool list for now (falls back to plain `Read` for fan-out); decide whether to reimplement the cached wikilink-summary lookup against v2, or leave it dropped permanently.
