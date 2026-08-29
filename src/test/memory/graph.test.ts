import { describe, it, expect } from "vitest";
import { buildCitationGraph } from "../../memory/graph";
import { Document } from "../../memory/document";
import type { Entity } from "../../snapshot/entity";

function doc(title: string, facts: Array<[string, string, string, string[]]>) {
  const d = new Document(title);
  for (const [id, section, text, refs] of facts) {
    d.sectionEntries(section).push({ id, section, text, refs });
  }
  return d;
}

function ent(id: string, label: string, content: string): Entity {
  return { id, label, ts: "", content, metadata: {}, fingerprint: "" };
}

const l2Docs = {
  edit: doc("edit memory", [
    ["m_edit1", "Patterns", "uses for-loops", ["edit:01AAA"]],
    ["m_edit2", "Patterns", "uses comprehensions", ["edit:01BBB"]],
  ]),
  chat: doc("chat memory", [["m_chat1", "Topics", "asked about dicts", ["chat:01CCC"]]]),
};

const l3Docs = {
  profile: doc("profile", [["m_prof1", "Knowledge", "practicing dicts and loops", ["edit", "chat"]]]),
};

const entities = {
  edit: [ent("01AAA", "wrote loop", "for i in range(10)"), ent("01BBB", "comprehension", "[x for x in y]"), ent("01ORPHAN", "orphan", "uncited event")],
  chat: [ent("01CCC", "asked dict", "how to merge dicts?")],
};

const graph = buildCitationGraph({ l3Docs, l2Docs, entities });

describe("buildCitationGraph", () => {
  it("emits one node per L3/L2 entry and per cited L1 entity", () => {
    const byLayer = { L3: 0, L2: 0, L1: 0 };
    for (const n of graph.nodes) byLayer[n.layer] += 1;
    expect(byLayer.L3).toBe(1);
    expect(byLayer.L2).toBe(3);
    // only 01AAA, 01BBB, 01CCC are cited; 01ORPHAN is pruned
    expect(byLayer.L1).toBe(3);
    expect(graph.nodes).toHaveLength(7);
  });

  it("connects L2 entries to their cited L1 entities", () => {
    const edge = (from: string, to: string) =>
      graph.edges.some((e) => e.from === from && e.to === to);
    expect(edge("l2:edit:m_edit1", "l1:edit:01AAA")).toBe(true);
    expect(edge("l2:edit:m_edit2", "l1:edit:01BBB")).toBe(true);
    expect(edge("l2:chat:m_chat1", "l1:chat:01CCC")).toBe(true);
  });

  it("expands an L3 surface ref to every L2 entry in that surface", () => {
    const l3 = "l3:profile:m_prof1";
    const targets = graph.edges.filter((e) => e.from === l3).map((e) => e.to).sort();
    expect(targets).toEqual(["l2:chat:m_chat1", "l2:edit:m_edit1", "l2:edit:m_edit2"]);
  });

  it("drops dangling L2 refs that point at no entity", () => {
    const l2 = doc("edit memory", [["m_x", "Patterns", "no source", ["edit:DEADBEEF"]]]);
    const g = buildCitationGraph({ l3Docs: {}, l2Docs: { edit: l2 }, entities: { edit: [ent("01AAA", "x", "y")] } });
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(1); // only the L2 entry; no L1 node for the dangling ref
  });

  it("keeps L2/L3 entries that cite nothing, but no L1 orphan nodes", () => {
    const l2 = doc("edit memory", [["m_uncited", "Patterns", "no refs", []]]);
    const l3 = doc("profile", [["m_uncited3", "Identity", "no refs", []]]);
    const g = buildCitationGraph({ l3Docs: { profile: l3 }, l2Docs: { edit: l2 }, entities: { edit: [ent("01AAA", "x", "y")] } });
    expect(g.nodes.map((n) => n.layer).sort()).toEqual(["L2", "L3"]);
    expect(g.edges).toHaveLength(0);
  });
});
