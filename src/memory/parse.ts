// Tolerant parsing of LLM output.
//
// LLM responses routinely wrap JSON in code fences and prose framing. This
// module strips that framing and pulls out the first top-level JSON object,
// then coerces the `{"facts": [...]}` envelope (used by the update flow)
// into typed facts. Failure returns [] — never throws — so one bad output
// never sinks an entire run.

export interface ExtractedFact {
  text: string;
  section: string;
  refs: string[];
}

/** Strip code fences and extract the first top-level JSON object. */
export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "");
  text = text.replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

// Sloppy LLM output patterns that must never survive into a fact's "text".
// The model is told to put citations in the "refs" array, but weak models
// routinely spray them through the prose instead: a leading "- " (as if the
// fact were itself a bullet), inline [^m_xxx] / [^1] footnote markers, and
// parenthetical surface labels like "(chat)" or "(edit:01KZX0..., edit:01KZX0...)".
// Leaving them in place pollutes every downstream render — including the L3
// chunk, where the next model then copies the m_xxx ids into its own prose.
const _LEADING_MARKER_RE = /^(?:\s*(?:[-*]|\d+\.)\s+)+/;
const _FOOTNOTE_RE = /\[\^[^\]]+\]/g;
const _SURFACE_RE = /\((?:edit|run|chat|debug|diag)(?::[0-9A-Za-z]+)?(?:\s*,\s*(?:edit|run|chat|debug|diag)(?::[0-9A-Za-z]+)?)*\)/g;

/** Strip LLM-sprayed citation noise out of a fact's prose text. */
export function sanitizeFactText(text: string): string {
  let t = text.trim();
  t = t.replace(_LEADING_MARKER_RE, "");
  t = t.replace(_FOOTNOTE_RE, "");
  t = t.replace(_SURFACE_RE, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Parse a `{"facts":[{text,section,refs}]}` envelope into facts. */
export function parseFacts(raw: string): ExtractedFact[] {
  const snippet = extractJsonObject(raw);
  if (snippet === null) return [];

  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];

  const factsRaw = (data as Record<string, unknown>).facts;
  if (!Array.isArray(factsRaw)) return [];

  const facts: ExtractedFact[] = [];
  for (const item of factsRaw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const text = sanitizeFactText(typeof rec.text === "string" ? rec.text : "");
    if (!text) continue;
    const section = typeof rec.section === "string" ? rec.section.trim() : "";
    const refs = Array.isArray(rec.refs)
      ? rec.refs
          .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
          .map((r) => (r as string).trim())
      : [];
    facts.push({ text, section, refs });
  }
  return facts;
}
