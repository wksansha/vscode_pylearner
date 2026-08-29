# Remaining Work Checklist

> Last updated: 2026-08-29. Tracks what's left after P1 (update), P2 (memoryGraph), and P3 (dedup/merge).

## Implemented (context, not a todo)

- **P1 — L1→L2→L3 pipeline**: `src/memory/update.ts` (`updateL2`/`updateL3`), chunker, document parse/serialize, ops, references, guards, meta, paths, store, snapshot adapter/reader, prompts, settings, profile injection.
- **P2 — memoryGraph panel**: `src/memory/graph.ts`, `src/commands/memoryGraph.ts`, `src/chat/profileViewProvider.ts`.
- **P3 — dedup/merge passes**: `src/memory/lineDoc.ts`, `dedup.ts`, `merge.ts`, plus refs-preserved observability on the replace fallback.
- **Wiring**: `pylearner.updateProfile` command, `ProfileRefresher` lazy auto-refresh, profile injection into chat (`messageHandler.ts`); atomic writes via `fs.rename` in `store.ts`.

## Remaining

### P4 — audit mode (planned, not started)

The 4th DeepTutor consolidator mode: line-level fact-check against raw evidence. The pipeline is functionally complete without it; audit is a quality pass.

- [ ] Port `audit.py` + `audit_l2.yaml` + `audit_l3.yaml`
- [ ] Audit prompt builders (annotated-chunk renderer — shows each entry's full sources, unlike dedup's sanitized view)
- [ ] `src/memory/audit.ts` runner + `settings.ts` `audit.autoAfter*`
- [ ] Wire into `update.ts` (audit → merge ordering, mirroring dedup)

Note: `InsertAfterOp` in `lineDoc.ts` is already reserved for audit (dedup forbids insert).

### P1+ expansions (spec §9 — "deferred, recorded")

- [ ] **9.1 Precise/hybrid retrieval** — vector + BM25 + RRF + graph query (when L2 grows large)
- [ ] **9.2 Eval methodology** — "with-profile vs without-profile" benchmark; at least one informal eval (spec recommends doing this at P1 close-out)
- [ ] **9.3 Facts↔facts lateral links** — `[[wikilink]]`; today only vertical footnotes (entry→evidence) exist
- [ ] **9.4 Profile portability** — export/import `.zip` (l2/ + l3/ + meta/)
- [ ] **9.5 Markdown disaster recovery** — **spec §9.5 is empty; needs a spec before implementation**
- [ ] **9.6 Extra L3 slots** — `updateL3` already handles recent/scope, but `updateProfile.ts` only invokes `profile`

## Spec gap

- [ ] Fill in spec §9.5 ("Markdown 灾难恢复") — currently a heading with no content.
