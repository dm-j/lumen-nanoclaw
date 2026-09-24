# Lumen: replace the rendered day schedule with "Now and Next" (NOTED FOR DAVID TO CONSIDER, NOT DECIDED)

Raised 2026-09-24 by David as a note to address later. Status: **a suggestion to consider, nothing decided or built.**

**The idea.** Consider removing Lumen's rendered day schedule and replacing it with a **"Now and Next"** view: the time until the
end of the current event (if any) and the time until the start of the next one (if any). The aim is to cut Lumen's context load down
to the **most immediate information** and push the **full calendar responsibility back onto Routine**.

## What Lumen's "rendered day schedule" is today (checked 2026-09-24)

Nothing injects a schedule into her prompt directly. She receives it as **messages from Routine**, sent by three scheduled tasks
(each also does Routine's own work):

- `morning-calendar-digest` (06:00): today's and tomorrow's events with off-site markers; also creates the pre-event boop and verify tasks.
- `midday-calendar-check` (11:59) and `evening-calendar-check` (18:00): what remains of the day; an explicit "rest of today is clear"
  message when nothing does.

Those messages become part of her turns, so they also feed the compiled briefing and recent turns. Since 2026-09-23 the calendar tools
return work events as well as personal ones (each labelled), so these digests can be longer than before.

(An observation, not a task: her current compiled briefing states that Routine "includes your calendar schedule in Lumen's injected
context each turn". That is not what the system does; the briefer model inferred it. Worth knowing if it reads oddly.)

## Sketch of what it would look like

- **A `now-next` segment** in the context-injection assembler ([context-injection-segments.md](context-injection-segments.md)),
  recomputed every turn from the calendar, for example:
  `Now: A-Team Standup (work), ends in 12m.  Next: Lunch (personal), in 1h 40m, 11:00 AM, off-site.`
  Either half is omitted when there is nothing (no current event, no later event today).
- **Routine keeps the whole calendar** (reading, digests if wanted, boops and verify tasks, conflict detection). Lumen, who is the
  manager, asks Routine through Dispatcher for anything beyond now and next ("what does Friday look like?"), as her persona already
  says for calendar work.
- The digest-to-Lumen part of the three tasks would shrink or go; the boops (event-anchored nudges) are a separate thing and stay.

## Things to check when this is picked up

- **The injection read must not call the sync.** The calendar read path Routine uses runs `sync.js --days=N` before reading
  (`syncCalendar` in `range-events.ts`), a network fetch and file writes on every call. That is fine for a tool call, wrong for a
  per-turn segment (and against the read-only rule for segments). The segment should read the vault's calendar notes directly; the
  hourly cron already keeps them fresh.
- **Sync throttle (a likely consequence).** Today every calendar tool call syncs first, and nothing prevents overlapping runs. Adding a
  min-age flag and a lock to `sync.js` (vault project) is worth doing alongside this; the spec is at the end of
  [vault-sync-handoff-brief.md](vault-sync-handoff-brief.md) ("hybrid throttle": run on the first hit, coalesce concurrent callers onto the in-flight run, throttle the rest).
- **Cost:** one segment is about 0.75 s cold, in parallel with the others; the computation itself is trivial (the shims already
  produce `time_until_start` and `time_until_end` for each event).
- **Edge cases:** all-day events (probably not "now"), overlapping events (show all current? the one ending soonest?), events that
  cross midnight, cancelled or deleted events (already excluded), work versus personal labels, the group's timezone.
- **What Lumen loses:** she can no longer see the rest of the day at a glance. If she needs it she must ask, which costs a delegation
  round trip; decide whether "next" should look ahead further than the next single event.
- **Message hygiene:** if the digests to Lumen stop, decide what happens to the "rest of today is clear" reassurance message.

## Open questions

- Show only the single current and single next event, or the next two or three?
- Do the morning digest and evening check to Lumen go away entirely, or shrink to one line?
- Should Now and Next include work events (labelled), personal only, or both?
