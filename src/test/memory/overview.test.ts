import { describe, it, expect } from "vitest";
import { apply } from "../../memory/ops";
import { l3OverviewFileName } from "../../memory/paths";
import { parse, renderDisplay, pickProfileView, Document } from "../../memory/document";
import { synthesizeOverview, buildOverviewSystem, buildOverviewUser, type OverviewDeps } from "../../memory/overview";

const EMPTY_DOC = new Document("User profile");

function makeDoc(): Document {
  const doc = new Document("User profile");
  apply(doc, [
    // "edit" 是 shortname ref(ids.ts 白名单),apply 的 isValidRef 接受
    { op: "add", section: "Import Syntax", text: "用户在导入语句中打错字", refs: ["edit"], knowledge_strength: 4 },
  ]);
  return doc;
}

function makeDeps(overrides: Partial<OverviewDeps> = {}): OverviewDeps & {
  calls: Array<{ system: string; user: string; context?: string }>;
  saved: string[];
} {
  const calls: Array<{ system: string; user: string; context?: string }> = [];
  const saved: string[] = [];
  return {
    calls,
    saved,
    loadL3Doc: async () => makeDoc(),
    callLlm: async (system, user, context) => {
      calls.push({ system, user, context });
      return "  总评:入门初期,基础语法薄弱。  \n";
    },
    saveOverviewText: async (text) => {
      saved.push(text);
    },
    ...overrides,
  };
}

describe("synthesizeOverview", () => {
  it("sends the display view to the LLM and saves the trimmed answer", async () => {
    const deps = makeDeps();
    await synthesizeOverview(deps, "profile");
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].context).toBe("L3:profile:overview");
    expect(deps.calls[0].user).toContain("导入语法");
    expect(deps.calls[0].system).toContain("🟢已掌握");
    expect(deps.calls[0].system).toContain("🔴存在误区");
    expect(deps.calls[0].system).toContain("禁止绝对化断言");
    expect(deps.calls[0].system).toContain("不臆造");
    expect(deps.saved).toEqual(["总评:入门初期,基础语法薄弱。"]);
  });

  it("skips without an LLM call when the profile has no entries", async () => {
    const deps = makeDeps({ loadL3Doc: async () => EMPTY_DOC });
    await synthesizeOverview(deps, "profile");
    expect(deps.calls).toHaveLength(0);
    expect(deps.saved).toHaveLength(0);
  });

  it("skips without an LLM call when the doc is missing", async () => {
    const deps = makeDeps({ loadL3Doc: async () => null });
    await synthesizeOverview(deps, "profile");
    expect(deps.calls).toHaveLength(0);
  });

  it("propagates LLM failures to the caller", async () => {
    const deps = makeDeps({
      callLlm: async () => {
        throw new Error("boom");
      },
    });
    await expect(synthesizeOverview(deps, "profile")).rejects.toThrow("boom");
    expect(deps.saved).toHaveLength(0);
  });
});

describe("overview prompts", () => {
  it("system prompt carries the output contract verbatim markers", () => {
    const system = buildOverviewSystem("2026-09-11");
    expect(system).toContain("2026-09-11");
    expect(system).toContain("| 维度 | 表现 | 判断 |");
    expect(system).toContain("80-200 字");
    expect(system).toContain("🟡一般");
  });

  it("user prompt embeds the profile display text", () => {
    const user = buildOverviewUser("# 画像\n\n- 条目");
    expect(user).toContain("# 画像");
    expect(user).toContain("总评叙述");
  });
});

const U1 = "01HZK4ABCDEFGHJKMNPQRSTVWX";
const SAMPLE = `# Python Learner Profile

## Strengths
- Uses list comprehensions frequently [^1] <!--m_${U1}-->

---

[^1]: edit:${U1}
`;

describe("overview storage + view selection", () => {
  it("names the overview file after the slot", () => {
    expect(l3OverviewFileName("profile")).toBe("profile-overview.md");
  });

  it("pickProfileView prefers the overview when present", () => {
    const doc = parse(SAMPLE);
    const overview = "## 总评\n\n处于入门初期。";
    expect(pickProfileView(overview, doc)).toBe(overview);
  });

  it("falls back to renderDisplay when overview is null or blank", () => {
    const doc = parse(SAMPLE);
    expect(pickProfileView(null, doc)).toBe(renderDisplay(doc));
    expect(pickProfileView("   \n  ", doc)).toBe(renderDisplay(doc));
  });

  it("returns null when both overview and doc are missing", () => {
    expect(pickProfileView(null, null)).toBeNull();
  });
});
