// Markdown documents with footnote-style citations.
//
// Each L2/L3 file is a markdown document of the form:
//
//     # <Title>
//
//     ## <section_a>
//     - <text> [^1][^2] <!--m_xxx-->
//
//     ---
//
//     [^1]: edit:01HZK4...
//     [^2]: chat:01HZK5...
//
// Footnote labels are integers assigned per-document in first-appearance
// order over the bullet stream. Two entries citing the same source share a
// label, so duplicate footnote rows disappear from the rendered view.
//
// The trailing HTML comment after each bullet (`<!--m_xxx-->`) is the entry
// id anchor; it survives round-trips and is how delete/edit locate an entry.
// The parser also accepts a legacy format where a bullet ends in `[^m_xxx]`
// and footnotes are `[^m_xxx]: ref1, ref2`, migrating it on the next save.
//
// parse/serialize are pure — no I/O, no LLM. Round-trip
// `serialize(parse(x))` is idempotent for any document produced by
// `serialize`.

const _ENTRY_ID = "m_[0-9A-HJKMNP-TV-Z]{26}";

const _TITLE_RE = /^#\s+(.+?)\s*$/;
const _SECTION_RE = /^##\s+(.+?)\s*$/;

// New bullet: "- text [^1], [^3] <!--m_xxx-->". Markers are optional (an
// entry may cite no refs); commas + whitespace between markers are
// tolerated so rendered superscripts read "1, 3" not "13".
// String.raw keeps the backslashes verbatim for the RegExp constructor.
const _NEW_BULLET_RE = new RegExp(
  String.raw`^\s*-\s+(?<text>.*?)(?<markers>(?:\s*,?\s*\[\^[^\]]+\])*)\s*<!--\s*(?<id>${_ENTRY_ID})\s*-->\s*$`
);
// Legacy bullet: "- text[^m_xxx]"
const _OLD_BULLET_RE = new RegExp(
  String.raw`^\s*-\s+(?<text>.*?)\[\^(?<id>${_ENTRY_ID})\]\s*$`
);
// Legacy footnote def: "[^m_xxx]: ref1, ref2"
const _OLD_FOOTNOTE_RE = new RegExp(
  String.raw`^\[\^(?<id>${_ENTRY_ID})\]:\s*(?<refs>.*?)\s*$`
);
// New footnote def: "[^1]: edit:01HZK4..." (label is non-m_xxx)
const _NEW_FOOTNOTE_RE = /^\[\^(?<label>[^\]]+)\]:\s*(?<ref>.*?)\s*$/;

function named(m: RegExpExecArray, name: string): string {
  return m.groups?.[name] ?? "";
}

function findAllMarkers(s: string): string[] {
  const out: string[] = [];
  const re = /\[\^([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1]);
  }
  return out;
}

export interface Entry {
  id: string;
  section: string;
  text: string;
  refs: string[];
}

export class Document {
  title: string;
  sections: Array<[string, Entry[]]> = [];

  constructor(title = "") {
    this.title = title;
  }

  allEntries(): Entry[] {
    const out: Entry[] = [];
    for (const [, entries] of this.sections) {
      out.push(...entries);
    }
    return out;
  }

  find(entryId: string): Entry | undefined {
    for (const [, entries] of this.sections) {
      for (const entry of entries) {
        if (entry.id === entryId) return entry;
      }
    }
    return undefined;
  }

  /** Return the entry list for `name`, creating the section if absent. */
  sectionEntries(name: string): Entry[] {
    for (const [section, entries] of this.sections) {
      if (section === name) return entries;
    }
    const newEntries: Entry[] = [];
    this.sections.push([name, newEntries]);
    return newEntries;
  }

  remove(entryId: string): boolean {
    for (const [, entries] of this.sections) {
      const i = entries.findIndex((e) => e.id === entryId);
      if (i !== -1) {
        entries.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}

const rstrip = (s: string): string => s.replace(/\s+$/, "");

export function parse(md: string): Document {
  const rawLines = md.split(/\r\n|\n|\r/);

  // Pass 1 — collect every footnote definition. Accept both the new
  // ref-keyed form (`[^1]: edit:...`) and the legacy entry-keyed form
  // (`[^m_xxx]: r1, r2`). New-form regex is deliberately wider, so the
  // narrow legacy rule must run first (label starting with "m_" that the
  // legacy regex didn't claim is malformed and is dropped on purpose).
  const refsByEntry = new Map<string, string[]>();
  const refByLabel = new Map<string, string>();
  for (const raw of rawLines) {
    const line = rstrip(raw);
    const mOldFn = _OLD_FOOTNOTE_RE.exec(line);
    if (mOldFn) {
      const refsRaw = named(mOldFn, "refs");
      refsByEntry.set(
        named(mOldFn, "id"),
        refsRaw
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0)
      );
      continue;
    }
    const mNewFn = _NEW_FOOTNOTE_RE.exec(line);
    if (mNewFn) {
      const label = named(mNewFn, "label");
      if (label.startsWith("m_")) continue;
      refByLabel.set(label, named(mNewFn, "ref").trim());
    }
  }

  // Pass 2 — title, sections, bullets.
  const doc = new Document();
  let currentEntries: Entry[] | null = null;
  let currentSection: string | null = null;
  for (const raw of rawLines) {
    const line = rstrip(raw);

    if (!doc.title) {
      const mTitle = _TITLE_RE.exec(line);
      if (mTitle) {
        doc.title = mTitle[1].trim();
        continue;
      }
    }

    const mSection = _SECTION_RE.exec(line);
    if (mSection) {
      currentSection = mSection[1].trim();
      currentEntries = [];
      doc.sections.push([currentSection, currentEntries]);
      continue;
    }

    // New format first: bullet ends with an HTML-comment entry-id anchor.
    const mNewB = _NEW_BULLET_RE.exec(line);
    if (mNewB && currentEntries !== null && currentSection !== null) {
      const entryId = named(mNewB, "id");
      const text = rstrip(named(mNewB, "text"));
      const markers = findAllMarkers(named(mNewB, "markers"));
      const entryRefs: string[] = [];
      for (const marker of markers) {
        const ref = refByLabel.get(marker);
        if (ref !== undefined && !entryRefs.includes(ref)) {
          entryRefs.push(ref);
        }
      }
      currentEntries.push({ id: entryId, section: currentSection, text, refs: entryRefs });
      continue;
    }

    // Legacy bullet: refs come from refsByEntry built in pass 1.
    const mOldB = _OLD_BULLET_RE.exec(line);
    if (mOldB && currentEntries !== null && currentSection !== null) {
      const entryId = named(mOldB, "id");
      const text = named(mOldB, "text").trim();
      currentEntries.push({
        id: entryId,
        section: currentSection,
        text,
        refs: [...(refsByEntry.get(entryId) ?? [])],
      });
      continue;
    }
  }

  return doc;
}

export function serialize(doc: Document): string {
  // 1. Build the consolidated ref -> label map in first-appearance order.
  const refOrder: string[] = [];
  const refToLabel = new Map<string, number>();
  for (const entry of doc.allEntries()) {
    for (const ref of entry.refs) {
      if (refToLabel.has(ref)) continue;
      refToLabel.set(ref, refOrder.length + 1);
      refOrder.push(ref);
    }
  }

  const lines: string[] = [];
  if (doc.title) {
    lines.push(`# ${doc.title}`);
    lines.push("");
  }

  for (const [section, entries] of doc.sections) {
    if (entries.length === 0) continue;
    lines.push(`## ${section}`);
    lines.push("");
    for (const entry of entries) {
      // Comma-separate markers so rendered superscripts read "1, 2".
      const markers = entry.refs
        .filter((r) => refToLabel.has(r))
        .map((r) => `[^${refToLabel.get(r)}]`)
        .join(", ");
      const text = rstrip(entry.text);
      lines.push(markers ? `- ${text} ${markers} <!--${entry.id}-->` : `- ${text} <!--${entry.id}-->`);
    }
    lines.push("");
  }

  if (refOrder.length > 0) {
    lines.push("---");
    lines.push("");
    for (let i = 0; i < refOrder.length; i++) {
      lines.push(`[^${i + 1}]: ${refOrder[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

/**
 * Render a document's content for human/LLM consumption: title, section
 * headers, and entry text only. No footnote markers, entry-id anchors, or
 * footnote definitions — those are provenance for audit/traceability, not
 * content, and injecting them wastes context budget.
 *
 * Do NOT use this for persistence: `serialize` is the canonical on-disk form
 * and is what carries the L3→surface→L2→L1 reference chain. This is a
 * read-only view for injection/display.
 */
export function renderBody(doc: Document): string {
  const lines: string[] = [];
  if (doc.title) {
    lines.push(`# ${doc.title}`);
    lines.push("");
  }
  for (const [section, entries] of doc.sections) {
    if (entries.length === 0) continue;
    lines.push(`## ${section}`);
    lines.push("");
    for (const entry of entries) {
      lines.push(`- ${rstrip(entry.text)}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}
