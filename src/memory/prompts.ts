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

OUTPUT: A single JSON object — nothing else.

    {"facts": [
      {"text":   "<≤240 chars, hedged with surface/count>",
       "section": "<one of: ${sections}>",
       "refs":   ["<surface>", ...]}}
    ]}

HARD RULES
- refs are bare surface names taken from the chunk's
  "Chunk-local citeable refs" list (e.g. chat, edit). Never emit m_xxx,
  surface:id, or any entry id. One fact may cite multiple surfaces.
- text ≤ 240 chars. Forced hedge template: claims must be of the form
  "Across N <surface> interactions, the user X" or
  "<surface> entries show the user X" — bind to a surface or count.
- Banned absolutist phrasing (unless quoting with "..." or 「...」).
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
