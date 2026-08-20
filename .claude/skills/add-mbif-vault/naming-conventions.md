# Naming Conventions

- Notes: `Title Case.md`, no dates in filename unless date-scoped (daily/meeting/journal)
- Daily notes: `YYYY-MM-DD.md` in `07-Daily/`
- Week digests: `WeekBeginning-YYYY-MM-DD.md` in `08-Weekly/Digests-readonly/`, named by the Monday that starts the week (`type: week-digest`, `week_beginning: "YYYY-MM-DD"`)
- Month digests: `Month-YYYY-MM.md` in `09-Monthly/Digests-readonly/`, zero-padded month, e.g. `Month-2026-07.md` (`type: month-digest`, `month: "YYYY-MM"`). A week belongs to the month **its Monday falls in**, so each week digest rolls up into exactly one month file. Month files are populated incrementally — a week's summary is appended (or the month file created) as each week completes, not gated to month-end. Format reference: `Templates/Monthly Digest.md`
- Meeting notes: `YYYY-MM-DD - Subject.md` in `06-Meetings/YYYY/`
- Area index files: `_index.md` inside each area/sub-area folder
- MOCs: `MOC/{Area Name}.md`

## Attachments (non-Markdown files — images, PDFs, audio, etc.)

Non-Markdown files are **co-located with the note that embeds them**, in an `Attachments/` subfolder beside that note. Example: an image embedded by `02-Areas/Work/AppSec-Comptroller/Projects/TRAMS Security Test/SNOW and App-Sec Requests.md` lives at `02-Areas/Work/AppSec-Comptroller/Projects/TRAMS Security Test/Attachments/`. This keeps every project/area folder self-contained — the attachments travel with the note if the folder is ever moved.

- **New attachments dropped in the vault root** (Obsidian's habit): file them into the `Attachments/` subfolder of the note that references them. `.obsidian/app.json` sets `attachmentFolderPath: "./Attachments"` so Obsidian itself now drops new pastes into a co-located `Attachments/` folder rather than the root — but stray files predating that setting, or arriving via other means, still need filing.
- **Always move attachments with `Meta/scripts/obsidian move path="<old>" to="<Attachments/…>"`** — it is vault-aware and keeps embeds (`![[file.png]]`) resolving. Do **not** use `vault-mv` for attachments (it is hardcoded to `.md` files) and do **not** raw `mv` (breaks Obsidian's link index). Obsidian resolves shortest-form embeds by filename regardless of path, so the `![[…]]` text is unchanged; the CLI updates the index.
- **An attachment embedded in / linked from a real note needs no sidecar to have a home** — the embedding note *is* its context. But any attachment (referenced or not) **may** carry an optional **sidecar note** when the file needs its own frontmatter or prose the parent note can't hold: tags, provenance/source, a description, licensing, OCR text, a `sha256:` for dedup, etc. See below.

### Sidecar notes (optional per-attachment metadata)

A sidecar is a Markdown note that lives **beside its file, same basename with `.md` appended** — `Attachments/diagram.png` → `Attachments/diagram.png.md`. The same-basename-plus-`.md` pairing is what makes re-pairing deterministic; never rename a sidecar independently of its file. Schema:

```markdown
---
type: file-sidecar
original-filename: diagram.png
sha256: <shasum -a 256 output>
file-type: image/png
origin: <inbox | paste | download | …>
moved-date: {{date}}
status: <filed | unfiled>   # Family 1, see "`status:` frontmatter taxonomy" below
---

## About
<what this file is, where it came from, why it's kept>

## Notes
<tags, provenance, description, OCR text, filing notes — anything the parent note can't carry>
```

- **One mechanism, two uses:**
  1. **Broad (optional, the general case):** any co-located attachment that needs metadata/provenance beyond what its embedding note carries. Set `status: filed`.
  2. **Fallback (unfileable):** a binary that *no* note references and that can't be classified — here the sidecar is the file's only home and context. Set `status: unfiled` and surface it (e.g. in an inbox/triage digest) so it isn't forgotten.
- **Location:** the sidecar co-locates with its file, i.e. in the same `Attachments/` folder (or wherever the file lives). This supersedes the old `Meta/Files/` sidecar location — `Meta/` is now reserved for vault operations only.
- **Hash first, before moving** (`shasum -a 256`) so a file and its sidecar can always re-find each other. On a filename collision when filing, prefix the *file* with the first 8 chars of the hash (`a1b2c3d4-diagram.png`); the sidecar follows the file's final name.
- **If a file and its sidecar are ever separated**, don't re-pair on filename — run `Meta/scripts/find-pair <path-to-either>`. It hashes and searches the whole vault for the other half via the `sha256:` field (location-agnostic), returning the matching path or `Not found`.

## Wikilink format (canonical — all agents must follow this exactly)

Every agent that writes a wikilink uses one of exactly two shapes, chosen by whether the target resolves to an existing file:

- **Resolved link** (the target file exists): always include the path *and* an explicit alias, even when the alias is identical to the file's basename.
  `[[relative/path/without/extension|Display Text]]`
  Example: `[[05-Entities/Eliza Meeks|Eliza Meeks]]`, `[[01-Projects/Vector/2026-07-09 — Project — Vector|Vector]]`
- **Blind link** (the target file does not exist yet): no path segment at all — just the bare name.
  `[[Display Text]]`
  Example: `[[Vector]]`

Never write a resolved link without the `|alias` (e.g. never bare `[[05-Entities/Jane Doe]]`), and never write a blind link with a fabricated path. The presence or absence of the `|` is the signal that distinguishes a resolved link from a blind one — do not blur this by omitting the alias on a resolved link.

Don't editorialize a blind link in the surrounding prose (no "(not yet a note)", "(blind link)", "(no note yet)", etc. tacked on after it). The link shape itself already tells any agent or reader whether it resolves — that's the entire point of the two-shape convention. Write the sentence exactly as it would read once the link resolves.

This shape is deliberately regex-friendly. To extract every wikilink with its path (if any) and display text in one pass:

```
\[\[([^\]|]+)(?:\|([^\]]+))?\]\]
```

- Group 1 always present: the path (resolved) or the display name (blind).
- Group 2 present only when the link is resolved (the alias). If group 2 is empty/absent, the link is blind and group 1 doubles as its display text.

### Read-only folder editing — wikilinks only

Folders literally named `-readonly` (`07-Daily/Transcripts-readonly/`, `07-Daily/Digests-readonly/`, `08-Weekly/Digests-readonly/`, `09-Monthly/Digests-readonly/`) hold auto-generated primary content (raw transcripts, digest rollups). The `-readonly` designation protects the **prose/content substance** of these files from being rewritten — it does **not** freeze their link graph. Applying or correcting a wikilink is metadata about the underlying data, not a change to that data's substance.

- **Allowed without escalation:** any agent may resolve a blind link, fix a stale/broken link target, or otherwise correct wikilinks inside a `-readonly` folder directly (Edit tool or `obsidian` CLI). Do not defer or hand off a mechanical link fix.
- **Never allowed:** rewriting, deleting, or altering the surrounding prose/content of these files. That boundary is absolute.

#### CORRECTION amendment pattern (fixing wrong facts in read-only files)

When a `-readonly` file contains an incorrect factual claim, an agent may **amend** it — without violating the prose-freeze rule — by inserting a wikilink that carries the correction in its alias, placed immediately adjacent to the incorrect claim. The insertion is itself a wikilink, so it falls squarely under "only wikilink metadata may be touched in read-only folders."

- **Format:** `[[path/to/CorrectNote|CORRECTION: <brief correct fact>]]`
- **Placement:** immediately adjacent to (right after) the incorrect claim.
- **The original incorrect text is never removed or altered** — only the wikilink is added alongside it.

Why this is the right shape: it preserves the historical record (what was actually said/recorded, false starts and all) while neutralizing confusion for future readers and any downstream agent that re-reads the file. The correction points at the authoritative note holding the true fact, so the two stay reconciled.

Precedent (2026-07-21): a false "Erin (David's wife)" claim in `07-Daily/Transcripts-readonly/2026-07-20.md` and `07-Daily/Digests-readonly/2026-07-20.md` was amended by inserting `[[05-Entities/Erin|CORRECTION: Erin is Ginger's sister, a Pound instructor, and David's friend — not his wife]]` next to the claim, leaving the original text intact.

### Prefer real Markdown headers (`#`, `##`, `###`)

Structure note content with actual Markdown headers rather than bold lead-ins or plain paragraphs. Obsidian resolves headers as link anchors both internally (jump to a section) and externally (from any other note), so a note built on headers is addressable at a finer grain than the whole file: `[[05-Entities/Kelly/Kelly#Interactions|Kelly's interactions]]`. A note that's just paragraphs under one `# Title` can only ever be linked to as a whole. Header-anchored links use the same resolved/blind shapes above, with the anchor appended to the path (resolved) before the `|alias`:
`[[relative/path/without/extension#Header Name|Display Text]]`

## vault-mv and header-anchored links

`Meta/scripts/vault-mv` rewrites `[[old/path#Header|alias]]` links the same as plain ones — the header fragment is preserved untouched, only the path segment before `#` is replaced. This is why headers matter for the split rule below: naming sections with real headers (`## Interactions`, not just bold text) is what keeps any existing header-anchored links valid targets for `vault-mv` to detect and rewrite when a note gets split into a folder.

## 200-line split rule (canonical — any agent appending to a note)

Applies to `05-Entities/` and `01-Projects/` notes only. Dated logs (`07-Daily/Transcripts-readonly/`, `07-Daily/Digests-readonly/`) grow long by design and are not split candidates — `Meta/scripts/longest-notes` is scoped accordingly.

Daily-append sections (`## Interactions`, `## Tasks`, `## Key Results`, or similar running logs) grow forever and will eventually make a note too large to read in one pass. Before writing an append that would push a note's line count over 200, split it into a folder:

1. Convert `05-Entities/Kelly.md` -> `05-Entities/Kelly/Kelly.md` (same for `01-Projects/`) via `Meta/scripts/vault-mv "05-Entities/Kelly" "05-Entities/Kelly/Kelly"` — it `git mv`s the file and rewrites every resolved wikilink pointing at it in one pass.
2. `Kelly/Kelly.md` keeps the frontmatter and the stable, rarely-appended sections (About, Notes) and becomes an **index**: a short summary plus a `## Contents` list linking to the split-out files.
3. Move the append-heavy section(s) into their own file(s) inside the folder, named after the section — `Kelly/Interactions.md`, `Kelly/Tasks.md`. These are the ones that keep growing.
4. If a split-out section file itself passes 200 lines later, chunk it further (e.g. `Interactions-2.md`) and list all parts under `## Contents` in the index — oldest-first or newest-first, whichever the existing note already used.
5. Existing wikilinks to the entity/project keep resolving to the index (`[[05-Entities/Kelly/Kelly|Kelly]]`), not a sub-file — the index is always the canonical link target.

This is relocation, not deletion: nothing is removed, content just moves out of the way so the main note stays skimmable. Any agent that appends to notes (Linker, etc.) checks the line count before writing and performs this split itself when needed — no need to hand off to Architect for a mechanical move like this.

### Vendored/imported documentation exemption (ruling 2026-07-29)

**A note that mirrors a file owned by an upstream source outside the vault is exempt from the 200-line split rule.** Such a note is a *copy*, not vault-authored content. The split rule exists to tame notes that grow by daily appends; a vendored doc doesn't grow that way — it changes only when the upstream file changes, and it is replaced wholesale on re-sync rather than appended to. Splitting one would destroy the 1:1 filename correspondence that makes re-syncing a mechanical diff, in exchange for readability the reader can get from the upstream repo anyway.

A note qualifies for the exemption when **both** hold:

1. It carries a `source:` frontmatter field naming the upstream file it mirrors (e.g. `source: "nanoclaw repo docs/architecture.md"`), and
2. It lives in a folder whose whole purpose is mirroring that upstream (its sibling notes are mirrors too).

Exempt folders as of this ruling:

- `01-Projects/NanoClaw/Documentation/` — 46 notes mirroring the nanoclaw repo's `docs/`, 10 of them over 200 lines (`Architecture.md` 989, `Agent Runner Details.md` 803, `Spec.md` 779). Indexed by `01-Projects/NanoClaw/Documentation/NanoClaw Docs Overview.md`, which is the canonical link target for the set — link to the overview, not to a long mirror, when you mean "the NanoClaw docs".

`Meta/scripts/longest-notes` excludes exempt folders directly, so they never surface as split candidates in a health check. **When a new vendored-docs folder is added, add a matching `-not -path` exclusion to that script and list the folder above** — otherwise every audit will keep re-flagging it.

What is *not* exempt: a vault-authored long note is still a split candidate no matter how reference-like it feels. The exemption is about *provenance* (someone else owns the file), not about length or genre.

## Meta/wikilink-cache/ retention (policy 2026-07-29)

`Meta/wikilink-cache/` holds machine-generated cache notes written by NanoClaw's memory-briefing layer (`src/memory-briefing/wikilink-cache.ts`) — one `<uuid>.md` per Briefer call, with `query`/`timestamp` frontmatter and the `[[...]]` links scraped from that response. They are read back by similarity search (`memsearch search --source-prefix`) to hint future Briefer calls. See `01-Projects/NanoClaw/Documentation/Synthetic Context.md` for the mechanism.

**These are cache artifacts, not vault content.** That distinction drives everything below:

- **Excluded from all vault-content audits.** Do not count them in note totals, and do not flag them for orphan status, missing tags, missing MOC membership, frontmatter non-compliance, or naming-convention violations. UUID filenames and the absence of `type:`/`tags:` are correct here. Agents running audits must skip `Meta/wikilink-cache/` the same way they skip `Meta/scripts/logs/`.
- **Never hand-edit.** Nothing is lost by deleting any or all of them — the cache regenerates from live Briefer calls. Wholesale `rm -rf` is a safe recovery step if the cache is ever suspected of serving bad hints.
- **Their wikilinks are not maintained.** A cache note may point at a since-moved or since-deleted target. That is expected and harmless (hints are explicitly unverified; the Briefer re-verifies). Do not run link-repair passes over this folder, and do not report its stale links as broken-link findings.

**Retention:** keep entries for **14 days**, with a hard cap of **500 files**. Age is read from the `timestamp:` frontmatter field, never from filesystem mtime (a `git checkout` rewrites mtimes on the whole folder and would make everything look new). Prune with:

```
Meta/scripts/prune-wikilink-cache --dry-run   # preview
Meta/scripts/prune-wikilink-cache             # delete, then run `memsearch index`
```

Overridable per-run via `RETAIN_DAYS` / `MAX_FILES`. Deleting cache files leaves the memsearch index stale until re-indexed, so **always run `memsearch index` after a prune.**

Rationale for these numbers: the folder holds 166 files / 664K at ~15–50 new entries a day, so at 14 days the window is the binding constraint in normal use (well under the 500-file cap, which exists only as a runaway-growth backstop). If a cache hint is still useful, it's useful within two weeks of data — a deeper window just serves colder, less relevant hints. The files stay tracked in git (they are small, and a warm cache carries across machines); if history bloat ever becomes the concern, gitignoring the folder is the fix, not tighter pruning.

## `status:` frontmatter taxonomy (canonical — 2026-07-29)

`status:` is not one vocabulary — it is **three independent vocabularies** that happen to share a field name. Which one applies is determined by the note's `type:`/location, and values are never mixed across families. Pick a value from the family that matches the note; do not invent new ones without adding them here first.

### Family 1 — Filing lifecycle (any capturable note)

Where a note sits in the capture → filed pipeline. Owned by Scribe/Sorter.

| Value | Meaning |
|---|---|
| `inbox` | Captured, not yet triaged or filed. The default for new capture. |
| `filed` | Triaged and placed in its permanent home. Terminal state for most notes. |
| `unfiled` | Attachment sidecar whose file could not be classified — needs surfacing in triage (see "Sidecar notes" above). |
| `reconciled` | Archived source doc whose content has been merged into a canonical note; kept for provenance only. |
| `merged` | Archived note superseded by, and folded into, another note. |

### Family 2 — Project/work lifecycle (`type: project`, area and project notes)

| Value | Meaning |
|---|---|
| `idea` | Conceived, not started; no commitment made. |
| `requested` | Submitted to a third party, awaiting their action (e.g. a security-review request). |
| `draft` | Being actively written but not yet published/circulated. |
| `active` | In progress with ongoing work. |
| `on-hold` | Started, deliberately paused, intended to resume. |
| `discontinued` | Stopped for good without completing. |
| `completed` | Finished as intended. |

### Family 3 — TaskNotes plugin (`TaskNotes/`, `type: task`) — **plugin-owned, do not redefine**

`open` · `in-progress` · `done` (plus whatever else the plugin's own configuration defines).

These values are written and read by the Obsidian TaskNotes plugin. The vault does **not** own this vocabulary: do not rename these values, do not "normalize" them into Family 2, and do not add vault-invented values to task notes. If a task's status looks wrong, fix it through TaskNotes, not by hand-editing frontmatter. Agents touching task notes (Tasker) must round-trip the plugin's exact values.

### Not a `status:` family: `lifecycle-phase:` (work applications)

`05-Entities/Projects at Work/` notes (`type: application`) describe the maturity of a deployed application, which is a different concept from all three families above. On 2026-07-28 that field was deliberately renamed off `status:` to **`lifecycle-phase:`** precisely so it would stop colliding with them. Values: `active` · `sunset`.

Do not reintroduce `status:` on `type: application` notes, and do not fold `lifecycle-phase` values into Family 2 — an app being `active` in production is unrelated to a project being `active` work. (Dataview note: a bare hyphenated field parses as subtraction, so query it as `row["lifecycle-phase"]`.)

### Notes on this taxonomy

- `reading` is **not** a vault status — every occurrence lives inside `My-Brain-Is-Full-Crew/` (the crew's own source/dist tree, sample content in skill docs), not in vault notes. Ignore it in vault audits.
- `none` was previously reported as an in-use value; a full scan on 2026-07-29 found **zero** occurrences in the vault. It was a TaskNotes plugin default that no longer appears. If it reappears, it belongs to Family 3 and is the plugin's business, not the vault's.
- Auditing agents should validate `status:` **against the right family only**. Reporting a `type: task` note for using `open` (a perfectly valid Family 3 value) is a false positive.
- `on-hold` and `completed` are declared here but not yet used anywhere in the vault — they close obvious gaps in Family 2 and are the correct values to reach for rather than inventing synonyms like `paused` or `done` (which would collide with Family 3).
