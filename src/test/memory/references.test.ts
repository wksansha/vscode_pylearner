import { describe, it, expect } from "vitest";
import {
  ExtractedFact,
  entityMarker,
  refsInChunkL2,
  refsInSpanL2,
  refsInChunkL3,
  refsInSpanL3,
  renderL2EntriesForConcat,
  renderTracesForConcat,
  validateFactRefs,
} from "../../memory/references";
import { parse } from "../../memory/document";
import type { Entity } from "../../snapshot/entity";

function ent(id: string, content = "some content"): Entity {
  return { id, label: `label ${id}`, ts: "2026-08-29T00:00:00Z", content, metadata: {}, fingerprint: "fp" };
}

const E1 = ent("01HZK4ABCDEFGHJKMNPQRSTVWX", "first fact body");
const E2 = ent("01HZK4ABCDEFGHJKMNPQRSTVWY", "second fact body");

describe("entityMarker", () => {
  it("renders a marker", () => {
    expect(entityMarker("edit", "abc")).toBe("@entity edit:abc");
  });
});

describe("refsInChunkL2", () => {
  it("collects entity refs whose marker appears in the chunk", () => {
    const chunk = renderTracesForConcat([E1, E2], "edit");
    const allowed = refsInChunkL2([E1, E2], "edit", chunk);
    expect(allowed).toEqual(new Set([`edit:${E1.id}`, `edit:${E2.id}`]));
  });

  it("omits entities absent from the chunk", () => {
    const allowed = refsInChunkL2([E1, E2], "edit", "no markers here");
    expect(allowed.size).toBe(0);
  });
});

describe("refsInSpanL2", () => {
  it("returns entities overlapping the span", () => {
    const full = renderTracesForConcat([E1, E2], "edit");
    const allowed = refsInSpanL2([E1, E2], "edit", full, 0, full.length);
    expect(allowed).toEqual(new Set([`edit:${E1.id}`, `edit:${E2.id}`]));
  });

  it("returns empty for a span before all markers", () => {
    const full = renderTracesForConcat([E1, E2], "edit");
    expect(refsInSpanL2([E1, E2], "edit", full, 0, 1).size).toBe(0);
  });
});

describe("refsInChunkL3 / refsInSpanL3", () => {
  const entries = {
    edit: [{ id: "m_a", section: "Patterns", text: "uses X", refs: [] }],
    chat: [{ id: "m_b", section: "Topics", text: "confused about Y", refs: [] }],
  };
  const rendered = renderL2EntriesForConcat(entries);

  it("collects surface names from chunk headers", () => {
    expect(refsInChunkL3(rendered, entries)).toEqual(new Set(["edit", "chat"]));
  });

  it("collects surface names overlapping the span", () => {
    expect(refsInSpanL3(entries, rendered, 0, rendered.length)).toEqual(
      new Set(["edit", "chat"])
    );
  });
});

describe("validateFactRefs", () => {
  const allowed = new Set([`edit:${E1.id}`, `edit:${E2.id}`]);
  const fact = (refs: string[]): ExtractedFact => ({ text: "uses X", refs, section: "Patterns" });

  it("rejects when refs are required but missing", () => {
    const r = validateFactRefs(fact([]), allowed, true, true);
    expect(r.rejectReason).toBe("missing refs");
  });

  it("accepts a fact whose refs are all in the pool", () => {
    const r = validateFactRefs(fact([`edit:${E1.id}`]), allowed, true, true);
    expect(r.rejectReason).toBeNull();
    expect(r.keptRefs).toEqual([`edit:${E1.id}`]);
  });

  it("drops out-of-pool refs when dropInvalid is true", () => {
    const r = validateFactRefs(fact([`edit:${E1.id}`, "chat:zzz"]), allowed, true, true);
    expect(r.rejectReason).toBeNull();
    expect(r.keptRefs).toEqual([`edit:${E1.id}`]);
  });

  it("rejects when all refs are out-of-pool and refs are required", () => {
    const r = validateFactRefs(fact(["chat:zzz"]), allowed, true, true);
    expect(r.rejectReason).toBe("no surviving refs in chunk pool");
  });

  it("rejects out-of-pool ref when dropInvalid is false", () => {
    const r = validateFactRefs(fact(["chat:zzz"]), allowed, true, false);
    expect(r.rejectReason).toContain("out-of-pool");
  });

  it("rejects malformed refs", () => {
    const r = validateFactRefs(fact(["!!"]), allowed, false, false);
    expect(r.rejectReason).toContain("malformed");
  });

  it("normalizes a ref wrapped in label text", () => {
    const r = validateFactRefs(fact([`Title:edit:${E1.id}`]), allowed, true, false);
    expect(r.rejectReason).toBeNull();
    expect(r.keptRefs).toEqual([`edit:${E1.id}`]);
  });

  it("dedupes repeated refs", () => {
    const r = validateFactRefs(fact([`edit:${E1.id}`, `edit:${E1.id}`]), allowed, true, false);
    expect(r.keptRefs).toEqual([`edit:${E1.id}`]);
  });
});

describe("renderTracesForConcat / renderL2EntriesForConcat", () => {
  it("renders entity markers and bodies", () => {
    const out = renderTracesForConcat([E1], "edit");
    expect(out).toContain(`@entity edit:${E1.id}`);
    expect(out).toContain("first fact body");
  });

  it("renders L2 entries without entry-id markers", () => {
    const id = "m_01HZK4ABCDEFGHJKMNPQRSTVWX";
    const doc = parse(
      `# T\n## Patterns\n- uses X [^1] <!--${id}-->\n\n---\n\n[^1]: edit:1\n`
    );
    const out = renderL2EntriesForConcat({ edit: doc.allEntries() });
    expect(out).toContain("### surface: edit");
    expect(out).toContain("[Patterns] uses X");
    expect(out).not.toContain(id);
  });
});
