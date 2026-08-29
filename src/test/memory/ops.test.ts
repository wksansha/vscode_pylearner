import { describe, it, expect } from "vitest";
import { parse, Document } from "../../memory/document";
import { apply, Op } from "../../memory/ops";

const U1 = "01HZK4ABCDEFGHJKMNPQRSTVWX";
const U2 = "01HZK5ABCDEFGHJKMNPQRSTVWX";

function sampleDoc(): Document {
  return parse(`# T

## Patterns
- old [^1] <!--m_${U1}-->

---

[^1]: edit:${U1}
`);
}

describe("ops", () => {
  it("apply add op appends an entry and returns its new id", () => {
    const doc = sampleDoc();
    const report = apply(doc, [
      { op: "add", section: "Errors", text: "ZeroDivisionError", refs: [`run:${U1}`] },
    ]);
    expect(report.accepted).toBe(true);
    expect(report.results[0].entry_id).toMatch(/^m_/);
    const entry = doc.find(report.results[0].entry_id!);
    expect(entry?.text).toBe("ZeroDivisionError");
    expect(entry?.section).toBe("Errors");
  });

  it("rejects an add with empty refs", () => {
    const doc = sampleDoc();
    const report = apply(doc, [{ op: "add", section: "S", text: "x", refs: [] }]);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("refs");
  });

  it("rejects an add with a malformed ref", () => {
    const doc = sampleDoc();
    const report = apply(doc, [
      { op: "add", section: "S", text: "x", refs: ["not-an-id"] },
    ]);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("malformed");
  });

  it("rejects an add with text over the length cap", () => {
    const doc = sampleDoc();
    const report = apply(doc, [
      { op: "add", section: "S", text: "x".repeat(241), refs: [`edit:${U1}`] },
    ]);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("text length");
  });

  it("rejects an edit+delete conflict on the same id", () => {
    const doc = sampleDoc();
    const ops: Op[] = [
      { op: "edit", target_id: `m_${U1}`, new_text: "new", new_refs: [`edit:${U2}`] },
      { op: "delete", target_id: `m_${U1}`, reason: "stale" },
    ];
    const report = apply(doc, ops);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("conflict");
  });

  it("rejects a delete with an invalid reason", () => {
    const doc = sampleDoc();
    const report = apply(doc, [{ op: "delete", target_id: `m_${U1}`, reason: "because" }]);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("reason");
  });

  it("edit updates text and refs in place", () => {
    const doc = sampleDoc();
    const report = apply(doc, [
      { op: "edit", target_id: `m_${U1}`, new_text: "updated", new_refs: [`chat:${U2}`] },
    ]);
    expect(report.accepted).toBe(true);
    expect(doc.find(`m_${U1}`)?.text).toBe("updated");
    expect(doc.find(`m_${U1}`)?.refs).toEqual([`chat:${U2}`]);
  });

  it("rejects an edit/delete targeting a missing entry", () => {
    const doc = sampleDoc();
    const report = apply(doc, [{ op: "delete", target_id: `m_${U2}`, reason: "stale" }]);
    expect(report.accepted).toBe(false);
    expect(report.reason).toContain("not found");
  });

  it("leaves the document untouched on a rejected batch", () => {
    const doc = sampleDoc();
    const before = JSON.stringify(doc);
    apply(doc, [
      { op: "add", section: "S", text: "ok", refs: [`edit:${U1}`] },
      { op: "delete", target_id: `m_${U2}`, reason: "stale" }, // fails
    ]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
