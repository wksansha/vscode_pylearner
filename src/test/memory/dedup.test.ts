import { describe, it, expect } from "vitest";
import { runDedup, type DedupDeps } from "../../memory/dedup";
import { Document } from "../../memory/document";
import { newEntryId } from "../../memory/ids";

const REF = "edit:01HZK4ABCDEFGHJKMNPQRSTVWX";

function dupDoc(): Document {
  const doc = new Document("edit memory");
  for (const text of ["dup", "dup"]) {
    doc.sectionEntries("Patterns").push({
      id: newEntryId(),
      section: "Patterns",
      text,
      refs: [REF],
    });
  }
  return doc;
}

function makeDeps(overrides: Partial<DedupDeps> = {}): DedupDeps & { saved: { count: number } } {
  const saved = { count: 0 };
  const deps: DedupDeps = {
    loadDoc: async () => null,
    saveDoc: async () => {
      saved.count += 1;
    },
    callLlm: async () => `{"edits": []}`,
    ...overrides,
  };
  return Object.assign(deps, { saved });
}

describe("runDedup", () => {
  it("reports noDoc when the target is missing", async () => {
    const deps = makeDeps();
    const result = await runDedup(deps, "L2", "edit");
    expect(result.noDoc).toBe(true);
    expect(result.iterationsRun).toBe(0);
    expect(result.editsApplied).toBe(0);
  });

  it("stops early on an empty edits payload", async () => {
    const doc = dupDoc();
    const deps = makeDeps({
      loadDoc: async () => doc,
      callLlm: async () => `{"edits": []}`,
    });
    const result = await runDedup(deps, "L2", "edit", { iterations: 3 });
    expect(result.noDoc).toBe(false);
    expect(result.convergedEarly).toBe(true);
    expect(result.iterationsRun).toBe(1);
    expect(result.editsApplied).toBe(0);
    expect(deps.saved.count).toBe(0);
  });

  it("applies a delete then converges on the next empty response", async () => {
    const doc = dupDoc();
    const responses = [
      // Line layout: 1 title, 2 blank, 3 section, 4 bullet, 5 bullet.
      `{"edits": [{"op": "delete", "line_start": 5, "line_end": 5, "reason": "dup of L4"}]}`,
      `{"edits": []}`,
    ];
    let calls = 0;
    let savedDoc: Document | null = null;
    const deps = makeDeps({
      loadDoc: async () => doc,
      callLlm: async () => responses[Math.min(calls++, responses.length - 1)],
      saveDoc: async (_layer, _key, next) => {
        savedDoc = next;
      },
    });
    const result = await runDedup(deps, "L2", "edit", { iterations: 3 });
    expect(result.convergedEarly).toBe(true);
    expect(result.iterationsRun).toBe(2);
    expect(result.editsApplied).toBe(1);
    expect(savedDoc).not.toBeNull();
    expect(savedDoc!.allEntries()).toHaveLength(1);
    // applyEdits deep-copies; the caller's doc must be left untouched.
    expect(doc.allEntries()).toHaveLength(2);
  });

  it("tolerates a malformed LLM payload as zero edits", async () => {
    const doc = dupDoc();
    const deps = makeDeps({
      loadDoc: async () => doc,
      callLlm: async () => "not json",
    });
    const result = await runDedup(deps, "L2", "edit", { iterations: 2 });
    expect(result.convergedEarly).toBe(true);
    expect(result.editsApplied).toBe(0);
  });
});
