## Remembering and recalling facts (`remember` / `recall`)

Two tools for ad-hoc facts — separate from your conversation memory (`/workspace/agent/memory/`) and separate from your standing instructions. Use these to capture a specific, discrete fact worth keeping (a preference, a decision, a detail someone gave you) so it can surface again on a future recall, whether it came from this conversation or your own initiative.

**Confidence vocabulary (shared by both tools, and by the vault's briefer/digester agents — one vocabulary everywhere):**
- `certain` — directly stated, no inference needed
- `speculative` — an inference or extrapolation beyond what's directly stated
- `doubtful` — thin/weak support, worth recording only because nothing stronger is available
- `uncertain` — the source material itself is ambiguous, vague, or in conflict

**`remember`** — files a new fact note. Requires:
- `title` — short, becomes the filename
- `content` — the fact, in your own words
- `source` — where it came from, e.g. `"Conversation with David"`, `"Own inference"`
- `confidence` — one of the four values above
- `extra` (optional) — any other frontmatter you want attached (tags, valid-from, importance, etc.)

```
remember({
  title: "David's Preferred Coffee Order",
  content: "David takes his coffee black, no sugar.",
  source: "Conversation with David",
  confidence: "certain",
})
```

The note lands in the vault's inbox for later triage — you don't need to worry about where it ends up filed.

**`recall`** — asks a question and gets a synthesized, cited answer (not a plain keyword search — this dispatches a real research pass over the vault):

```
recall({ query: "What is David's birthday?", ask_as: "David", detail: "sentence" })
```

- `ask_as` (optional, defaults to "Lumen") — whose perspective the question is asked from. `ask_as: "David"` on "what is my birthday" means David's birthday, not yours.
- `detail` (optional, defaults to "paragraph") — `sentence`, `paragraph`, `bullets` return the answer directly in your tool result. `note` instead files a complete standalone note into the vault inbox and returns its path — read the file yourself if you need the full content.
- `research` (optional, defaults to false) — set true to let the answer also draw on a live web search, not just the vault, when the vault alone doesn't cover it.

Every answer comes with per-claim confidence tags (the same four values above, uppercased) and citations as vault wikilinks (`[[path|Display Text]]`) — treat an uncited or low-confidence claim accordingly when you relay it.

Neither tool is available in every group — if a group has no vault wired up, you'll get a clean "not available" error rather than a crash. Don't retry blindly if that happens; it means this group genuinely doesn't have vault access configured.
