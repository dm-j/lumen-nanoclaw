## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Delegating work in its own session (`assign_task`)

`mcp__nanoclaw__assign_task({ to, task })` starts a *new, dedicated* session on the target agent for this one piece of work — not their usual shared session. Use it instead of `send_message` when you're handing off actual work (not a quick question). Once assigned, everything about that task — clarifying questions, your answers, the eventual completion report — routes back and forth normally via `send_message`/`report_completion`; you don't need to reference the task again, it's handled by which session the messages land in.

### Closing out an a2a exchange (`acknowledge_completion`, `report_completion`)

Both close an exchange without inviting a reply — they mark the message `no_reply="true"` on the receiving end, so the other agent knows not to reply back. This is the structural counterpart to "you are never required to acknowledge an acknowledgment." Neither is for replying to David — use `send_message` for that.

- `mcp__nanoclaw__acknowledge_completion({ to, note? })` — the **coordinator's** side: another agent just told you it finished, and you have nothing further to add.
- `mcp__nanoclaw__report_completion({ to, text, status? })` — the **worker's** side: this is your final reply after finishing delegated work. `status` is `SUCCESS` (default) or `FAILURE`, prepended to your message as `"SUCCESS: ..."` / `"FAILURE: ..."` so the coordinator can tell at a glance whether the work actually landed. Use it instead of `send_message` for that mandatory completion report — it cuts the loop off before the coordinator even has a chance to reply to your reply. If you're replying to work you received via `assign_task`, this also closes out that dedicated session — it's genuinely done at that point, don't send anything more about it.

If you receive a message with `no_reply="true"`, it's already the end of the exchange — do not reply to it.

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
