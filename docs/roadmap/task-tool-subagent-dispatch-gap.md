# `Task`-tool subagent dispatch bypasses PrefixRouter routing

Discovered 2026-09-16 while smoke-testing the newly-built `routine` agent. Not specific
to `routine` or Dispatcher — a systemic gap in every agent container.

## What happened

Testing Dispatcher → `routine` delegation (see
[dispatcher-agent-infrastructure.md](dispatcher-agent-infrastructure.md) and
[routine-agent.md](routine-agent.md)), both Dispatcher and `routine` — independently, on
different turns — produced a reply consisting entirely of OneCLI's standard 401 error
text: `"No credentials configured for api.anthropic.com in OneCLI"` with a `secret_url`
onboarding link. Both agent groups have `container_configs.model: role/cheap-worker`,
correctly materialized into their `container.json` (verified on disk, not a stale-config
repeat of the earlier `DEFAULT_AGENT_MODEL` incident) — so this isn't the model being
unset. The model config is right; something *else* in the turn made a real request to
Anthropic's real API.

Lumen (asked by Dispatcher to help investigate, unprompted, while David was presumably
asleep — an unexpectedly coherent piece of autonomous multi-agent troubleshooting, worth
noting even though it didn't reach a real fix) correctly traced the chain as `agent →
PrefixRouter → OneCLI → api.anthropic.com` and concluded OneCLI's vault has no credential
for that host — accurate as far as it goes, but doesn't explain *why* a request to real
Anthropic was made at all when the model is `role/cheap-worker` routed through
PrefixRouter. This produced an extended (~3 minute, many round-trips) but not runaway-in
the infinite-loop sense back-and-forth between Dispatcher and Lumen before being manually
stopped (`ncl groups restart` on all three groups, no wake message, to halt without
respawning).

## Root cause (probable, not fully confirmed)

`container/agent-runner/src/providers/claude.ts`'s `TOOL_ALLOWLIST` includes `'Task'`
(line ~117) — every agent container can dispatch an internal Claude Code subagent via the
`Task` tool, unconditionally. This is the exact failure mode `briefing-host` and
`recall-host` already had to guard against for their own raw `claude -p` shell-outs (see
`docs/host-shims.md`'s conventions section and both scripts' `--disallowedTools
...,Task,Agent`): subagent dispatch resolves its own model, inherits the container's
spoofed `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` regardless of what the *parent* turn is
routed through, and fails auth against the real API since OneCLI has (deliberately) no
Anthropic credential registered.

The container-level agent-runner (`container/agent-runner/src/providers/claude.ts`) has
**no equivalent guard** — `Task` (and by extension `Agent`, if it exists as a distinct
tool at this layer — unconfirmed) is just always available, with nothing disallowing it.
This means the same trap exists for every agent group in the install, including Lumen,
not just Dispatcher/`routine` — it just hasn't been triggered for Lumen yet (or has, and
gone unnoticed as a stray tool-call failure absorbed into a turn rather than becoming the
entire visible reply, which is speculation, not confirmed).

## What's NOT yet confirmed

- The exact SDK-level mechanism (which Claude Agent SDK call actually goes out unproxied
  to real Anthropic when `Task` fires) — inferred from the tool-allowlist match and the
  error's shape/timing, not traced through SDK internals or a controlled repro.
- Whether `Agent` (a separate tool name mentioned in `briefing-host`'s own comments,
  "Task in some CLI versions") is also in `TOOL_ALLOWLIST` or reachable another way at
  this layer.
- Whether this is genuinely a hard 401 every time `Task` fires, or only under specific
  conditions (e.g., a rate-limit/capability check that only fires on some turns) — both
  failures happened on the *second* turn of each session (after an initial successful
  turn each), which might be a clue or might be coincidence.

## Possible fixes (not decided)

1. Remove `Task` from `TOOL_ALLOWLIST` container-wide, if agent-to-agent delegation via
   `send_message` (item 1 of dispatcher-agent-infrastructure.md) is meant to be the *only*
   coordination mechanism and internal subagent dispatch was never actually intended to
   be available inside these containers.
2. Make internal `Task` dispatch inherit/respect the container's `ANTHROPIC_BASE_URL`/
   spoofed-key routing properly, the way `briefing-host`'s `--system-prompt-file`
   conversion did for its own use case — more work, preserves a capability that might be
   used deliberately elsewhere.
3. Register a real OneCLI credential for `api.anthropic.com` (defeats the entire point of
   this install's "never touch a real Anthropic subscription for headless work" policy —
   almost certainly not the right answer, but worth stating explicitly to rule out).

Leaning toward (1) as the pragmatic default until there's a concrete need for (2) — but
this needs deciding, not assuming.

## Verifying a fix

Reproduce by asking Dispatcher (or `routine`, or Lumen) something phrased to plausibly
invite the model to reach for `Task` rather than `send_message`/its own direct tools, and
confirm the reply is a coherent answer, not OneCLI's 401 boilerplate.
