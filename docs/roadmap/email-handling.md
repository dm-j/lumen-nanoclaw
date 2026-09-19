# Email handling

An adapter exists now (`/add-resend`, Resend via Chat SDK, in the `channels` branch —
copies `src/channels/resend.ts` + registration test, installs
`@resend/chat-sdk-adapter`), but as of 2026-09-19 it hasn't been applied to this install:
`src/channels/` here has no `resend.ts`, and `ncl messaging-groups list` shows only
`telegram` and `cli` — no email channel wired to any agent group. Updated from the
original "no adapter yet" wording per a roadmap-staleness sweep, which found the skill
exists but confirmed nothing live uses it.

Next step if picked up: run `/add-resend`, then wire it to an agent group per
[docs/customizing.md](../customizing.md)'s channel-skill pattern.
