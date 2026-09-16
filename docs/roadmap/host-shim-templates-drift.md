# Host-shim templates missing 2026-09-16 fixes

Discovered 2026-09-16 while checking documentation currency after fixing `lumen-dmj`'s
live `recall-host`/`briefing-host` copies (see
[docs/roadmap/dispatcher-agent-infrastructure.md](dispatcher-agent-infrastructure.md)'s
addenda for the incident). The trunk templates at `src/host-shim-templates/recall-host`
and `src/host-shim-templates/briefing-host` — what `/add-vault-memory-pipeline` and
`group-init.ts`'s `initGroupFilesystem` seed into every *new* group — never received any
of that day's fixes. Per `docs/host-shims.md`'s own stated convention ("a group's own
edits survive every future spawn/restart... trunk template fixes don't reach an
already-seeded group automatically — fold generic fixes into the template"), these are
exactly the kind of generic fixes that belong in the template, not just the one live copy
that happened to get fixed under pressure.

Concretely, `src/host-shim-templates/recall-host` is missing, relative to the fixed
`lumen-dmj` copy:

1. **The `--output-format json` array-unwrap fix.** The template still does `jq -r
   '.result'` directly on `claude`'s output — as of `claude` 2.1.261 this is a JSON array
   of streamed events, not one object, so any new install's `recall-host` will crash
   immediately against a current CLI. This alone means the template is currently broken,
   not just "unhardened."
2. **The PrefixRouter conversion.** Still `claude -p --agent seeker` directly against
   real Anthropic under whatever `claude` CLI login exists on the host — the same
   "burning a personal subscription on headless work" problem David explicitly didn't
   want for `lumen-dmj`. `briefing-host`'s template already has the right shape for this
   (a `BRIEFING_MODEL` variable, empty by default = real Anthropic, settable to route
   through PrefixRouter) — `recall-host`'s template should get the equivalent `RECALL_MODEL`
   knob, not a hardcoded value (unlike `lumen-dmj`'s live copy, which hardcodes
   `role/cheap-worker` — that alias is specific to this install's PrefixRouter config and
   isn't portable to the template).
3. **Diagnostics on `claude` failure.** Still under bare `set -eu` with no capture of
   `claude`'s own exit code/output — the exact gap that made the 2026-09-16 failure burst
   impossible to root-cause before the fix.
4. **UTF-8 read tolerance.** N/A for `recall-host`'s template today (it doesn't read/fold
   an agent persona file since it still uses `--agent seeker`) — becomes relevant once (1)
   and (2) are done and it adopts the persona-fold pattern.

`src/host-shim-templates/briefing-host` is missing, relative to the fixed `lumen-dmj`
copy:

1. **`--disallowedTools` write-access hardening.** Still `--disallowedTools Task,Agent`
   on both dispatch branches, without `Write,Edit,NotebookEdit`. Under
   `--permission-mode bypassPermissions`, this means a fresh install's `briefing-host`
   has an unenforced, unintentional full-write-access hole to the vault — `briefer.md`'s
   own declared tools are read-only, but nothing stops the model from ignoring that.
   This is a real security gap in the template today, not a hypothetical.
2. **UTF-8 read tolerance** on the three persona-file reads (`briefer.md`,
   `SKILL.md`, `focus-updater.md`) — lower severity than (1), but the same class of
   "crashes on a byte the template autho didn't anticipate."
3. The array-unwrap fix (see recall-host's item 1) — check whether `briefing-host`'s
   template already has this; unconfirmed as of this writing, verify before assuming.

## Why this wasn't just fixed immediately

Time constraint at the point of discovery — flagged via the roadmap instead of fixing
inline, per the "add a dated addendum / new item" convention rather than silently
patching without recording why. Fixing is mechanical (port the same diffs already
verified working on `lumen-dmj`'s copies) but the `RECALL_MODEL`-vs-hardcoded-alias
distinction above needs a deliberate decision about what the template's default should be
(empty = real Anthropic, matching `BRIEFING_MODEL`'s own convention, seems right — a
template can't know another install's PrefixRouter alias names).

## How to verify this has been fixed

`diff` the trunk templates against `~/Projects/lumen-nanoclaw-instance/host-shims/lumen-dmj/{recall-host,briefing-host}`
(commit `ce630e5` in that repo has the fixed versions) and confirm the four/three points
above are present in the templates, adapted to be install-generic (no hardcoded
`role/cheap-worker`, no hardcoded `lumen-dmj`-specific paths).
