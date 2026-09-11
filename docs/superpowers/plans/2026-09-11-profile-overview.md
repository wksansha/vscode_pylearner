# Profile Overview (老师总评) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画像更新后新增一个 LLM 总评 pass,把 L3 画像喂回 LLM 生成老师口吻的学习情况评语(总评叙述 + 维度表),面板与聊天注入只显示总评。

**Architecture:** 新纯模块 `src/memory/overview.ts`(prompt 构建 + synthesizeOverview),存储为自由 markdown 文件 `l3/<slot>-overview.md`(paths.ts + store.ts 各加两个函数);两个渲染方(面板/注入)经新纯函数 `pickProfileView` 优先取总评、缺失回退 renderDisplay;所有触发点 best-effort,失败不中断管道。不动 ConsolidatorDeps 冻结接口。

**Tech Stack:** TypeScript, vitest, esbuild bundling(扩展本体 + scripts/rebuild-profile.ts)

## Global Constraints

以下值从 spec(docs/superpowers/specs/2026-09-11-profile-overview-design.md)逐字拷贝,每个任务隐含遵守:

- 总评判断列只能用 🟢已掌握 / 🟡一般 / 🔴存在误区 三档。
- 总评文件路径 = `l3/<slot>-overview.md`,自由 markdown,**无 meta sidecar**。
- 不修改 `ConsolidatorDeps` 接口;总评用独立的 `OverviewDeps`。
- 渲染规则:overview 存在优先显示,缺失回退 renderDisplay;renderRaw 审计通道不变。
- 重置路径必须删除 `l3/profile-overview.md`:`resetProfile`(updateProfile.ts)与脚本 `resetStorage` 都要删。
- best-effort:总评失败 emit `{stage:"overview_failed", error}` 并警告日志,不中断管道。
- prompt 硬约束(全部进 buildOverviewSystem):全部中文;第一部分 80-200 字总评叙述;第二部分 markdown 表格表头固定 `| 维度 | 表现 | 判断 |`;维度 5±3 个语义归并;表现列引用画像具体证据;只基于画像证据不臆造;禁止绝对化断言。
- 不新增任何 config key;不实现规则版 renderMasteryMap(被总评取代)。
- overview.ts 是纯模块:除 `import type { L3Slot } from "./paths"` 外不得 import 任何 vscode 依赖模块(paths.ts 顶层 import vscode,类型导入会被擦除——update.ts:28 同款先例)。

---

### Task 1: 总评存储层 + 视图选择纯函数

**Files:**
- Modify: `src/memory/paths.ts`(纯文件名函数 + vscode.Uri 包装,文件头布局注释同步)
- Modify: `src/memory/store.ts`(loadOverview / saveOverview)
- Modify: `src/memory/document.ts`(pickProfileView)
- Test: `src/test/memory/overview.test.ts`(新建)

**Interfaces:**
- Consumes: 现有 `readText`/`writeTextAtomic`(store.ts 内部)、`renderDisplay`(document.ts:375)、`L3Slot`(paths.ts:16)。
- Produces(后续任务依赖,签名逐字):
  - `l3OverviewFileName(slot: L3Slot): string` → `` `${slot}-overview.md` ``(paths.ts,纯)
  - `overviewFile(storageUri: vscode.Uri, slot: L3Slot): vscode.Uri`(paths.ts)
  - `loadOverview(storageUri: vscode.Uri, slot: L3Slot): Promise<string | null>`、`saveOverview(storageUri: vscode.Uri, slot: L3Slot, text: string): Promise<void>`(store.ts)
  - `pickProfileView(overviewText: string | null, doc: Document | null): string | null`(document.ts,导出)

- [ ] **Step 1: 写失败测试**

新建 `src/test/memory/overview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { l3OverviewFileName } from "../../memory/paths";
import { parse, pickProfileView } from "../../memory/document";
import { SAMPLE } from "./document.test"; // 若不可导入,本任务 Step 3 内联;见下

const OVERVIEW_MD = `## 总评

该学生处于 Python 入门初期,基础语法存在系统性薄弱。

| 维度 | 表现 | 判断 |
|---|---|---|
| 基础语法 | 拼写错误频繁(im、asy、Ture) | 🔴存在误区 |
`;

describe("overview storage + view selection", () => {
  it("names the overview file after the slot", () => {
    expect(l3OverviewFileName("profile")).toBe("profile-overview.md");
  });

  it("pickProfileView prefers the overview when present", () => {
    const doc = parse(SAMPLE);
    expect(pickProfileView(OVERVIEW_MD, doc)).toBe(OVERVIEW_MD);
  });

  it("falls back to renderDisplay when overview is null or blank", () => {
    const doc = parse(SAMPLE);
    expect(pickProfileView(null, doc)).toBe(require_renderDisplay_of_sample());
    expect(pickProfileView("   \n  ", doc)).toBe(pickProfileView(null, doc));
  });

  it("returns null when both overview and doc are missing", () => {
    expect(pickProfileView(null, null)).toBeNull();
  });
});
```

注:`SAMPLE` 若未从 document.test.ts 导出(测试文件互相导入不易复用),不要导入——直接在本文件定义同一份 SAMPLE 常量与期望:

```ts
const U1 = "01HZK4ABCDEFGHJKMNPQRSTVWX";
const SAMPLE = `# Python Learner Profile

## Strengths
- Uses list comprehensions frequently [^1] <!--m_${U1}-->

---

[^1]: edit:${U1}
`;

const expectDisplay = `# Python Learner Profile\n\n## Strengths\n\n- Uses list comprehensions frequently [^1] <!--m_${U1}-->`;
```

并用 `renderDisplay` 代替 `require_renderDisplay_of_sample()` 占位——测试直接 `import { renderDisplay }`,断言 `pickProfileView(null, doc)).toBe(renderDisplay(doc))`。**不要**留下任何伪代码/占位符;本 Step 1 的最终测试代码为:

```ts
import { describe, it, expect } from "vitest";
import { l3OverviewFileName } from "../../memory/paths";
import { parse, renderDisplay, pickProfileView } from "../../memory/document";

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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/test/memory/overview.test.ts`
Expected: FAIL — `l3OverviewFileName` 与 `pickProfileView` 未导出。

- [ ] **Step 3: 实现**

`src/memory/paths.ts` — 文件头布局注释追加一行(插在 `//     l3/<slot>.meta.json` 之后):

```
//     l3/<slot>-overview.md                (L3 teacher overview, free-form md)
```

在 `l3MetaFileName` 之后追加纯函数,在 `l3MetaFile` 之后追加 Uri 包装:

```ts
export function l3OverviewFileName(slot: L3Slot): string {
  return `${slot}-overview.md`;
}

export function overviewFile(storageUri: vscode.Uri, slot: L3Slot): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l3", l3OverviewFileName(slot));
}
```

`src/memory/store.ts` — import 行(`./paths`)追加 `overviewFile`;文件末尾追加:

```ts
// ── Overview (free-form teacher synthesis, not a Document) ──────────────

export async function loadOverview(storageUri: vscode.Uri, slot: L3Slot): Promise<string | null> {
  return readText(overviewFile(storageUri, slot));
}

export async function saveOverview(storageUri: vscode.Uri, slot: L3Slot, text: string): Promise<void> {
  await writeTextAtomic(overviewFile(storageUri, slot), text);
}
```

`src/memory/document.ts` — 在 `renderDisplay` 函数之后追加:

```ts
/** Profile reading view: prefer the LLM teacher overview; fall back to the
 *  per-section display view (e.g. right after a reset, before the overview
 *  pass has run). Blank overview text counts as missing. */
export function pickProfileView(overviewText: string | null, doc: Document | null): string | null {
  if (overviewText !== null && overviewText.trim() !== "") return overviewText;
  return doc ? renderDisplay(doc) : null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/test/memory/overview.test.ts`
Expected: PASS(4 tests)。随后全量 `npx vitest run` 保持绿(173 passed,169 + 新 4)。

- [ ] **Step 5: Commit**

```bash
git add src/memory/paths.ts src/memory/store.ts src/memory/document.ts src/test/memory/overview.test.ts
git commit -m "feat: overview storage layer and profile view selection"
```

---

### Task 2: overview.ts 纯模块(prompt + synthesizeOverview)

**Files:**
- Create: `src/memory/overview.ts`
- Test: `src/test/memory/overview.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `pickProfileView` 不需要;需要 `renderDisplay`(document.ts)、`L3Slot`(paths.ts,type-only)。
- Produces(Task 3/4 依赖,签名逐字):
  - `buildOverviewSystem(today: string): string`
  - `buildOverviewUser(profileDisplay: string): string`
  - `interface OverviewDeps { loadL3Doc(slot: L3Slot): Promise<Document | null>; callLlm(systemPrompt: string, userPrompt: string, context?: string): Promise<string>; saveOverviewText(text: string): Promise<void>; onEvent?(event: Record<string, unknown>): void; }`
  - `synthesizeOverview(deps: OverviewDeps, slot: L3Slot): Promise<void>`

- [ ] **Step 1: 写失败测试**(追加到 `src/test/memory/overview.test.ts`)

```ts
import { apply } from "../../memory/ops";
import { synthesizeOverview, buildOverviewSystem, buildOverviewUser, type OverviewDeps } from "../../memory/overview";
import type { L3Slot } from "../../memory/paths";

const EMPTY_DOC = parse("");

function makeDoc(): Document {
  const doc = new Document("User profile");
  apply(doc, [
    { op: "add", section: "Import Syntax", text: "用户在导入语句中打错字", refs: [U1], knowledge_strength: 4 },
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
    expect(deps.calls[0].user).toContain("Import Syntax");
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
```

注意:测试文件顶部 import 需要 `Document`(makeDoc 用 `new Document(...)`),与 Task 1 的 import 合并为
`import { parse, renderDisplay, pickProfileView, Document } from "../../memory/document";`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/test/memory/overview.test.ts`
Expected: FAIL — overview.ts 不存在。

- [ ] **Step 3: 实现 `src/memory/overview.ts`**

```ts
// Teacher-style overview pass: feed the consolidated L3 profile back to the
// LLM once and have it write a term assessment (narrative + dimension table)
// in a teacher's voice. Pure module — the disk and LLM sides are wired by
// each caller (updateProfile.ts, rebuild-profile.ts) via OverviewDeps, so
// ConsolidatorDeps stays frozen.
//
// Storage: l3/<slot>-overview.md, free-form markdown, no meta sidecar. The
// overview is rewritten whole on every pass — it never merges incrementally.

import { renderDisplay, type Document } from "./document";
import type { L3Slot } from "./paths";

export interface OverviewDeps {
  loadL3Doc(slot: L3Slot): Promise<Document | null>;
  callLlm(systemPrompt: string, userPrompt: string, context?: string): Promise<string>;
  saveOverviewText(text: string): Promise<void>;
  onEvent?(event: Record<string, unknown>): void;
}

export function buildOverviewSystem(today: string): string {
  return [
    "你是一名有经验的 Python 老师,为一名学生撰写阶段性学习评语,口吻像老师写给本人/家长看。",
    `今天日期:${today}`,
    "",
    "你会收到该学生的画像(分节知识点事实,每条带掌握度标签 🟢较好/🟡一般/🔴存在误区)。",
    "综合判断学生的学习情况并输出评语,硬性要求:",
    "1. 全部使用中文。",
    "2. 第一部分:一段 80-200 字的总评叙述,概括学习阶段、系统性薄弱点、已有的能力(如纠错意识)。",
    "3. 第二部分:一张 markdown 表格,表头固定为 | 维度 | 表现 | 判断 |。",
    "   - 维度:5±3 个,由画像分节语义归并(如「导入语法」与「语法错误(冒号)」可归并为「基础语法」)。",
    "   - 表现:引用画像中的具体证据(拼写错误、未定义变量清单、类型错误等),不写空话。",
    "   - 判断:只能用 🟢已掌握 / 🟡一般 / 🔴存在误区 三档。",
    "4. 只基于画像证据,不臆造画像中不存在的知识点。",
    "5. 禁止绝对化断言(如「完全不会」「永远记不住」),用具体行为描述。",
    "6. 不要逐条罗列画像原文,不要输出总评叙述和维度表以外的额外小节。",
  ].join("\n");
}

export function buildOverviewUser(profileDisplay: string): string {
  return [
    "# 学生画像(分节事实 + 掌握度标签)",
    "",
    profileDisplay.trim(),
    "",
    "请基于以上画像输出评语:先总评叙述,再维度表。",
  ].join("\n");
}

export async function synthesizeOverview(deps: OverviewDeps, slot: L3Slot): Promise<void> {
  const doc = await deps.loadL3Doc(slot);
  if (!doc || doc.allEntries().length === 0) {
    deps.onEvent?.({ stage: "overview_skipped", reason: "empty_profile" });
    return;
  }
  const system = buildOverviewSystem(new Date().toISOString().slice(0, 10));
  const user = buildOverviewUser(renderDisplay(doc));
  const text = await deps.callLlm(system, user, `L3:${slot}:overview`);
  if (!text.trim()) {
    throw new Error("overview LLM returned empty output");
  }
  await deps.saveOverviewText(text.trim());
  deps.onEvent?.({ stage: "overview_done" });
}
```

注:`todayIso` 沿用 update.ts 的 `toISOString().slice(0, 10)` 惯例,不导出、就地内联。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/test/memory/overview.test.ts`
Expected: PASS(Task 1 的 4 个 + Task 2 的 6 个 = 10)。全量 `npx vitest run` 绿(179)。

- [ ] **Step 5: Commit**

```bash
git add src/memory/overview.ts src/test/memory/overview.test.ts
git commit -m "feat: add teacher-overview synthesis module"
```

---

### Task 3: 扩展侧接线(触发点 + 渲染 + 重置)

**Files:**
- Modify: `src/commands/updateProfile.ts`(runProfileUpdate 尾部 + makeOverviewDeps + resetProfile)
- Modify: `src/memory/paths.ts`(无改动——Task 1 已加;仅 import overviewFile 进 updateProfile.ts)
- Modify: `src/chat/messageHandler.ts`(loadProfileMd 走 pickProfileView)
- Modify: `src/chat/profileViewProvider.ts`(loadProfileSnapshot 的 markdown 走 pickProfileView)
- Test: 无新单测(vscode 耦合层;由 Task 1/2 纯函数测试 + 全量绿覆盖)

**Interfaces:**
- Consumes: Task 1 `loadOverview`/`saveOverview`/`overviewFile`/`pickProfileView`;Task 2 `synthesizeOverview`/`type OverviewDeps`。
- Produces: 面板 markdown 视图与聊天注入均「总评优先」;`runProfileUpdate` 在 translate 后自动跑总评;`resetProfile` 删除总评文件。

- [ ] **Step 1: updateProfile.ts 接线**

import 区(`updateProfile.ts:13-17` 附近)追加:

```ts
import { synthesizeOverview, type OverviewDeps } from "../memory/overview";
import { overviewFile } from "../memory/paths";
```

`makeDeps` 函数之后追加适配器:

```ts
/** Overview pass deps: reuses the consolidator's LLM + L3 loader, adds only
 *  the free-form overview text sink. ConsolidatorDeps stays untouched. */
function makeOverviewDeps(deps: ConsolidatorDeps, storageUri: vscode.Uri): OverviewDeps {
  return {
    loadL3Doc: deps.loadL3Doc,
    callLlm: deps.callLlm,
    saveOverviewText: (text) => store.saveOverview(storageUri, "profile", text),
    onEvent: deps.onEvent,
  };
}
```

`runProfileUpdate` 中,translate 块(`if (result.factsAdded > 0) { ... translateL3Doc ... }`)之后、
Final timing summary 之前插入:

```ts
  // Teacher overview: one LLM call synthesizing the updated profile. Runs when
  // facts were added or when no overview exists yet (previous failure / first
  // run). Best-effort — never fails the pipeline.
  const overviewExists = (await store.loadOverview(storageUri, "profile")) !== null;
  if (result.factsAdded > 0 || !overviewExists) {
    checkCancelled();
    const overviewStart = Date.now();
    try {
      await synthesizeOverview(makeOverviewDeps(deps, storageUri), "profile");
      stageTimes.push({ stage: "overview_complete", elapsed_ms: Date.now() - overviewStart });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`[pylearner:overview] failed: ${msg}`);
      onEvent?.({ stage: "overview_failed", error: msg });
    }
  }
```

`resetProfile`(updateProfile.ts:227-235)删除清单加入总评文件:

```ts
export async function resetProfile(storageUri: vscode.Uri): Promise<void> {
  for (const uri of [
    l3File(storageUri, "profile"),
    l3MetaFile(storageUri, "profile"),
    overviewFile(storageUri, "profile"),
  ]) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Missing file is fine — the goal is "no synthesized profile".
    }
  }
}
```

- [ ] **Step 2: messageHandler.ts 注入改总评优先**

import 行(`messageHandler.ts:9-11`)改为:

```ts
import { loadL3Doc, loadOverview } from "../memory/store";
import { renderDisplay, pickProfileView } from "../memory/document";
```

`loadProfileMd`(messageHandler.ts:16-22)替换为:

```ts
/** Load the tutor-facing profile: the teacher overview when one exists, else
 *  the per-section display view (fallback window right after a reset). */
async function loadProfileMd(storageUri: vscode.Uri): Promise<string | null> {
  const overview = await loadOverview(storageUri, "profile");
  const doc = await loadL3Doc(storageUri, "profile");
  return pickProfileView(overview, doc);
}
```

- [ ] **Step 3: profileViewProvider.ts 面板改总评优先**

import 区加入 `loadOverview`(来自 `../memory/store`)与 `pickProfileView`(来自 `../memory/document`)。

`loadProfileSnapshot`(profileViewProvider.ts:188-200)替换为:

```ts
async function loadProfileSnapshot(
  storageUri: vscode.Uri
): Promise<ProfileSnapshot> {
  const doc = await loadL3Doc(storageUri, "profile");
  if (!doc) return { exists: false, markdown: "", raw: "", updatedAt: null };
  const meta = await loadL3Meta(storageUri, "profile");
  // Teacher/student view: the LLM overview when present, else the display
  // view. The raw audit view (ids + footnotes) is unchanged.
  const overview = await loadOverview(storageUri, "profile");
  return {
    exists: true,
    markdown: pickProfileView(overview, doc) ?? "",
    raw: renderRaw(doc),             // audit view: Chinese labels + ids + footnotes
    updatedAt: meta.last_update_at,
  };
}
```

- [ ] **Step 4: 验证**

Run: `npx vitest run` → 全量绿(179)。
Run: `npx tsc --noEmit` → 无错误。
Run: `npm run compile` → esbuild 打包成功。

- [ ] **Step 5: Commit**

```bash
git add src/commands/updateProfile.ts src/chat/messageHandler.ts src/chat/profileViewProvider.ts
git commit -m "feat: wire teacher overview into update pipeline, panel, and chat injection"
```

---

### Task 4: rebuild 脚本接线

**Files:**
- Modify: `scripts/rebuild-profile.ts`(fs 薄层 overview I/O + reset 清单 + main 调用 + 输出打印)

**Interfaces:**
- Consumes: Task 2 `synthesizeOverview`/`OverviewDeps`(esbuild 打包时随脚本进 bundle;overview.ts 纯模块,无 vscode)。
- Produces: 重建流程输出 `l3/profile-overview.md` 并在控制台打印。

- [ ] **Step 1: fs 薄层 + reset 扩展**

在 `l3MetaPath` 之后追加:

```ts
function overviewFileFs(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}-overview.md`);
}
```

`resetStorage` 删除清单追加(`l3MetaPath("profile")` 行之后):

```ts
  if (await rmIfExists(overviewFileFs("profile"))) removed += 1;
```

- [ ] **Step 2: main 接线**

文件头 import(`../src/memory/translate` 行旁)追加:

```ts
import { synthesizeOverview } from "../src/memory/overview";
```

`main()` 中 translate 行(`translate: ok=...` console.log)之后、加载 doc 之前插入:

```ts
  const overviewStart = Date.now();
  try {
    await synthesizeOverview(
      { loadL3Doc: loadL3DocFs, callLlm: deps.callLlm, saveOverviewText: (text) => writeTextAtomic(overviewFileFs("profile"), text) },
      "profile"
    );
  } catch (err) {
    console.error(`overview failed: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`[timing] overview: ${Date.now() - overviewStart}ms`);
```

末尾 renderDisplay 打印之后追加总评打印:

```ts
  const overviewText = await readText(overviewFileFs("profile"));
  if (overviewText) {
    console.log("\n===== profile-overview.md =====\n");
    console.log(overviewText);
  }
```

- [ ] **Step 3: 验证**

```bash
npx esbuild scripts/rebuild-profile.ts --bundle --platform=node --format=cjs --outfile=out/rebuild-profile.cjs
node out/rebuild-profile.cjs --reset-only   # 应删除 13 个文件(12 + overview),再跑一次为 0
npx vitest run                              # 全量绿(179)
npx tsc --noEmit                            # 无错误
```

- [ ] **Step 4: Commit**

```bash
git add scripts/rebuild-profile.ts
git commit -m "feat: generate teacher overview in rebuild script"
```

---

### Task 5: 真跑验收

**Files:** 无代码改动;产物为 `l3/profile-overview.md` + 验收记录。

**Interfaces:**
- Consumes: Task 4 的 out/rebuild-profile.cjs;真实 API key(用户提供,与上一轮重建相同:provider=openai 兼容 / baseUrl=https://bigmodel.cn/api/paas/v4 / model=glm-4.6v)。

- [ ] **Step 1: 全量重建 + 总评**

```bash
LLM_API_KEY=<用户提供> node out/rebuild-profile.cjs \
  --base-url=https://bigmodel.cn/api/paas/v4 --model=glm-4.6v
```

Expected: exit 0;末尾打印 `===== profile-overview.md =====`;总评为中文,
先一段叙述后维度表,表头 `| 维度 | 表现 | 判断 |`,判断只用三档 emoji,无绝对化断言。

- [ ] **Step 2: 验收清单(spec §五)**

- `l3/profile-overview.md` 存在且为中文总评(叙述 + 维度表,维度 ≤ 8)。
- vitest 全量绿。
- (手动,可选)VS Code 里打开 Profile 面板确认只显示总评;聊天里问"我的学习情况如何"确认导师能引用维度表。

- [ ] **Step 3: 无代码提交(仅验收记录写进 progress ledger)**

---

## Self-Review(已执行)

1. **Spec coverage:** §3.1 overview.ts → Task 2;§3.2 存储(paths/store/脚本 fs 层)→ Task 1/4;§3.3 触发(runProfileUpdate/脚本/reset 语义)→ Task 3/4;§3.4 渲染(面板/注入/pickProfileView/renderRaw 不变)→ Task 1(pickProfileView)/Task 3;§3.5 重置删除 → Task 3(resetProfile)/Task 4(resetStorage);§四 测试 → Task 1/2;§五 真跑验收 → Task 5。无缺口。
2. **Placeholder scan:** 无 TBD/TODO;Task 1 Step 1 内「勿用伪代码」段是对执行者的警示,最终代码块完整。
3. **Type consistency:** `OverviewDeps` 在 Task 2 定义、Task 3/4 消费一致;`pickProfileView(overviewText: string|null, doc: Document|null): string|null` 在 Task 1 定义、Task 3 使用一致;`loadOverview/saveOverview(storageUri, slot)` 签名与 store.ts 现有函数同构。