#!/bin/sh
NOTES="$(host-shim notes/read 2>&1)"
if [ "${#NOTES}" -gt 4000 ]; then
  NOTES="$(printf %s "$NOTES" | head -c 4000)
[...truncated: use notes_read for the full list]"
fi
TODAY="$(date "+%A %Y-%m-%d")"
WAKE_NOTES="Today is $TODAY. Notes on the daily note for today, each with its ID in brackets. When a note is no longer useful, because it is completed, cancelled, or no longer relevant, actively delete it with notes_delete. Change one with notes_edit.
$NOTES" node -e "console.log(JSON.stringify({wakeAgent:true,data:process.env.WAKE_NOTES||\"\"}))"

