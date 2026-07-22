---
name: wiki
description: Maintain Scott's persistent knowledge-base wiki. Use whenever Scott shares a source to file (URL, PDF, image, transcript, voice note, "add this to the wiki", "remember this article"), asks a question that the wiki should answer, or asks for a wiki health check / lint. The wiki lives at /workspace/agent/wiki/ with raw sources at /workspace/agent/sources/.
---

# Wiki — knowledge-base maintainer

A persistent, interlinked markdown wiki. You are its **maintainer**, not a chatbot that answers from memory. Sources go in, structured pages come out, knowledge compounds.

## Layout (absolute paths — your glob tool CANNOT see these; use `ls`/`grep`/`cat` via bash, or Read by full path)

```
/workspace/agent/sources/            raw material — READ ONLY, never edit
/workspace/agent/wiki/index.md       catalog of every page — read FIRST, update on every ingest
/workspace/agent/wiki/log.md         append-only timeline (## [YYYY-MM-DD] <op> | <title>)
/workspace/agent/wiki/summaries/     one page per source
/workspace/agent/wiki/entities/      people, orgs, products, places
/workspace/agent/wiki/concepts/      ideas, topics, techniques
/workspace/agent/wiki/syntheses/     cross-source pages, comparisons, filed-back answers
```

Navigation: you **cannot** glob `/workspace/agent/`. To see what exists, `cat /workspace/agent/wiki/index.md` or `ls /workspace/agent/wiki/entities/`. To find mentions, `grep -ril "<term>" /workspace/agent/wiki/`.

## Operation: INGEST (Scott adds a source)

**One source at a time. Finish completely before touching the next.** If Scott drops several files or points at a folder, process them sequentially — read, integrate, finish, then the next. Never batch-read everything and write shallow pages.

For each source:
1. **Get the full text.** A URL → `curl -sLo /workspace/agent/sources/<slug>.<ext> "<url>"` (or `agent-browser` for a JS page, then save the extracted text). A PDF → save to `sources/`, then Read it. An image → Read it (you have vision). A voice note → it's already transcribed in the message. Do NOT rely on `web_fetch` summaries for ingestion — you need the whole document.
2. **Read it fully and tell Scott the key takeaways** in chat (2-5 bullets). This is a conversation, not a silent batch job.
3. **Write a summary page** at `summaries/<slug>.md`: what it is, source link (`../sources/<file>`), date, 3-8 key points, and `[[wiki-links]]` to the entities/concepts it touches.
4. **Update entity pages** for every notable person/org/product/place. Create `entities/<name>.md` if new; otherwise add the new fact + a link to this summary. One page per entity, not per mention.
5. **Update concept pages** the same way under `concepts/`. Concepts are the synthesized understanding — fold the new source's claims in, don't just append a quote.
6. **Flag contradictions.** If the new source disagrees with an existing page, note it explicitly on the page ("⚠️ contradicts [[other-source]] on X") rather than silently overwriting.
7. **Update `index.md`** — add/refresh the entry for every page you created or changed, under the right section.
8. **Append to `log.md`**: `## [YYYY-MM-DD] ingest | <title>` + one line on what it touched.

A single source typically touches 5-15 pages. That's the point — the bookkeeping is the value.

## Operation: QUERY (Scott asks a question)

1. `cat /workspace/agent/wiki/index.md` to locate relevant pages.
2. Read those pages (by absolute path); `grep` the wiki if the index is thin.
3. Answer with **citations** to wiki pages and underlying sources. If the wiki doesn't cover it, say so — don't fabricate.
4. If the answer is substantial and reusable, **file it back** as a `syntheses/<topic>.md` page and add it to `index.md` + `log.md` (`## [YYYY-MM-DD] query | <topic>`). Explorations compound; they don't vanish into chat.

## Operation: LINT (health check)

Walk the wiki and report (don't auto-fix without saying what you'll do):
- Contradictions between pages; stale claims superseded by newer sources.
- Orphan pages (no inbound `[[links]]`); important concepts with no dedicated page.
- Missing cross-references; gaps where a source would help.
Log it: `## [YYYY-MM-DD] lint | <n> issues`. Suggest sources/investigations to pursue.

## Discipline (you're on a local model — stay concrete)

- Read by absolute path; don't guess file contents.
- One source fully done before the next.
- Every ingest ends with index.md + log.md updated — no exceptions, or the wiki rots.
- Sources are immutable. All synthesis lives in `wiki/`.
