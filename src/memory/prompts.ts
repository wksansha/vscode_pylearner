// Prompt builders for the L2/L3 update flow.
//
// Ported from DeepTutor's `en/update_l2.yaml` and `en/update_l3.yaml`.
// Each chunk is one LLM call returning `{"facts": [...]}`; the runtime
// validates refs against the chunk-local pool then appends to the doc.

export function buildL2System(
  userLabel: string,
  surface: string,
  sections: string,
  focus: string,
  today: string
): string {
  return `You are the memory curator for Python Learner user ${userLabel}.

ROLE: You are reading a chunk of the user's recent ${surface} activity
(raw, untruncated). Extract durable facts about the user.

LANGUAGE — THIS IS NON-NEGOTIABLE: every fact's "text" field MUST be in
Chinese (中文). The source activity (code, file paths, error messages) is
in English — that does not give you permission to answer in English.
Translate and rephrase into Chinese. Section names stay English (they are
the schema keys). A fact written in English is a wrong answer.

OUTPUT: A single JSON object — nothing else, no prose, no fences.

    {"facts": [
      {"text":   "<≤240 chars; one fact per item>",
       "section": "<one of: ${sections}>",
       "refs":   ["<surface>:<entity_id>", ...]}}
    ]}

HARD RULES
- Every fact must have ≥1 ref. Each ref must come from the
  "Chunk-local citeable refs" list or the "@entity <surface>:<id>"
  markers you see in the chunk below — do NOT invent ids, do NOT cite
  entities outside this chunk.
- text ≤ 240 chars. Be terse, verb-led ("uses X", "stuck on Y").
- Banned absolutist phrasing (unless wrapping in "..." or 「...」):
  deeply, truly, mastered, expert, passionate, loves, hates, always,
  never, fully understands.
- Surface focus: ${focus}.
- If nothing material is in this chunk, emit {"facts": []} —
  that is a correct, expected answer.

Today is ${today}.`;
}

export function buildL2User(
  surface: string,
  existing: string,
  chunk: string,
  chunkIndex: number,
  chunkTotal: number,
  chunkStart: number,
  chunkEnd: number
): string {
  return `# Existing ${surface} memory (do not duplicate items already captured here):
${existing}

# Source chunk ${chunkIndex}/${chunkTotal} (chars ${chunkStart}..${chunkEnd}):
----------------------------------------------------------------
${chunk}
----------------------------------------------------------------

Return JSON. Cite only refs listed or visible in the chunk above.`;
}

export function buildL3System(
  userLabel: string,
  slot: string,
  sections: string,
  focus: string,
  today: string
): string {
  return `You are the cross-surface memory curator for Python Learner user ${userLabel}.

ROLE: You are reading a chunk of L2 summaries from one or more surfaces.
Synthesize durable, hedged claims about the user.

LANGUAGE — THIS IS NON-NEGOTIABLE: every fact's "text" field MUST be in
Chinese (中文). The source L2 material may be in English — that does not
give you permission to answer in English. Translate and rephrase into
Chinese. Section names stay English (they are the schema keys). A fact
written in English is a wrong answer, not a style choice. Model answer:

    {"facts": [
      {"text":   "在多个编辑交互中，用户反复增量式地输入标识符，每次只改一行就保存",
       "section": "Learning style",
       "refs":   ["edit"]}
    ]}

OUTPUT: A single JSON object — nothing else.

    {"facts": [
      {"text":   "<≤240 chars, hedged with surface/count, in Chinese>",
       "section": "<one of: ${sections}>",
       "refs":   ["<surface>", ...]}}
    ]}

HARD RULES
- refs are bare surface names taken from the chunk's
  "Chunk-local citeable refs" list (e.g. chat, edit). Never emit m_xxx,
  surface:id, or any entry id. One fact may cite multiple surfaces.
- The "text" field is PROSE ONLY. Do not spray citations through it: no
  [^...] markers, no (chat) / (edit:01KZX...) parentheticals, no leading
  "- " bullet marker. Citations belong exclusively in the "refs" array.
- text ≤ 240 chars. Forced hedge template: claims must be of the form
  "Across N <surface> interactions, the user X" or
  "<surface> entries show the user X" — bind to a surface or count.
- Banned absolutist phrasing (unless quoting with "..." or 「...」).
- Spread claims across as many of the allowed sections (${sections}) as
  the input supports. One fact per section is fine; do not pile every
  claim into a single section. If the chunk shows a pattern on one surface
  and a misconception on another, emit both — in separate facts.
- Slot focus: ${focus}.
- Empty {"facts": []} is a correct answer if nothing in this chunk
  warrants a new L3 claim.

Today is ${today}.`;
}

export function buildL3User(
  slot: string,
  existing: string,
  chunk: string,
  chunkIndex: number,
  chunkTotal: number
): string {
  return `# Existing ${slot} memory (do not duplicate):
${existing}

# L2 chunk ${chunkIndex}/${chunkTotal}:
----------------------------------------------------------------
${chunk}
----------------------------------------------------------------

Return JSON. Cite only surface names from the "Chunk-local citeable
refs" list at the top of the chunk.`;
}

export function buildDedupSystem(userLabel: string, today: string): string {
  return `You are the memory dedup pass for Python Learner user ${userLabel}.

ROLE: Read the entire memory document below as a line-numbered view.
Merge duplicates, collapse near-duplicates by replacing one and
deleting the others, and rewrite muddled entries.

OUTPUT: A single JSON object — nothing else.

    {"edits": [
      {"op": "replace", "line": <int>, "new_text": "<≤240>",
       "refs": ["<existing-refs>", ...], "reason": "<short>"},
      {"op": "delete",  "line_start": <int>, "line_end": <int>,
       "reason": "<merged into Lx | duplicate of Ly | low signal>"}
    ]}

HARD RULES
- You may use ONLY replace and delete — no insert. Dedup never adds.
- When merging A and B: keep the higher-quality one (replace its line
  with the merged text, union of refs) and delete the other.
- When two entries restate the same fact verbatim, delete the later
  duplicate (lower-line wins).
- text ≤ 240. Preserve refs (union when merging); refs are the
  parenthesized citations shown after each bullet. Do NOT invent refs.
- Banned absolutist phrasing (same list as update mode).
- If nothing needs deduping, emit {"edits": []}. Don't churn.

Today is ${today}.`;
}

export function buildDedupUser(
  doc: string,
  iteration: number,
  iterationsTotal: number
): string {
  return `# Memory document (line-numbered):
----------------------------------------------------------------
${doc}
----------------------------------------------------------------

Iteration ${iteration}/${iterationsTotal}. Return JSON.`;
}
