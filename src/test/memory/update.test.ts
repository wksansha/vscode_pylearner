import { describe, it, expect } from "vitest";
import {
  appendFactsToDoc,
  chunkWithRefHeader,
  defaultL3Title,
  renderExisting,
  updateL2,
  updateL3,
  type ConsolidatorDeps,
} from "../../memory/update";
import { Document, parse, serialize } from "../../memory/document";
import { newL2Meta, newL3Meta, type L2Meta, type L3Meta } from "../../memory/meta";
import type { Entity } from "../../snapshot/entity";
import type { Surface } from "../../constants";
import { SLOT_FOCUS } from "../../memory/settings";

const ULID = "01HZK4ABCDEFGHJKMNPQRSTVWX";
const ULID2 = "01HZK5ABCDEFGHJKMNPQRSTVWX";
const REF = `edit:${ULID}`;

function entity(): Entity {
  return {
    id: ULID,
    label: "file_save main.py",
    ts: "2026-08-29T00:00:00.000Z",
    content: "### file_save\nfile: main.py",
    metadata: { kind: "file_save" },
    fingerprint: "fp1",
  };
}

function makeDeps(overrides: Partial<ConsolidatorDeps> = {}): ConsolidatorDeps & {
  savedL2: Document[];
  savedL2Meta: L2Meta[];
  savedL3: Document[];
  savedL3Meta: L3Meta[];
  llmCalls: string[];
} {
  const state = {
    savedL2: [] as Document[],
    savedL2Meta: [] as L2Meta[],
    savedL3: [] as Document[],
    savedL3Meta: [] as L3Meta[],
    llmCalls: [] as string[],
  };
  const deps: ConsolidatorDeps = {
    readEntities: async () => [entity()],
    loadAllL2Docs: async () => ({}),
    loadL2Meta: async () => newL2Meta(),
    saveL2Meta: async (_s, meta) => {
      state.savedL2Meta.push(meta);
    },
    loadL3Meta: async () => newL3Meta(),
    saveL3Meta: async (_s, meta) => {
      state.savedL3Meta.push(meta);
    },
    loadL2Doc: async () => null,
    saveL2Doc: async (_s, doc) => {
      state.savedL2.push(doc);
    },
    loadL3Doc: async () => null,
    saveL3Doc: async (_s, doc) => {
      state.savedL3.push(doc);
    },
    callLlm: async (_sys, user) => {
      state.llmCalls.push(user);
      return JSON.stringify({
        facts: [{ text: "uses list comprehensions", section: "Patterns", refs: [REF] }],
      });
    },
    ...overrides,
  };
  return Object.assign(deps, state);
}

describe("appendFactsToDoc", () => {
  it("appends facts and returns new entry ids", () => {
    const doc = new Document();
    const ids = appendFactsToDoc(
      doc,
      [{ text: "uses X", refs: [REF], section: "Patterns" }],
      ["Patterns", "Habits"]
    );
    expect(ids).toHaveLength(1);
    expect(doc.allEntries()).toHaveLength(1);
    expect(doc.allEntries()[0].section).toBe("Patterns");
  });

  it("keeps an off-list section as-is (trust dynamic sections)", () => {
    const doc = new Document();
    appendFactsToDoc(doc, [{ text: "uses X", refs: [REF], section: "Weird" }], ["Patterns"]);
    expect(doc.allEntries()[0].section).toBe("Weird");
  });

  it("uses the fallback when section is empty", () => {
    const doc = new Document();
    appendFactsToDoc(doc, [{ text: "uses X", refs: [REF], section: "" }], ["Patterns"]);
    expect(doc.allEntries()[0].section).toBe("Patterns");
  });

  it("profile slot fallback section is visible in display (not Identity)", () => {
    expect(SLOT_FOCUS.profile.sections[0]).toBe("Knowledge level");
    expect(SLOT_FOCUS.profile.sections).toContain("Identity");
  });

  it("propagates knowledge_strength to the entry", () => {
    const doc = new Document();
    appendFactsToDoc(
      doc,
      [{ text: "misspells True in while conditions", refs: [REF], section: "Loop Control", knowledge_strength: 4 }],
      ["Knowledge level", "Learning style", "Identity"]
    );
    expect(doc.allEntries()[0].section).toBe("Loop Control");
    expect(doc.allEntries()[0].knowledge_strength).toBe(4);
  });
});

describe("updateL3", () => {
  it("persists knowledge_strength and topic sections from the LLM response", async () => {
    const l2doc = parse(
      `# edit memory\n\n## Loop Control\n\n- works on a while loop [^1] <!--m_${ULID2}-->\n\n---\n\n[^1]: edit:${ULID2}\n`
    );
    const deps = makeDeps({
      loadAllL2Docs: async () => ({ edit: l2doc }),
      callLlm: async () =>
        JSON.stringify({
          facts: [
            {
              text: "misspells True in while conditions",
              section: "Loop Control",
              refs: ["edit"],
              knowledge_strength: 4,
            },
          ],
        }),
    });
    const result = await updateL3(deps, "profile");
    expect(result.factsAdded).toBe(1);
    // last saved copy wins (dedup/merge may re-save); the entry must survive
    // with its section AND strength intact.
    const doc = deps.savedL3[deps.savedL3.length - 1];
    const entry = doc.allEntries()[0];
    expect(entry.section).toBe("Loop Control");
    expect(entry.knowledge_strength).toBe(4);
    expect(serialize(doc)).toContain("k=4");
  });
});

describe("chunkWithRefHeader", () => {
  it("prepends a citeable refs header when allowed is non-empty", () => {
    const out = chunkWithRefHeader("body", new Set(["edit:1", "chat:2"]));
    expect(out).toContain("# Chunk-local citeable refs");
    expect(out).toContain("- chat:2");
    expect(out).toContain("body");
  });

  it("returns the chunk unchanged when allowed is empty", () => {
    expect(chunkWithRefHeader("body", new Set())).toBe("body");
  });
});

describe("renderExisting", () => {
  it("renders a placeholder for an empty doc", () => {
    expect(renderExisting(new Document())).toBe("(empty — first run)");
  });
  it("renders a non-empty doc", () => {
    const doc = new Document("T");
    doc.sectionEntries("S").push({ id: `m_${ULID}`, section: "S", text: "x", refs: [REF] });
    expect(renderExisting(doc)).toContain("x");
  });
});

describe("defaultL3Title", () => {
  it("maps profile slot", () => {
    expect(defaultL3Title("profile")).toBe("User profile");
  });
});

describe("updateL2", () => {
  it("extracts facts, appends to the doc, and saves doc + meta", async () => {
    const deps = makeDeps();
    const result = await updateL2(deps, "edit" as Surface);

    expect(result.noNewInput).toBe(false);
    expect(result.factsAdded).toBe(1);
    expect(deps.llmCalls).toHaveLength(1);
    expect(deps.savedL2).toHaveLength(1);
    expect(deps.savedL2[0].allEntries()).toHaveLength(1);
    expect(deps.savedL2[0].allEntries()[0].refs).toEqual([REF]);
    expect(deps.savedL2Meta).toHaveLength(1);
    expect(deps.savedL2Meta[0].seen_entity_refs).toEqual([REF]);
  });

  it("reports noNewInput when every entity is already seen", async () => {
    const deps = makeDeps({
      loadL2Meta: async () => ({ last_update_at: null, seen_entity_refs: [REF] }),
    });
    const result = await updateL2(deps, "edit" as Surface);
    expect(result.noNewInput).toBe(true);
    expect(result.factsAdded).toBe(0);
    expect(deps.llmCalls).toHaveLength(0);
  });

  it("drops facts whose refs are out of the chunk pool", async () => {
    const deps = makeDeps({
      callLlm: async () =>
        JSON.stringify({
          facts: [{ text: "bad fact", section: "Patterns", refs: ["chat:zzz"] }],
        }),
    });
    const result = await updateL2(deps, "edit" as Surface);
    expect(result.factsAdded).toBe(0);
    expect(result.refsDropped).toBe(1);
  });
});

describe("updateL3", () => {
  it("synthesizes facts from new L2 entries", async () => {
    const l2doc = new Document("edit memory");
    l2doc.sectionEntries("Patterns").push({
      id: `m_${ULID}`,
      section: "Patterns",
      text: "uses list comprehensions",
      refs: [REF],
    });
    const deps = makeDeps({
      loadAllL2Docs: async () => ({ edit: l2doc }),
      callLlm: async () =>
        JSON.stringify({
          facts: [
            { text: "Across 1 edit interaction, the user uses list comprehensions", section: "Knowledge level", refs: ["edit"] },
          ],
        }),
    });
    const result = await updateL3(deps, "profile");

    expect(result.noNewInput).toBe(false);
    expect(result.factsAdded).toBe(1);
    expect(deps.savedL3).toHaveLength(1);
    expect(deps.savedL3[0].allEntries()[0].refs).toEqual(["edit"]);
    expect(deps.savedL3Meta[0].seen_l2_entry_ids).toEqual({ edit: [`m_${ULID}`] });
  });

  it("reports noNewInput when all L2 entries are seen", async () => {
    const l2doc = new Document("edit memory");
    l2doc.sectionEntries("Patterns").push({
      id: `m_${ULID}`,
      section: "Patterns",
      text: "x",
      refs: [REF],
    });
    const deps = makeDeps({
      loadAllL2Docs: async () => ({ edit: l2doc }),
      loadL3Meta: async () => ({
        last_update_at: null,
        seen_l2_entry_ids: { edit: [`m_${ULID}`] },
      }),
    });
    const result = await updateL3(deps, "profile");
    expect(result.noNewInput).toBe(true);
    expect(deps.llmCalls).toHaveLength(0);
  });

  it("rejects the preferences slot", async () => {
    await expect(updateL3(makeDeps(), "preferences")).rejects.toThrow();
  });
});

describe("update round-trip through parse", () => {
  it("serialized L2 doc re-parses with the same entries", () => {
    const doc = new Document("edit memory");
    doc.sectionEntries("Patterns").push({
      id: `m_${ULID}`,
      section: "Patterns",
      text: "uses list comprehensions",
      refs: [REF],
    });
    const reparsed = parse(serialize(doc));
    expect(reparsed.allEntries()).toHaveLength(1);
    expect(reparsed.allEntries()[0].refs).toEqual([REF]);
  });
});
