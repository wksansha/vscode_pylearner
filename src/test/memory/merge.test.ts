import { describe, it, expect } from "vitest";
import { migrateL3LegacyRefs, runMerge, type MergeDeps } from "../../memory/merge";
import { Document, serialize } from "../../memory/document";
import type { Layer } from "../../memory/lineDoc";

const L2_ENTRY = "m_01HZK1ABCDEFGHJKMNPQRSTVWX";
const L2_ENTRY_2 = "m_01HZK2ABCDEFGHJKMNPQRSTVWX";

function l3Doc(refs: string[]): Document {
  const doc = new Document("User profile");
  doc.sectionEntries("Knowledge").push({
    id: "m_01HZK9ABCDEFGHJKMNPQRSTVWX",
    section: "Knowledge",
    text: "claim about user",
    refs,
  });
  return doc;
}

function makeDeps(overrides: Partial<MergeDeps> = {}): MergeDeps & { saved: Document[] } {
  const state = { saved: [] as Document[] };
  const deps: MergeDeps = {
    loadDoc: async () => null,
    saveDoc: async (_layer, _key, doc) => {
      state.saved.push(doc);
    },
    loadAllL2Docs: async () => ({}),
    ...overrides,
  };
  return Object.assign(deps, state);
}

describe("migrateL3LegacyRefs", () => {
  it("resolves entry ids to surface names and preserves bare surface refs", () => {
    const doc = l3Doc([L2_ENTRY, L2_ENTRY_2, "chat"]);
    const migrated = migrateL3LegacyRefs(
      doc,
      new Map([
        [L2_ENTRY, "edit"],
        [L2_ENTRY_2, "edit"],
      ])
    );
    expect(migrated).toBe(2);
    expect(doc.allEntries()[0].refs).toEqual(["edit", "chat"]);
  });

  it("drops unresolvable entry ids", () => {
    const doc = l3Doc([L2_ENTRY]);
    const migrated = migrateL3LegacyRefs(doc, new Map());
    expect(migrated).toBe(1);
    expect(doc.allEntries()[0].refs).toEqual([]);
  });
});

describe("runMerge", () => {
  it("reports noDoc when the target is missing", async () => {
    const deps = makeDeps();
    const result = await runMerge(deps, "L2", "edit");
    expect(result.noDoc).toBe(true);
    expect(result.rewrote).toBe(false);
  });

  it("migrates legacy L3 refs and rewrites", async () => {
    const edit = new Document("edit memory");
    edit.sectionEntries("Patterns").push({
      id: L2_ENTRY,
      section: "Patterns",
      text: "uses comprehensions",
      refs: ["edit:01AAA"],
    });
    const deps = makeDeps({
      loadDoc: async (layer: Layer, key: string) =>
        layer === "L3" && key === "profile" ? l3Doc([L2_ENTRY]) : null,
      loadAllL2Docs: async () => ({ edit }),
    });
    const result = await runMerge(deps, "L3", "profile");
    expect(result.rewrote).toBe(true);
    expect(result.legacyL3RefsMigrated).toBe(1);
    expect(result.noDoc).toBe(false);
    expect(deps.saved).toHaveLength(1);
    expect(serialize(deps.saved[0])).not.toContain(L2_ENTRY);
    expect(serialize(deps.saved[0])).toContain("[^1]: edit");
  });

  it("is a no-op on an already-merged L2 doc (idempotent)", async () => {
    const doc = new Document("edit memory");
    doc.sectionEntries("Patterns").push({
      id: L2_ENTRY,
      section: "Patterns",
      text: "uses comprehensions",
      refs: ["edit:01AAA"],
    });
    const deps = makeDeps({
      loadDoc: async (layer: Layer, key: string) => (layer === "L2" && key === "edit" ? doc : null),
    });
    const result = await runMerge(deps, "L2", "edit");
    expect(result.rewrote).toBe(false);
    expect(deps.saved).toHaveLength(0);
  });
});
