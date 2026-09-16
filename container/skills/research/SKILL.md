---
name: research
description: >-
  Use when asked to look something up, learn about a topic, do a deep
  dive, prepare a briefing, or whenever you need to know more about
  something to do your job well.
---

# Research

## 1. Check the vault first

Call `recall` before searching the web — the vault may already have an
answer, and reusing it is cheaper and stays consistent with what this
group already believes. Pass `research: true` if the question needs more
than a quick lookup.

## 2. Fill gaps with web search

For anything `recall` doesn't cover, or anything time-sensitive, use
WebSearch/WebFetch (or the Tavily search/extract tools if this group has
them installed instead) to find current information. Explicitly check
whether what you found is still up to date — prefer primary sources and
recent dates over old cached summaries, and say so if a source looks
stale.

## 3. Save what you learn

Use `remember` to write new facts and conclusions back to the vault once
you've verified them — not just raw search results, but the actual
answer or insight, so future turns can `recall` it instead of
re-researching. Skip this for information that's already in the vault or
obviously ephemeral (won't matter next week).

## 4. Cite your sources as wikilinks

When you write a `remember` note (or answer the user), link what you
used: `[[Vault Note Title]]` for anything that came from `recall`, and a
plain URL (or `[[url]]`-style link if the vault convention wants one) for
anything from the web. Citations are what let the vault's memory system
weave this note into the rest of the knowledge graph — an uncited
conclusion is a dead end for future recall.
