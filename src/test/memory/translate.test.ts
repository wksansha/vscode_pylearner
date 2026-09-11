// Chinese translation pass for the displayed L3 profile.
import { describe, it, expect } from "vitest";
import { Document, serialize } from "../../memory/document";
import { apply } from "../../memory/ops";
import { translateL3Doc, type TranslateDeps } from "../../memory/translate";

function makeDoc(): Document {
  const doc = new Document("User profile");
  apply(doc, [
    { op: "add", section: "Learning style", text: "types 'print' incrementally", refs: ["edit"] },
    { op: "add", section: "Learning style", text: "toggles breakpoints back and forth", refs: ["debug"] },
    { op: "add", section: "Identity", text: "asks about syntax highlighting without context", refs: ["chat"] },
  ]);
  return doc;
}

describe("translateL3Doc", () => {
  it("translates entry prose and preserves structure", async () => {
    const doc = makeDoc();
    const beforeIds = doc.allEntries().map((e) => e.id).sort();
    const beforeRefs = doc.allEntries().map((e) => [...e.refs].sort().join(","));
    const calls: { system: string; user: string }[] = [];
    const deps: TranslateDeps = {
      callLlm: async (system, user) => {
        calls.push({ system, user });
        const payload = JSON.parse(user) as Array<{ id: string; text: string }>;
        return JSON.stringify(
          payload.map((e) => ({
            id: e.id,
            text: `中文:${e.text}`,
          }))
        );
      },
      loadL3Doc: async () => doc,
      saveL3Doc: async (_slot, saved) => {
        Object.assign(doc, saved);
        // shallow-mutate the doc the loader would return next time
        doc.sections = saved.sections;
        doc.title = saved.title;
      },
    };

    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(true);
    expect(r.translated).toBe(3);
    expect(calls.length).toBe(1);
    // one batch of 3 entries
    expect(JSON.parse(calls[0].user).length).toBe(3);

    // structure preserved: same ids, same refs, same sections
    const afterIds = doc.allEntries().map((e) => e.id).sort();
    expect(afterIds).toEqual(beforeIds);
    const afterRefs = doc.allEntries().map((e) => [...e.refs].sort().join(","));
    expect(afterRefs).toEqual(beforeRefs);
    expect(doc.sections.map((s) => s[0])).toEqual(["Learning style", "Identity"]);

    // prose translated
    expect(doc.allEntries()[0].text).toBe("中文:types 'print' incrementally");
  });

  it("leaves entries in English when the LLM returns nothing usable", async () => {
    const doc = makeDoc();
    const original = serialize(doc);
    const deps: TranslateDeps = {
      callLlm: async () => "no json here at all",
      loadL3Doc: async () => doc,
      saveL3Doc: async () => {
        throw new Error("should not be called");
      },
    };
    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(false);
    expect(serialize(doc)).toBe(original);
  });

  it("skips when the doc has no entries", async () => {
    const doc = new Document("User profile");
    let saved = false;
    const deps: TranslateDeps = {
      callLlm: async () => {
        throw new Error("should not be called");
      },
      loadL3Doc: async () => doc,
      saveL3Doc: async () => {
        saved = true;
      },
    };
    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(true);
    expect(r.translated).toBe(0);
    expect(saved).toBe(false);
  });

  it("batches more than BATCH_SIZE entries", async () => {
    const doc = new Document("User profile");
    const ops: { op: "add"; section: string; text: string; refs: string[] }[] = [];
    for (let i = 0; i < 120; i++) {
      ops.push({ op: "add", section: "Learning style", text: `fact ${i}`, refs: ["edit"] });
    }
    apply(doc, ops);

    let batchCount = 0;
    const deps: TranslateDeps = {
      callLlm: async (_system, user) => {
        batchCount += 1;
        const payload = JSON.parse(user) as Array<{ id: string; text: string }>;
        return JSON.stringify(payload.map((e) => ({ id: e.id, text: `T:${e.text}` })));
      },
      loadL3Doc: async () => doc,
      saveL3Doc: async (_slot, saved) => {
        doc.sections = saved.sections;
        doc.title = saved.title;
      },
    };
    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(true);
    expect(r.translated).toBe(120);
    // 120 entries / 50 per batch = 3 batches
    expect(batchCount).toBe(3);
    expect(doc.allEntries()[119].text).toBe("T:fact 119");
  });

  it("retries untranslated entries in an extra pass", async () => {
    const doc = makeDoc(); // 3 entries, all English
    let pass = 0;
    const deps: TranslateDeps = {
      callLlm: async (_system, user) => {
        pass += 1;
        const payload = JSON.parse(user) as Array<{ id: string; text: string }>;
        // pass 1 drops the last entry (model flake); pass 2 returns everything
        const out = pass === 1 ? payload.slice(0, -1) : payload;
        return JSON.stringify(out.map((e) => ({ id: e.id, text: `中文:${e.text}` })));
      },
      loadL3Doc: async () => doc,
      saveL3Doc: async (_slot, saved) => {
        doc.sections = saved.sections;
        doc.title = saved.title;
      },
    };
    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(true);
    expect(r.translated).toBe(3);
    expect(pass).toBe(2);
    expect(doc.allEntries().every((e) => e.text.startsWith("中文:"))).toBe(true);
  });

  it("gives up after the bounded passes and reports untouched", async () => {
    const doc = makeDoc();
    let pass = 0;
    const deps: TranslateDeps = {
      callLlm: async (_system, user) => {
        pass += 1;
        const payload = JSON.parse(user) as Array<{ id: string; text: string }>;
        // always drops the last entry
        return JSON.stringify(payload.slice(0, -1).map((e) => ({ id: e.id, text: `中文:${e.text}` })));
      },
      loadL3Doc: async () => doc,
      saveL3Doc: async (_slot, saved) => {
        doc.sections = saved.sections;
        doc.title = saved.title;
      },
    };
    const r = await translateL3Doc(deps, "profile");
    expect(r.ok).toBe(true);
    expect(r.translated).toBe(2);
    expect(r.untouched).toBe(1);
    expect(pass).toBe(3); // 1 initial + 2 retries, then stop
  });
});