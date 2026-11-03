# Visual subagent — started 2026-11-03

A crew agent that looks at one or more images and answers questions about them. Other agents (via Dispatcher) hand it
images plus a question; it replies with an answer, not a generic description.

## Why the existing captioner doesn't cover it

`src/modules/attachment-caption/` captions every inbound image once, at ingest: a fixed "describe for a legally blind
friend" prompt, resized to 512px, answered by a small local model (`gemma3:4b`). That is a description, not question
answering — it can't be asked "what does the small print say?" or "which of these two is bigger?", it loses detail at
512px, and it only exists for images that arrived on a channel. The captioner stays as the cheap always-on head start;
the visual subagent is the on-demand, full-resolution, ask-anything path.

## What was verified (2026-11-03)

- **The whole path works with no new code.** An Anthropic-format `/v1/messages` call with an `image` block, sent to
  PrefixRouter as `ollama/gemma4:31b-cloud`, came back with an accurate answer (character, clothing, the text on the
  shirt) in one short call. So an agent group whose `model` is a vision-capable string can look at images natively; the
  SDK's image-reading just needs to reach it.
- `ollama/gemma4:12b` also sees, but spends its output on visible chain-of-thought — slow for a lookup agent.
- Vision-capable per `ollama /api/show`: `gemma3:4b`, `gemma4:31b-cloud`. Many other installed models (the
  `role/*` aliases' targets) are not known to be; **check `capabilities` before pointing the group at one.**
- **Image transport already exists.** `forwardAttachedFiles` (`src/modules/agent-to-agent/agent-route.ts`) copies a
  sender's `send_file` outbox files into the target's inbox as `{name, type, localPath}` attachments, so Dispatcher (or
  any agent with a destination to it) can pass images over without a shared mount.

## Shape (recommended)

1. A new agent group, **Vision**, `model` = a vision-capable string (start: `ollama/gemma4:31b-cloud`; once happy, add a
   `role/vision-worker` alias in PrefixRouter's `config.json` rather than hardcoding), `cli_scope: disabled`.
2. `description` written as a routing signal: "Use when the request needs something read, identified or compared in
   one or more images."
3. `instructions.prepend.md`: look at every attached image, answer the question asked and only that, say plainly when an
   image is unreadable or the answer isn't visible (no guessing), reply via `report_completion`.
4. A destination from Dispatcher (and from lumen-dmj if David wants to call it directly), nothing else.

Deliberately not building: a vision mcp-shim, a bespoke image store, a per-provider vision capability matrix.

## Open

- **Which model, long term.** `gemma4:31b-cloud` was flaky in the captioner's tests (see the comment in `caption.ts`:
  ~7% success, 2026-08). It worked first time today, but reliability needs measuring before Dispatcher depends on it.
  Fallback chain idea: `ollama/gemma4:31b-cloud=>ollama/gemma3:12b-it-qat` (local, check it has vision).
- **Does the SDK's `Read` on an image file send an image block** to a non-Anthropic model through PrefixRouter, or
  does it return bytes as text? Not yet tested inside a container — first build step.
- **Images already in someone's inbox.** The sender must `send_file` the image to forward it; confirm an agent can
  `send_file` from its own `inbox/<message>/` path, or Dispatcher will need a small instruction for it.
- Full-resolution vs. resize: images over a few MB may need downscaling to fit the model's limits; the captioner's
  `resizeToBuffer` is a candidate to reuse, at a larger long edge.
