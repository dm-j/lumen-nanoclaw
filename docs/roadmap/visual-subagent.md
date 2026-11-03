# Visual subagent — built 2026-11-03, live-tested directly; Dispatcher end-to-end still to run

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

## What was built (2026-11-03)

- **Agent group `Vision`** (`ag-69584d5b-6516-47df-91f2-8c92642367b2`, folder `vision`): model
  `ollama/gemma4:31b-cloud`, `cli_scope: disabled`, a routing `description`, and
  `groups/vision/instructions.prepend.md` (open every attached image, answer only the question, separate visible from
  inferred, name each difference with where it is, reply once via `report_completion`). Destinations: Vision →
  `parent` (Dispatcher) and Dispatcher → `vision`. Nothing else can reach it.
- **`send_file` and `assign_task` take `paths: [...]`** (`container/agent-runner/src/mcp-tools/core.ts`): several files
  in one message. Before this, `send_file` was one file per call, so a two-image comparison would have reached Vision
  as two separate messages, the first without the second. The host already handled a `files` array, so this is a
  container-side change only (agent-runner is a shared mount: new containers pick it up, running ones need a
  respawn). Files are validated all-or-nothing; a shared basename (every inbox photo is `attachment-<n>.jpg`) gets an
  index prefix instead of overwriting. Tests in `core.test.ts`.
- **Dispatcher instructions** gained an "Images and other files" paragraph: send all images for one question in one
  `assign_task`, in the order given, say which is which, and route "what is in / how do these differ" to Vision.

## Verified

- Through PrefixRouter directly: one image, and two images in one request ("compare these"), both answered correctly in
  about a second.
- Vision's own agent loop (host-injected a2a message, two attachments, fresh session): the container woke, read both
  images, told them apart correctly and replied with `report_completion` (`noReply` + `closesSession`). Answers read:
  image 1 a purple dragon character in a "BIG GIRL" shirt, image 2 a white geometric object with gold cracks.

## Open

- **Full chain not yet run**: lumen-dmj → Dispatcher → Vision → back, with real photos sent by David. Dispatcher's
  new instructions apply from its next container spawn. Check that Dispatcher passes `paths` for inbox images and
  that lumen-dmj hands the images to Dispatcher in the first place (lumen-dmj's own instructions don't mention it).
- **Reliability of `gemma4:31b-cloud`.** The captioner's notes record ~7% success in 2026-08; David reports it is
  much improved and it worked first time in every test today, but nobody has measured it. Candidate fallback chain:
  `ollama/gemma4:31b-cloud=>ollama/gemma3:12b-it-qat` (confirm the local model has vision first). A `role/vision-worker`
  alias in PrefixRouter's `config.json` would replace the hardcoded string.
- **Large images.** Not resized; a photo over a few MB may exceed the model's limit. The captioner's `resizeToBuffer`
  is the candidate to reuse, at a larger long edge.
- `Read` on an image inside the container reached the model as an image (the smoke test proves it for this model and
  route); not checked for any other model string.
