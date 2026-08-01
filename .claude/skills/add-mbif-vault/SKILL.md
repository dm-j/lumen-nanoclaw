---
name: add-mbif-vault
description: Install MBIF (My-Brain-Is-Full-Crew) as the recommended vault-management layer for a projected-lifecycle agent group, derive a Briefer subagent from MBIF's Seeker for add-projected-sessions' briefing-host script, and seed a real Digester subagent for the vault memory pipeline's digest-generation phase. Fork-specific recommendation (lumen-nanoclaw), not upstream NanoClaw.
---

# Add MBIF Vault

`/add-projected-sessions`'s `briefing-host` script needs an Obsidian vault
with a `Briefer` subagent in it (`VAULT_PATH/.claude/agents/briefer.md`).
This skill provisions that: installs [MBIF](https://github.com/gnekt/My-Brain-Is-Full-Crew)
(My-Brain-Is-Full-Crew) — a real, actively maintained crew of Claude Code
subagents for running an Obsidian vault — as the recommended way to get a
usable vault fast, then derives `Briefer` from MBIF's own `Seeker` agent.

**MBIF has no native "Briefer" agent.** Its closest match is `Seeker`
(search + synthesis across the vault, with citations) — confirmed by
reading the actual repo (`agents/seeker.md`, `README.md`), not assumed.
Briefer is a deliberate fork of Seeker's prompt for a different job:
Seeker answers a user's question by searching; Briefer produces a
standing briefing for a *different* agent to read, and is invoked
headless (`claude -p --agent briefer`), never conversationally. This
divergence was decided in this project's own design work (the "Memory
Briefing Design" note, 2026-07-07) before this skill existed — this skill
just makes that derivation repeatable instead of hand-done once.

**Digester is not derived — it's a real, complete, already-working agent
this skill ships verbatim** (`digester.md`, shipped alongside this
`SKILL.md`). Unlike Briefer, it isn't a fork of an MBIF stock agent — it
was purpose-built for this exact job (raw transcript → categorized,
wikilinked, anchor-cited digest) and is generic enough to ship as-is: no
vault-specific names, people, or projects hardcoded into its prompt.

**Optional, not a hard dependency.** `add-projected-sessions`'s
`briefing-host` template shells out to *whatever* `VAULT_PATH/.claude/agents/briefer.md`
contains — it has no idea whether that came from this skill, a hand-written
prompt, or something else entirely. MBIF is the recommended path because
it's real, maintained, and already proven out on this fork's own vault —
not because the compiler requires it.

**License/ToS note:** MBIF is MIT-licensed but carries its own
[Terms of Use](https://github.com/gnekt/My-Brain-Is-Full-Crew/blob/main/TERMS_OF_USE.md)
that its own onboarding flow asks the operator to explicitly accept. This
skill doesn't bypass that — the operator goes through MBIF's real
onboarding conversation, not a scripted stand-in for it.

## Pre-flight

### Check if a vault is already set up

```bash
test -f "<vault-path>/.claude/agents/seeker.md" && echo "MBIF already installed"
test -f "<vault-path>/.claude/agents/briefer.md" && echo "Briefer already derived — skip to Wire it up"
test -f "<vault-path>/.claude/agents/digester.md" && echo "Digester already seeded"
test -f "<vault-path>/Meta/vault-map.md" && echo "Vault already onboarded"
```

### Verify `/add-host-scripts` and `/add-projected-sessions` are applied

This skill's output (`briefer.md`) only matters once
`add-projected-sessions`'s `briefing-host` template can shell out to it.

```bash
test -f src/host-shim-templates/briefing-host && echo OK
```

## Apply

### 1. Choose or create the vault

If the target agent group doesn't already have an Obsidian vault, create
one now (open Obsidian → New Vault) or pick an existing one. Note its
absolute path — every step below uses `<vault-path>`.

### 2. Clone MBIF into the vault

```bash
cd "<vault-path>"
git clone https://github.com/gnekt/My-Brain-Is-Full-Crew.git
```

### 3. Run MBIF's own installer

```bash
cd "<vault-path>/My-Brain-Is-Full-Crew"
bash scripts/launchme.sh --platform claude-code
```

This builds and copies MBIF's agents, skills, references, hooks, and MCP
config into `<vault-path>/.claude/` — real installer, not reimplemented
here. `--target <path>` overrides the destination if the vault isn't the
repo's immediate parent directory.

### 4. Run MBIF's own onboarding

This is a genuine multi-turn conversation, not a scriptable step — MBIF's
`Architect` agent asks who the operator is, what they need managed, and
requires explicit Terms of Use acceptance before proceeding:

```nc:operator
Open Claude Code inside the vault folder (<vault-path>) and say:
"Initialize my vault"
Follow the Architect's onboarding conversation — it will ask you to accept MBIF's Terms of Use, then generate Meta/vault-map.md and the vault's folder structure (00-Inbox, 01-Projects, ..., 07-Daily, etc.).
```

After this, `<vault-path>/.claude/agents/seeker.md` and MBIF's other
agents exist and are onboarded to this specific vault's structure.

### 5. Derive Briefer from Seeker

```bash
cp "<vault-path>/.claude/agents/seeker.md" "<vault-path>/.claude/agents/briefer.md"
```

Then edit `briefer.md`'s frontmatter and framing — the prompt body
(vault-path resolution, user-profile read, search/synthesis mechanics)
stays as Seeker wrote it; only the *purpose* framing changes:

- `name: seeker` → `name: briefer`
- `description:` — replace the "use when the user asks..." framing with:
  a headless compiler invoked by the host before every turn, never
  addressed by the user directly, whose only job is producing a briefing
  for a different agent to read.
- Add, prominently near the top of the body (this is the one load-bearing
  correction — everything else can stay as Seeker wrote it):

  ```markdown
  ## You are not answering a user

  You are invoked headless, once per turn, by NanoClaw's host — never
  conversationally, never by the person whose vault this is. Do not
  address them. Do not ask clarifying questions (there's no one to answer
  them). Your entire output is the briefing text itself — nothing else.
  ```

- Remove or ignore any "Inter-Agent Coordination" / "Suggested next agent"
  section inherited from Seeker — briefer has no dispatcher to hand off to.

**Deliberately not further specified here.** The exact briefing-synthesis
prompt (topic/subject caps, confidence tagging, the "short-circuit but
never say 'nothing changed'" correction) is this fork's own accumulated
design work (see the Obsidian project note "Lumen on NanoClaw — Projected
Session Implementation Plan", §3) — copy that shape in if it's useful, or
let a fresh vault's Briefer diverge on its own. This skill's job stops at
"a real Briefer exists, derived from a real Seeker," not "the one true
Briefer prompt."

### 5b. Seed Digester

```bash
cp "${CLAUDE_SKILL_DIR}/digester.md" "<vault-path>/.claude/agents/digester.md"
```

No editing needed — unlike Briefer, this is shipped ready to use.

**Real dependency this skill does NOT provide.** `digester.md`'s prompt
calls out to vault tooling by path — `Meta/scripts/link-index` (entity/
project link lookup), `Meta/scripts/number-digest-blocks` (anchors the
digest's own Event Log entries), `Meta/naming-conventions` (wikilink
format reference), `Meta/user-profile` (personalization context), and its
own post-it at `Meta/states/digester.md` (created on first run, not a
dependency). **None of these come from MBIF's stock install or from this
skill** — they're this fork's own custom vault tooling. A freshly
MBIF-onboarded vault will not have them. Digester degrades gracefully for
the parts it can (entity/project linking without `link-index` just means
less consistent blind-link spelling; no anchor-numbering script means the
digest's own entries aren't citable one tier up, which breaks the weekly
digest phase) but does not silently pretend they exist. **Not solved
here** — either hand-write equivalents for a fresh vault, or treat this as
confirmation that a vault needs more than MBIF's stock onboarding before
the full digest pipeline works end-to-end.

### 6. Wire it to `add-projected-sessions`

Edit the target agent group's `briefing-host` script
(`groups/<folder>/host-shims/briefing-host`) — set:

```sh
VAULT_PATH="<vault-path>"
```

Then enable the lifecycle:

```bash
ncl projected-sessions enable --id <group-id>
ncl groups restart --id <group-id>
```

## Vault layout note (for Phase 3)

MBIF's own onboarding already creates `07-Daily/` as part of the standard
PARA+Zettelkasten structure it sets up. The vault memory pipeline's next
phase (transcript export + digest generation, not part of this skill) adds
`Transcripts-readonly/` and `Digests-readonly/` **subfolders inside** that
existing `07-Daily/` — it's an addition on top of MBIF's stock layout, not
a competing convention. Nothing to prepare for that here beyond having
`07-Daily/` exist, which MBIF's onboarding already guarantees.

## Troubleshooting

- **`launchme.sh` asks to pick a platform interactively and hangs in a
  non-interactive shell.** Always pass `--platform claude-code` explicitly
  (as step 3 does) — never invoke it bare in an automated context.
- **Onboarding conversation stalls or the operator isn't sure what to
  answer.** This is a real MBIF flow, not something this skill controls —
  point the operator at MBIF's own [getting-started guide](https://github.com/gnekt/My-Brain-Is-Full-Crew/blob/main/docs/getting-started.md).
- **`briefing-host` still fails after this skill.** Confirm `VAULT_PATH` in
  the script actually got edited (it's seeded with a placeholder that
  refuses to run until changed — see `add-projected-sessions`'s own
  troubleshooting) and that `<vault-path>/.claude/agents/briefer.md`
  exists and is readable.
- **Briefer answers the user instead of producing a briefing.** The "You
  are not answering a user" correction (step 5) is the one thing that
  can't be skipped — if it's missing or buried, Seeker's original framing
  ("use when the user asks...") can leak through and the model may try to
  have a conversation instead of just emitting briefing text.
- **Digester errors out or behaves inconsistently referencing scripts/notes
  that don't exist.** Expected on a vault that only has MBIF's stock
  onboarding — see step 5b's "Real dependency this skill does NOT
  provide." Digester's prompt assumes `Meta/scripts/link-index`,
  `Meta/scripts/number-digest-blocks`, and `Meta/naming-conventions`
  exist; none of them ship with MBIF or this skill.

## Verify

```bash
test -f "<vault-path>/.claude/agents/briefer.md" && echo OK
cd "<vault-path>" && claude -p --agent briefer --output-format text --permission-mode bypassPermissions "## Inciting message\n\ntest\n" | head -20
```

Should produce briefing-shaped text (or a reasonable "nothing found yet"
for a brand-new vault), not a conversational reply asking what the user
needs.

```bash
test -f "<vault-path>/.claude/agents/digester.md" && echo OK
```

A real end-to-end digest run needs an actual transcript file to point it
at (see the vault memory pipeline's transcript-export phase) — not
meaningfully testable in isolation with a placeholder input.

## Removal

See [REMOVE.md](REMOVE.md).

## Credits & references

- [MBIF (My-Brain-Is-Full-Crew)](https://github.com/gnekt/My-Brain-Is-Full-Crew)
  by [@gnekt](https://github.com/gnekt) — MIT-licensed, actively
  maintained. Read its own [Disclaimers](https://github.com/gnekt/My-Brain-Is-Full-Crew/blob/main/docs/DISCLAIMERS.md)
  and [Terms of Use](https://github.com/gnekt/My-Brain-Is-Full-Crew/blob/main/TERMS_OF_USE.md)
  before installing — this skill doesn't paraphrase or bypass them.
- Briefer's derivation-from-Seeker design: Obsidian note "Memory Briefing:
  Design Notes" (2026-07-07), §5.
- Digester (`digester.md`, shipped verbatim with this skill) is this
  fork's own custom agent, not part of MBIF — built for the vault memory
  pipeline's digest-generation phase (Obsidian note "Lumen on NanoClaw —
  Vault Memory Pipeline Implementation Plan", Phase 3).
- Depends on: `/add-host-scripts`, `/add-projected-sessions` (this skill's
  Briefer output is meaningless without the `briefing-host` script that
  reads it).
