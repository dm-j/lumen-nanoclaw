# DAVID: GIVE THIS TO THE VAULT CLAUDE

Do this when you are rested. It takes about two minutes, and the vault Claude does the rest.

## Why

Your calendar notes were tidied on 2026-09-23 (no `**When:**` line, Teams signature cut down, description in a quote block).
The hourly sync still writes the OLD format. The first time an event changes upstream, that note reverts and anything you typed
below its quote block is lost. The vault Claude has to fix the sync script. That is the whole job.

## Steps

1. Open a terminal:

   ```
   cd ~/Projects/obsidian/lumen-data/lumen-data
   claude
   ```

2. Paste this message exactly:

   ```
   Please read /Users/lumen/Projects/lumen-nanoclaw/docs/roadmap/vault-sync-handoff-brief.md and carry it out in
   scripts/calendar-sync/. It is self-contained. Rules: work on a COPY of 07-Daily/Calendar first and show me the test results
   before you touch the real notes; ask me before anything destructive; a backup of the whole Calendar folder already exists at
   ~/lumen-calendar-backup-20260923.tgz. Decisions already made: keep the Teams screening exactly as the brief says (the dial-in
   phone number and video conference ID stay dropped), and for multi-day events make sure an _index.md exists for every covered day.
   ```

3. Let it work. When it says it is done, ask it: **"Show me one note re-rendering after a simulated upstream change, with text I typed
   below the ^event-desc line still there."** If it can show that, you are finished.

## Your one decision (already answered above)

- Dial-in phone number: currently dropped, as you asked. If you would rather keep it, change that sentence in the message before
  you paste it to: "keep the dial-in phone number line as well".

## If something goes wrong

Restore the calendar notes from the backup:

```
tar -xzf ~/lumen-calendar-backup-20260923.tgz -C ~/Projects/obsidian/lumen-data/lumen-data/07-Daily
```

Then tell the lumen-nanoclaw Claude what happened.

## Later (not urgent)

- The vault has no git remote (only a nightly local commit) and PrefixRouter has none either.
- Whether work calendar events should feed the digest pipeline (it sends text to outside model providers).
