# Reconcile host-shim trunk templates

`src/host-shim-templates/briefing-host` has drifted far behind the live copy at `host-shims/lumen-dmj/briefing-host` — predates the `--agent` → foreground-dispatch switch, the `BRIEFING_MODEL`/PrefixRouter routing, and the 2026-08-10 narration-forwarding fix. New groups seeded from the template inherit none of these fixes. Needs a pass to fold the accumulated live-copy fixes back into the template (or decide which parts are genuinely per-group and which are bugfixes that belong in trunk).

**2026-08-15 addendum:** the drift grew substantially today — the live copy gained the three-band working-memory system (`focus-updater` dispatch, `Meta/working-memory/{now,soon,back-burner}.md`), numbered items, and the `Back Burner → Soon → Now → Incoming Message → Briefing` output ordering, none of which exist in the trunk template. See [Post-turn topics agent](topics-agent-mcp-shims.md) for what's still planned on top of this.
