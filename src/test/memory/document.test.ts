import { describe, it, expect } from "vitest";
import { parse, serialize, renderBody, Document } from "../../memory/document";

const U1 = "01HZK4ABCDEFGHJKMNPQRSTVWX"; // 26-char ULID-shaped
const U2 = "01HZK5ABCDEFGHJKMNPQRSTVWX";
const U3 = "01HZK6ABCDEFGHJKMNPQRSTVWX";

const SAMPLE = `# Python Learner Profile

## Strengths
- Uses list comprehensions frequently [^1] <!--m_${U1}-->
- Prefers f-strings over .format() [^1] <!--m_${U2}-->

## Areas for Improvement
- Struggles with async/await [^2] <!--m_${U3}-->

---

[^1]: edit:${U1}
[^2]: chat:${U2}
`;

describe("document parse/serialize", () => {
  it("parses title, sections, entries, and refs", () => {
    const doc = parse(SAMPLE);
    expect(doc.title).toBe("Python Learner Profile");
    expect(doc.sections).toHaveLength(2);
    expect(doc.sections[0][0]).toBe("Strengths");
    expect(doc.sections[0][1]).toHaveLength(2);

    const first = doc.sections[0][1][0];
    expect(first.text).toBe("Uses list comprehensions frequently");
    expect(first.id).toBe(`m_${U1}`);
    expect(first.refs).toEqual([`edit:${U1}`]);

    // Both Strengths entries share label [^1] -> deduped to one ref.
    const second = doc.sections[0][1][1];
    expect(second.refs).toEqual([`edit:${U1}`]);
  });

  it("round-trips idempotently", () => {
    const once = serialize(parse(SAMPLE));
    const twice = serialize(parse(once));
    expect(twice).toBe(once);
  });

  it("serialize assigns first-appearance integer labels and dedups footnotes", () => {
    const out = serialize(parse(SAMPLE));
    expect(out).toContain(`[^1]: edit:${U1}`);
    expect(out).toContain(`[^2]: chat:${U2}`);
    // `[^1]:` appears exactly once even though two entries cite it.
    expect(out.match(/\[\^1\]:/g)?.length).toBe(1);
  });

  it("parses the legacy format and can migrate on serialize", () => {
    const legacy = `# Old

## topics
- user fears recursion [^m_${U1}]

---

[^m_${U1}]: chat:${U3}, run:${U2}
`;
    const doc = parse(legacy);
    const entry = doc.sections[0][1][0];
    expect(entry.id).toBe(`m_${U1}`);
    expect(entry.refs).toEqual([`chat:${U3}`, `run:${U2}`]);

    // serialize migrates to the new ref-keyed layout.
    const out = serialize(doc);
    expect(out).toContain(`- user fears recursion [^1], [^2] <!--m_${U1}-->`);
    expect(out).toContain(`[^1]: chat:${U3}`);
  });

  it("silently drops bullets outside any section", () => {
    const md = `# T
- orphan <!--m_${U1}-->

## S
- real [^1] <!--m_${U2}-->

---

[^1]: edit:${U3}
`;
    const doc = parse(md);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0][1]).toHaveLength(1);
    expect(doc.sections[0][1][0].text).toBe("real");
  });

  it("drops a bullet whose footnote label is undefined", () => {
    const md = `# T

## S
- cites missing footnote [^7] <!--m_${U1}-->
`;
    const doc = parse(md);
    expect(doc.sections[0][1][0].refs).toEqual([]);
  });

  it("renderBody emits content only (no markers, anchors, or footnotes)", () => {
    const body = renderBody(parse(SAMPLE));
    expect(body).toContain("# Python Learner Profile");
    expect(body).toContain("## Strengths");
    expect(body).toContain("- Uses list comprehensions frequently");
    expect(body).toContain("- Struggles with async/await");
    // Provenance is stripped: no footnote markers, anchors, or definitions.
    expect(body).not.toContain("[^1]");
    expect(body).not.toContain("<!--");
    expect(body).not.toContain("[^1]: edit:");
    expect(body).not.toContain("---");
  });

  it("Document helpers behave", () => {
    const doc = parse(SAMPLE);
    expect(doc.allEntries()).toHaveLength(3);
    expect(doc.find(`m_${U2}`)?.text).toBe("Prefers f-strings over .format()");
    expect(doc.find("m_missing")).toBeUndefined();

    const created = doc.sectionEntries("New Section");
    created.push({ id: `m_${U3}`, section: "New Section", text: "x", refs: [] });
    expect(doc.sectionEntries("New Section")).toHaveLength(1);

    expect(doc.remove(`m_${U1}`)).toBe(true);
    expect(doc.remove(`m_${U1}`)).toBe(false);
  });
});
