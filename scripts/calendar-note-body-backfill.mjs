#!/usr/bin/env node
// One-off backfill for calendar event notes (spec: docs/roadmap/calendar-event-note-body.md).
// For every event note under 07-Daily/Calendar (not _index.md, not _series/):
//   1. removes the `**When:**` line,
//   2. screens the Microsoft Teams signature down to the join link, Meeting ID, Passcode, Phone Conference ID,
//   3. puts the remaining description in a single `> ` quote block ending in a `^event-desc` block ID line.
// Idempotent (skips notes that already have the marker). Dry run by default.
// Usage: node scripts/calendar-note-body-backfill.mjs [--apply] [--show N] [--root <Calendar dir>]
import fs from "fs";
import path from "path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const SHOW = Number(arg("--show", 3));
const ROOT = arg("--root", `${process.env.HOME}/Projects/obsidian/lumen-data/lumen-data/07-Daily/Calendar`);
const MARK = "^event-desc";
const RULE = /^_{20,}\s*$/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "_series" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md") && e.name !== "_index.md") yield p;
  }
}

/** Keepers of one Teams segment, in a fixed order. Empty array if it has none. */
function teamsKeepers(lines) {
  const find = (re) => lines.map((l) => re.exec(l.trim())).find(Boolean);
  const join = find(/^Click here to join the meeting\s*<(https?:[^>]+)>/i) ?? find(/^Join:\s*(https?:\/\/\S+)/i);
  const id = find(/^Meeting ID:\s*(.+)$/i);
  const pass = find(/^Passcode:\s*(.+)$/i);
  const phone = find(/^Phone Conference ID:\s*(.+)$/i);
  return [
    join && `[Join the meeting](${join[1]})`,
    id && `Meeting ID: ${id[1].trim()}`,
    pass && `Passcode: ${pass[1].trim()}`,
    phone && `Phone Conference ID: ${phone[1].trim()}`,
  ].filter(Boolean);
}

/** Splits the description on 80-underscore rules; a segment mentioning Teams is replaced by its keepers and the
 * rules touching it are dropped. Text outside such segments (an organizer's agenda) is untouched. */
function screenTeams(desc) {
  const lines = desc.split("\n");
  const segs = []; // {rule:boolean, lines:string[]}
  let cur = [];
  for (const l of lines) {
    if (RULE.test(l)) {
      segs.push({ rule: false, lines: cur });
      segs.push({ rule: true, lines: [l] });
      cur = [];
    } else cur.push(l);
  }
  segs.push({ rule: false, lines: cur });
  const isTeams = (s) => !s.rule && /teams\.microsoft\.com|Microsoft Teams meeting|Join with a video conferencing device/i.test(s.lines.join("\n"));
  const out = [];
  segs.forEach((s, i) => {
    if (s.rule) {
      const near = isTeams(segs[i - 1] ?? { rule: true, lines: [] }) || isTeams(segs[i + 1] ?? { rule: true, lines: [] });
      if (!near) out.push(...s.lines);
    } else if (isTeams(s)) {
      const keep = teamsKeepers(s.lines);
      if (keep.length && out.length && out[out.length - 1].trim()) out.push(""); // set off from the organizer's own text
      out.push(...keep);
    }
    else out.push(...s.lines);
  });
  return out.join("\n");
}

const tidy = (s) => s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

/** Returns {text} or {skip: reason}. */
function transform(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { skip: "no frontmatter" };
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return { skip: "unterminated frontmatter" };
  const head = text.slice(0, end + 5);
  const body = text.slice(end + 5);
  if (body.split("\n").some((l) => l.trim() === MARK)) return { skip: "already migrated" };
  const m = /^\n*# (.+)\n/.exec(body);
  if (!m) return { skip: "no title line" };
  const rest = body
    .slice(m[0].length)
    .split("\n")
    .filter((l) => !l.startsWith("**When:**"))
    .join("\n");
  const desc = tidy(screenTeams(tidy(rest)));
  const quoted = desc ? desc.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : ">";
  return { text: `${head}# ${m[1]}\n\n${quoted}\n\n${MARK}\n`, teams: /Download Teams|Or call in|Learn More/.test(rest) };
}

const stats = { total: 0, changed: 0, skipped: {}, teamsScreened: 0, leftovers: [] };
let shown = 0;
for (const file of walk(ROOT)) {
  stats.total++;
  const raw = fs.readFileSync(file, "utf8");
  const r = transform(raw);
  if (r.skip) {
    stats.skipped[r.skip] = (stats.skipped[r.skip] ?? 0) + 1;
    continue;
  }
  stats.changed++;
  if (r.teams) stats.teamsScreened++;
  if (/Download Teams|Or call in|Learn More|Find a local number|Dial in by phone|Need help|For organizers|conferencing device|Alternate VTC|Reset PIN|System reference|_{20,}|\*\*When:\*\*/.test(r.text)) stats.leftovers.push(file);
  if (arg("--only", "") ? file.includes(arg("--only", "")) : shown < SHOW && (r.teams || shown === 0)) {
    shown++;
    console.log(`\n===== ${path.relative(ROOT, file)} (after) =====\n${r.text.slice(r.text.indexOf("\n---\n", 3) + 5)}`);
  }
  if (APPLY) {
    const tmp = `${file}.tmp-backfill`;
    fs.writeFileSync(tmp, r.text);
    fs.renameSync(tmp, file);
  }
}
console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${JSON.stringify(stats, null, 1)}`);
