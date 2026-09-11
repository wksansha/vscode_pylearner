// Chinese translation pass for the displayed L3 profile.
//
// The consolidation LLM (L2 → L3) is left in English on purpose: it is a
// structured synthesis task and English is the safer lingua franca for it.
// But the profile that a Chinese-speaking student or teacher actually reads
// must be in Chinese, so this pass translates the stored L3 doc's prose
// after synthesis.
//
// Structure is preserved BY THE ENGINE, not by LLM compliance: entries are
// sent as a JSON array of {id, text}, the LLM translates each `text`, and the
// result is mapped back onto the original Document by entry id. Section
// names, refs, and entry-id anchors never leave the host, so a model that
// drops a field or returns malformed JSON simply leaves that entry in
// English rather than corrupting the document.

import { Document } from "./document";
import type { L3Slot } from "./paths";

export interface TranslateDeps {
  callLlm(system: string, user: string): Promise<string>;
  loadL3Doc(slot: L3Slot): Promise<Document | null>;
  saveL3Doc(slot: L3Slot, doc: Document): Promise<void>;
  onEvent?: (event: Record<string, unknown>) => void;
}

/** How many entries to translate per LLM call. */
const BATCH_SIZE = 50;

/** Strip code fences and pull out the first top-level JSON array. */
function extractJsonArray(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "");
  text = text.replace(/\s*```$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

const TRANSLATE_SYSTEM = `You are a translation pass for the Python Learner memory system.

Translate every "text" field below into Chinese (中文). The source prose may
be in English — translate it into natural Chinese.

Return the SAME JSON array, in the SAME order, with the SAME "id" values.
Only the "text" values may change. Output ONLY the JSON array — no prose, no
fences, no explanation.

Example:
input  [{"id":"m_ABC","text":"types 'print' incrementally"}]
output [{"id":"m_ABC","text":"逐字符增量式地输入 print"}]`;

export interface TranslateResult {
  ok: boolean;
  /** Entries whose text was actually translated. */
  translated: number;
  /** Entries left in English because the LLM didn't return them. */
  untouched: number;
}

/**
 * Translate the prose of entries in an L3 doc into Chinese. The doc's
 * structure (title, sections, refs, entry ids) is untouched.
 *
 * If `newEntryIds` is provided, ONLY those entries are sent to the LLM —
 * previously-translated entries are left in Chinese without re-costing a call.
 * This is the key optimization for small incremental updates: the profile
 * grows a few facts per run, not wholesale.
 *
 * Returns `ok: false` only when the LLM produced nothing usable at all — in
 * that case the caller should leave the English doc in place.
 */
export async function translateL3Doc(
  deps: TranslateDeps,
  slot: L3Slot,
  newEntryIds?: string[]
): Promise<TranslateResult> {
  const doc = await deps.loadL3Doc(slot);
  if (!doc) return { ok: false, translated: 0, untouched: 0 };

  const all = doc.allEntries();
  if (all.length === 0) return { ok: true, translated: 0, untouched: 0 };

  // Incremental: only translate entries whose text is still in English
  // (i.e., not yet translated in a previous run). Previously translated
  // entries keep their Chinese text untouched — no LLM budget wasted.
  const idSet = new Set(newEntryIds);
  const toTranslate = newEntryIds && newEntryIds.length > 0
    ? all.filter((e) => idSet.has(e.id))
    : all.filter((e) => e.refs.length === 0 || looksEnglish(e.text));

  if (toTranslate.length === 0) {
    return { ok: true, translated: 0, untouched: all.length };
  }

  const textById = new Map<string, string>();
  let translated = 0;

  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    const batch = toTranslate.slice(i, i + BATCH_SIZE);
    const payload = JSON.stringify(batch.map((e) => ({ id: e.id, text: e.text })));
    let data: unknown;
    try {
      const callStart = Date.now();
      const context = `translate:batch${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toTranslate.length / BATCH_SIZE)}`;
      const raw = await deps.callLlm(TRANSLATE_SYSTEM, payload);
      const llmElapsed = Date.now() - callStart;
      if (deps.onEvent) {
        deps.onEvent({
          stage: "llm_call",
          layer: "translate",
          batch_index: Math.floor(i / BATCH_SIZE) + 1,
          total_batches: Math.ceil(toTranslate.length / BATCH_SIZE),
          entries_in_batch: batch.length,
          elapsed_ms: llmElapsed,
          context,
        });
      }
      const json = extractJsonArray(raw);
      if (json === null) continue;
      data = JSON.parse(json);
    } catch {
      continue; // bad batch — leave those entries in English
    }
    if (!Array.isArray(data)) continue;
    for (const item of data) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        const rec = item as { id: string; text: string };
        if (textById.has(rec.id)) continue;
        textById.set(rec.id, rec.text);
        translated += 1;
      }
    }
  }

  if (translated === 0) return { ok: false, translated: 0, untouched: toTranslate.length };

  const out = new Document(doc.title);
  for (const [section, entries] of doc.sections) {
    out.sections.push([
      section,
      entries.map((e) => {
        const t = textById.get(e.id);
        return t !== undefined ? { ...e, text: t } : e;
      }),
    ]);
  }
  await deps.saveL3Doc(slot, out);
  return { ok: true, translated, untouched: toTranslate.length - translated };
}

/** Heuristic: does `text` look like it still needs Chinese translation? */
function looksEnglish(text: string): boolean {
  // Simple check: presence of common English words or Latin script tokens.
  // If it already contains significant Chinese characters, skip it.
  const zhHits = (text.match(/[一-鿿]/g) ?? []).length;
  if (zhHits > 5) return false; // already mostly Chinese
  // Otherwise treat as needing translation
  const enTokens = (text.match(/[a-zA-Z]{4,}/g) ?? []).length;
  return enTokens > 0;
}