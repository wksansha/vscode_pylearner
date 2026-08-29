import { describe, it, expect } from "vitest";
import {
  applyEdits,
  cleanRefs,
  parseEditsPayload,
  renderNumbered,
  renderView,
} from "../../memory/lineDoc";
import { Document } from "../../memory/document";
import { newEntryId } from "../../memory/ids";

const ULID = "01HZK4ABCDEFGHJKMNPQRSTVWX";

function docWith(texts: string[]): Document {
  const doc = new Document("edit memory");
  for (const t of texts) {
    doc.sectionEntries("Patterns").push({
      id: newEntryId(),
      section: "Patterns",
      text: t,
      refs: [`edit:${ULID}`],
    });
  }
  return doc;
}

describe("renderView", () => {
  it("numbers lines and annotates bullets with entry id + refs", () => {
    const doc = docWith(["uses for-loops", "uses comprehensions"]);
    const view = renderView(doc);
    const text = renderNumbered(view);

    expect(text).toContain("1: # edit memory");
    expect(text).toContain("## Patterns");
    expect(text).toMatch(/\[\^m_[0-9A-HJKMNP-TV-Z]{26}\]/);
    expect(text).toContain(`(edit:${ULID})`);
    expect(view.lines.filter((l) => l.kind === "bullet")).toHaveLength(2);
  });

  it("strips trailing blank lines", () => {
    const view = renderView(docWith(["one"]));
    expect(view.lines[view.lines.length - 1].kind).toBe("bullet");
  });
});

describe("applyEdits", () => {
  it("replaces text and preserves existing refs when none provided", () => {
    const doc = docWith(["old text"]);
    const { doc: next, report } = applyEdits(doc, [
      { op: "replace", line: 4, newText: "new text", refs: [], reason: "rewrite" },
    ]);
    expect(report.rejected).toHaveLength(0);
    const entry = next.find(doc.allEntries()[0].id)!;
    expect(entry.text).toBe("new text");
    expect(entry.refs).toEqual([`edit:${ULID}`]);
    // The provenance-preserving fallback fired — callers can surface it.
    expect(report.applied[0].refsPreserved).toBe(true);
  });

  it("uses provided refs when the LLM supplies a union", () => {
    const doc = docWith(["old text"]);
    const entryId = doc.allEntries()[0].id;
    const { doc: next, report } = applyEdits(doc, [
      { op: "replace", line: 4, newText: "merged", refs: [`edit:${ULID}`, "chat:OTHER"], reason: "merge" },
    ]);
    expect(next.find(entryId)!.refs).toEqual([`edit:${ULID}`, "chat:OTHER"]);
    expect(report.applied[0].refsPreserved).toBeFalsy();
  });

  it("deletes a duplicate entry", () => {
    const doc = docWith(["dup", "dup"]);
    const { doc: next, report } = applyEdits(doc, [
      { op: "delete", lineStart: 5, lineEnd: 5, reason: "duplicate of L4" },
    ]);
    expect(report.applied).toHaveLength(1);
    expect(next.allEntries()).toHaveLength(1);
  });

  it("applies edits in reverse line order (delete high, replace low)", () => {
    const doc = docWith(["first", "second"]);
    const firstId = doc.allEntries()[0].id;
    // Line layout: 1 title, 2 blank, 3 section, 4 bullet(first), 5 bullet(second)
    const { doc: next, report } = applyEdits(doc, [
      { op: "delete", lineStart: 5, lineEnd: 5, reason: "drop" },
      { op: "replace", line: 4, newText: "rewritten first", refs: [], reason: "fix" },
    ]);
    expect(report.rejected).toHaveLength(0);
    expect(next.allEntries()).toHaveLength(1);
    expect(next.find(firstId)!.text).toBe("rewritten first");
  });

  it("rejects an edit targeting a non-bullet line", () => {
    const doc = docWith(["one"]);
    const { report } = applyEdits(doc, [
      { op: "replace", line: 1, newText: "x", refs: [`edit:${ULID}`], reason: "bad" },
    ]);
    expect(report.applied).toHaveLength(0);
    expect(report.rejected).toHaveLength(1);
  });
});

describe("cleanRefs", () => {
  it("strips wrappers and drops entry-id markers", () => {
    const refs = cleanRefs([`[^m_${ULID}]`, `edit:${ULID}`, "chat:01AAA"]);
    expect(refs).toEqual([`edit:${ULID}`, "chat:01AAA"]);
  });

  it("returns empty for non-array input", () => {
    expect(cleanRefs("not an array")).toEqual([]);
  });
});

describe("parseEditsPayload", () => {
  it("parses the edits envelope", () => {
    const edits = parseEditsPayload(
      `{"edits": [{"op": "delete", "line_start": 5, "line_end": 5, "reason": "dup"}]}`
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: "delete", lineStart: 5, lineEnd: 5 });
  });

  it("parses a top-level array and strips code fences", () => {
    const edits = parseEditsPayload(
      "```json\n[{\"op\": \"replace\", \"line\": 4, \"new_text\": \"x\", \"refs\": [\"edit:1\"]}]\n```"
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ op: "replace", line: 4, newText: "x" });
  });

  it("drops entry-id refs from a replace edit", () => {
    const edits = parseEditsPayload(
      `{"edits": [{"op": "replace", "line": 4, "new_text": "x", "refs": ["^m_${ULID}", "edit:1"]}]}`
    );
    expect(edits[0]).toMatchObject({ refs: ["edit:1"] });
  });

  it("returns empty on malformed JSON", () => {
    expect(parseEditsPayload("not json")).toEqual([]);
  });
});
