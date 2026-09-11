# 掌握度画像修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复管道中丢失"知识点分节"与"掌握度标注"的三处 bug,并提供全量重建脚本,使画像按具体知识点(循环控制/函数定义/列表操作…)分节、每条带 knowledge_strength 掌握度标注、中文显示。

**Architecture:** 纯函数管道(L1 trace → L2 → L3 → translate)已存在且下游渲染就绪;本计划只接通中间两处断链(strength 传递、section 白名单降级),加一层中文 section 映射,再写一个无 vscode 依赖的 CLI 重建脚本复用整条纯函数管道。spec: `docs/superpowers/specs/2026-09-11-mastery-profile-fix-design.md`。

**Tech Stack:** TypeScript + vitest + esbuild bundling + OpenAI/Ollama backend(与 eval-profile.ts 同模式)。

## Global Constraints

- 测试框架 vitest;严格 TDD——每个任务先写失败测试再实现;单测中 **绝不调真实 LLM**,一律 mock `callLlm`。
- `src/memory/prompts.ts` **零改动**(prompt 已正确);不新增任何 config key。
- section 名在磁盘上保持英文(schema key);中文只出现在 `sectionLabels.ts` 的显示映射。
- knowledge_strength clamp 规则(精确):非有限数(NaN/Infinity)→ `undefined`;有限数 → `Math.round` 后夹到 [1,5]。
- `appendFactsToDoc` 只在 `fact.section` 为**空**时用 fallback;白名单外 section 原样保留。
- 重建脚本闭包内**禁止运行时 import vscode 模块**(`src/memory/store.ts`、`src/memory/paths.ts`、`src/snapshot/reader.ts` 有 vscode 导入,不得 import;`import type` 可)。
- esbuild 命令模式沿用 eval-profile.ts:`npx esbuild scripts/<name>.ts --bundle --platform=node --format=cjs --outfile=out/<name>.cjs`。
- 测试文件风格: vitest `describe/it/expect`,相对路径导入(`../../memory/xxx`),与现有 `src/test/memory/*.test.ts` 一致。
- 提交信息用 conventional commits(feat/fix/test/docs),每个任务至少一次提交。

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/memory/ops.ts` | 修改 | `apply()` add 分支持久化 knowledge_strength + clamp 助手 |
| `src/memory/update.ts` | 修改 | kept.push 带上 strength(×2);`appendFactsToDoc` 信任动态 section |
| `src/memory/settings.ts` | 修改 | `SLOT_FOCUS.profile.sections` 调序(Knowledge level 当 fallback) |
| `src/memory/sectionLabels.ts` | 修改 | 16 个 prompt 主题 section 的中文映射 |
| `src/memory/translate.ts` | 修改 | `translateL3Doc` 漏翻补轮(上限 2 次重试) |
| `scripts/rebuild-profile.ts` | 新增 | 全量重建 CLI(重置 + updateL2×5 + updateL3 + translate + 打印 display) |
| `src/test/memory/ops.test.ts` | 修改 | strength 持久化 + clamp 用例 |
| `src/test/memory/update.test.ts` | 修改 | 反转 off-list 期望 + strength 链路 + fallback 断言 |
| `src/test/memory/translate.test.ts` | 修改 | 补轮重试用例 |
| `src/test/memory/sectionLabels.test.ts` | 新增 | 中文映射 + fallback 回退用例 |

已确认无需改动的相邻代码(实现者不必再查):dedup/merge 经 `applyEdits` 深拷贝展开 `{...e, refs:[...]}`,Entry 上已有 k= 保留(lineDoc.ts:154-159);`document.serialize/parse` 已支持 `k=` round-trip(document.ts:43, 252-253, 197-200);`renderDisplay` 已渲染节/条标签(document.ts:344-397)。

---

### Task 1: ops.apply() 持久化 knowledge_strength

**Files:**
- Modify: `src/memory/ops.ts` (add 分支,当前 141-149 行)
- Test: `src/test/memory/ops.test.ts`

**Interfaces:**
- Consumes: 现有 `AddOp.knowledge_strength?: number`(ops.ts:27 已定义)、`Entry.knowledge_strength?: number`(document.ts:76 已定义)
- Produces: `apply(doc, ops)` 的 add 分支把 clamp 后的 strength 写进 Entry——后续 Task 2/5 依赖"AddOp.knowledge_strength → Entry.knowledge_strength"这条链路成立

- [ ] **Step 1: 写失败测试**

在 `src/test/memory/ops.test.ts` 的 `describe("ops", ...)` 内追加(import 行需补 `serialize`):

```ts
import { parse, serialize, Document } from "../../memory/document";
```

```ts
it("add persists knowledge_strength on the entry", () => {
  const doc = sampleDoc();
  const report = apply(doc, [
    { op: "add", section: "Loop Control", text: "misspells True", refs: [`edit:${U1}`], knowledge_strength: 4 },
  ]);
  expect(report.accepted).toBe(true);
  const entry = doc.find(report.results[0].entry_id!);
  expect(entry?.knowledge_strength).toBe(4);
  // serialize writes the k= attr back out (round-trip proof)
  expect(serialize(doc)).toContain("k=4");
});

it("clamps out-of-range knowledge_strength", () => {
  const doc = sampleDoc();
  const report = apply(doc, [
    { op: "add", section: "S", text: "a", refs: [`edit:${U1}`], knowledge_strength: 0 },
    { op: "add", section: "S", text: "b", refs: [`edit:${U1}`], knowledge_strength: 6 },
    { op: "add", section: "S", text: "c", refs: [`edit:${U1}`], knowledge_strength: 3.7 },
    { op: "add", section: "S", text: "d", refs: [`edit:${U1}`], knowledge_strength: NaN },
    { op: "add", section: "S", text: "e", refs: [`edit:${U1}`], knowledge_strength: Infinity },
  ]);
  expect(report.accepted).toBe(true);
  const [a, b, c, d, e] = report.results.map((r) => doc.find(r.entry_id!));
  expect(a?.knowledge_strength).toBe(1);
  expect(b?.knowledge_strength).toBe(5);
  expect(c?.knowledge_strength).toBe(4);
  expect(d?.knowledge_strength).toBeUndefined();
  expect(e?.knowledge_strength).toBeUndefined();
});

it("add without knowledge_strength leaves it undefined", () => {
  const doc = sampleDoc();
  const report = apply(doc, [
    { op: "add", section: "S", text: "x", refs: [`edit:${U1}`] },
  ]);
  const entry = doc.find(report.results[0].entry_id!);
  expect(entry?.knowledge_strength).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/memory/ops.test.ts`
Expected: FAIL — `clamps` 与 `persists` 两条断言 `undefined`(NaN 用例会碰巧过,属预期;前两条必须红)

- [ ] **Step 3: 实现**

`src/memory/ops.ts` — 把 `apply()` 的 add 分支(当前 141-149 行):

```ts
    if (op.op === "add") {
      const newId = newEntryId();
      doc.sectionEntries(op.section).push({
        id: newId,
        section: op.section,
        text: op.text,
        refs: [...op.refs],
      } satisfies Entry);
```

改为:

```ts
    if (op.op === "add") {
      const newId = newEntryId();
      const knowledge_strength =
        op.knowledge_strength !== undefined ? clampStrength(op.knowledge_strength) : undefined;
      doc.sectionEntries(op.section).push({
        id: newId,
        section: op.section,
        text: op.text,
        refs: [...op.refs],
        knowledge_strength,
      } satisfies Entry);
```

文件末尾(`apply` 之后)加助手:

```ts
/**
 * Clamp an LLM-supplied knowledge strength into 1..5.
 * Non-finite values (NaN/Infinity) mean "no usable signal" → undefined.
 */
function clampStrength(v: number): number | undefined {
  if (!Number.isFinite(v)) return undefined;
  return Math.min(5, Math.max(1, Math.round(v)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/test/memory/ops.test.ts`
Expected: PASS(全部用例绿)

- [ ] **Step 5: 提交**

```bash
git add src/memory/ops.ts src/test/memory/ops.test.ts
git commit -m "fix: persist knowledge_strength on add ops with 1-5 clamp"
```

---

### Task 2: update.ts — strength 传递 + 信任动态 section

**Files:**
- Modify: `src/memory/update.ts` (164 行、294 行 kept.push;325-348 行 appendFactsToDoc)
- Test: `src/test/memory/update.test.ts`

**Interfaces:**
- Consumes: Task 1 的 "AddOp.knowledge_strength → Entry"(appendFactsToDoc:340 早已把 `fact.knowledge_strength` 传给 AddOp,Task 1 后真正落盘)
- Produces: `appendFactsToDoc(doc, facts, fallbackSections: string[])` — 第三参数**改名**且语义变为「仅空 section 时的 fallback 候选」;`ExtractedFact.knowledge_strength` 全链存活。Task 5 的重建脚本与现有调用点(update.ts:166/296)使用同一签名。

- [ ] **Step 1: 写/改失败测试**

`src/test/memory/update.test.ts` 三处改动:

(a) 文件顶部 import 区补 `settings` 与已有 `serialize`(serialize 已在 line 11),新增:

```ts
import { SLOT_FOCUS } from "../../memory/settings";
```

(b) **反转**现有用例(update.test.ts:87-91)——旧代码:

```ts
  it("maps an off-list section into the fallback", () => {
    const doc = new Document();
    appendFactsToDoc(doc, [{ text: "uses X", refs: [REF], section: "Weird" }], ["Patterns"]);
    expect(doc.allEntries()[0].section).toBe("Patterns");
  });
```

替换为:

```ts
  it("keeps an off-list section as-is (trust dynamic sections)", () => {
    const doc = new Document();
    appendFactsToDoc(doc, [{ text: "uses X", refs: [REF], section: "Weird" }], ["Patterns"]);
    expect(doc.allEntries()[0].section).toBe("Weird");
  });
```

(c) 在 `describe("appendFactsToDoc", ...)` 内追加两条:

```ts
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

  it("profile slot fallback section is visible in display (not Identity)", () => {
    expect(SLOT_FOCUS.profile.sections[0]).toBe("Knowledge level");
    expect(SLOT_FOCUS.profile.sections).toContain("Identity");
  });
```

(d) 新增 `describe("updateL3", ...)`(放在 `describe("renderExisting", ...)` 之后);文件顶部还需补第二个 ULID 常量(放在 line 16 `const ULID` 之后):

```ts
const ULID2 = "01HZK5ABCDEFGHJKMNPQRSTVWX";
```

```ts
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
```

(本文件已有 `parse` import — line 11;若 makeDeps 的默认 callLlm 与本用例冲突,以 override 为准,模式与文件内现有 updateL2/updateL3 用例一致。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/memory/update.test.ts`
Expected: FAIL — (b) 得 "Patterns" ≠ "Weird" 红;(c) strength 断言红;(d) `k=4` 断言红。fallback 断言(SLOT_FOCUS 顺序)在 Task 3 才实现,此步**预期红**——注意跑完后 (c) 中 "profile slot fallback" 这条保持红即可,不阻塞本任务其余绿。

- [ ] **Step 3: 实现 update.ts**

三处:

(i) update.ts:164(updateL2 内):

```ts
      kept.push({ text: fact.text, refs: keptRefs, section: fact.section });
```

→

```ts
      kept.push({
        text: fact.text,
        refs: keptRefs,
        section: fact.section,
        knowledge_strength: fact.knowledge_strength,
      });
```

(ii) update.ts:294(updateL3 内)同样改法(两处代码完全相同,逐一定位修改)。

(iii) `appendFactsToDoc`(update.ts:325-348)整函数替换为:

```ts
/**
 * Append each fact as one AddOp; returns the new entry ids.
 *
 * `fallbackSections` is NOT a whitelist: the LLM is explicitly instructed
 * (prompts.ts DYNAMIC SECTIONS) to create specific topic sections like
 * "Loop Control", so off-list sections are trusted as-is. The fallback only
 * covers facts that omit a section entirely — and its first entry must be a
 * section renderDisplay shows (it hides "Identity" as PII; a fallback into
 * Identity would make such facts invisible).
 */
export function appendFactsToDoc(
  doc: Document,
  facts: ExtractedFact[],
  fallbackSections: string[]
): string[] {
  const newIds: string[] = [];
  const fallbackSection = fallbackSections[0] ?? "Notes";
  for (const fact of facts) {
    // L3 objectivity guard: drop facts carrying absolutist phrasing
    // (outside quoted user verbatim). Runtime safety net beneath the prompt.
    if (hasBanned(fact.text)) continue;
    const section = fact.section ? fact.section : fallbackSection;
    const op: AddOp = { op: "add", section, text: fact.text, refs: fact.refs, knowledge_strength: fact.knowledge_strength };
    const report = apply(doc, [op]);
    if (report.accepted && report.results.length > 0) {
      const newId = report.results[0].entry_id;
      if (newId) newIds.push(newId);
    }
  }
  return newIds;
}
```

(iv) 同步更新两个调用点的实参名(签名没变,只是可读性):update.ts:166 与 update.ts:296 的

```ts
    const addedNow = appendFactsToDoc(doc, kept, focus.sections);
```

不变(focus.sections 传入即 fallback 候选)——此步确认无需改动,仅核对。

- [ ] **Step 4: 跑测试确认本任务范围通过**

Run: `npx vitest run src/test/memory/update.test.ts`
Expected: PASS——除 "profile slot fallback" 一条(Task 3 实现)外全绿

- [ ] **Step 5: 提交**

```bash
git add src/memory/update.ts src/test/memory/update.test.ts
git commit -m "fix: trust dynamic sections and propagate knowledge_strength through the update pipeline"
```

---

### Task 3: fallback 调序 + sectionLabels 中文映射

**Files:**
- Modify: `src/memory/settings.ts` (SLOT_FOCUS.profile, 118 行)
- Modify: `src/memory/sectionLabels.ts` (SECTION_LABELS 表)
- Test: `src/test/memory/sectionLabels.test.ts`(新建);Task 2 遗留的 SLOT_FOCUS 断言在此转绿

**Interfaces:**
- Consumes: `sectionLabel(name)` 的 fallback 机制(sectionLabels.ts:41-43,未知名回退原名)
- Produces: `SLOT_FOCUS.profile.sections = ["Knowledge level", "Learning style", "Identity"]`;`sectionLabel("Loop Control") === "循环控制"` 等 16 条映射。renderDisplay 经 `sectionLabel` 自动生效,无新接口。

- [ ] **Step 1: 写失败测试**

新建 `src/test/memory/sectionLabels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sectionLabel } from "../../memory/sectionLabels";

describe("sectionLabel", () => {
  it("maps the prompt-canonical topic sections to Chinese", () => {
    expect(sectionLabel("Loop Control")).toBe("循环控制");
    expect(sectionLabel("List Operations")).toBe("列表操作");
    expect(sectionLabel("Function Definition")).toBe("函数定义");
    expect(sectionLabel("Dictionary Usage")).toBe("字典用法");
    expect(sectionLabel("Import Syntax")).toBe("导入语法");
    expect(sectionLabel("Exception Handling")).toBe("异常处理");
  });

  it("falls back to the original name for unknown sections", () => {
    expect(sectionLabel("Generators")).toBe("Generators");
    expect(sectionLabel("Identity")).toBe("身份信息"); // existing mapping intact
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/memory/sectionLabels.test.ts`
Expected: FAIL — 6 条映射断言得到英文原名

- [ ] **Step 3: 实现**

(a) `src/memory/settings.ts:118` 的:

```ts
    sections: ["Identity", "Learning style", "Knowledge level"],
```

→

```ts
    // Fallback order matters: appendFactsToDoc uses sections[0] for facts
    // that omit a section, and renderDisplay hides "Identity" (PII) — so the
    // visible "Knowledge level" must come first.
    sections: ["Knowledge level", "Learning style", "Identity"],
```

(b) `src/memory/sectionLabels.ts` 的 `SECTION_LABELS` 末尾(diag 组之后)追加:

```ts
  // Dynamic topic sections the L2/L3 prompts steer the LLM toward
  // (prompts.ts DYNAMIC SECTIONS example list). Unknown sections fall back
  // to their English name via sectionLabel.
  "Import Syntax": "导入语法",
  "Variable Scope": "变量作用域",
  "Loop Control": "循环控制",
  "Function Definition": "函数定义",
  "Error Handling": "错误处理",
  "Data Structures": "数据结构",
  "String Manipulation": "字符串操作",
  "List Operations": "列表操作",
  "Dictionary Usage": "字典用法",
  "Control Flow": "流程控制",
  "Exception Handling": "异常处理",
  "Module System": "模块系统",
  "Type Hints": "类型注解",
  "Testing Practices": "测试实践",
  "Debugging Habits": "调试习惯",
  "Code Organization": "代码组织",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/test/memory/sectionLabels.test.ts src/test/memory/update.test.ts`
Expected: PASS — 含 Task 2 遗留的 SLOT_FOCUS 断言转绿

- [ ] **Step 5: 提交**

```bash
git add src/memory/settings.ts src/memory/sectionLabels.ts src/test/memory/sectionLabels.test.ts src/test/memory/update.test.ts
git commit -m "feat: visible profile fallback section and Chinese labels for topic sections"
```

---

### Task 4: translateL3Doc 漏翻补轮

**Files:**
- Modify: `src/memory/translate.ts` (translateL3Doc 主循环, 96-155 行)
- Test: `src/test/memory/translate.test.ts`

**Interfaces:**
- Consumes: 现有 `TranslateDeps`、`BATCH_SIZE=50`、`looksEnglish` 启发
- Produces: `translateL3Doc` 签名不变;返回值语义微调——`translated` = 各轮去重后实际翻译的条数,`untouched` = 送翻但 3 轮内模型始终没返回的条数。调用方(updateProfile.ts:157、Task 5 脚本)无需改动。

- [ ] **Step 1: 写失败测试**

`src/test/memory/translate.test.ts` 追加两条用例:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/memory/translate.test.ts`
Expected: FAIL — 第一条 `pass` 为 1 ≠ 2;第二条 `untouched` 为 1 但 pass=1(单轮)且 r.untouched 语义 = 1 ✓ 但 pass 断言红

- [ ] **Step 3: 实现**

`src/memory/translate.ts` — 常量区(BATCH_SIZE 之后)加:

```ts
/** Total passes over the to-translate list: 1 initial + 2 retries for
 *  entries the model dropped from its response. */
const MAX_PASSES = 3;
```

主循环(96-141 行,从 `const textById` 到 `if (translated === 0)`)整体替换为:

```ts
  const textById = new Map<string, string>();
  let translated = 0;
  let pending = toTranslate;
  let pass = 0;

  while (pending.length > 0 && pass < MAX_PASSES) {
    pass += 1;
    const knownBefore = textById.size;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const payload = JSON.stringify(batch.map((e) => ({ id: e.id, text: e.text })));
      let data: unknown;
      try {
        const callStart = Date.now();
        const context = `translate:pass${pass}:batch${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(pending.length / BATCH_SIZE)}`;
        const raw = await deps.callLlm(TRANSLATE_SYSTEM, payload);
        const llmElapsed = Date.now() - callStart;
        if (deps.onEvent) {
          deps.onEvent({
            stage: "llm_call",
            layer: "translate",
            pass,
            batch_index: Math.floor(i / BATCH_SIZE) + 1,
            total_batches: Math.ceil(pending.length / BATCH_SIZE),
            entries_in_batch: batch.length,
            elapsed_ms: llmElapsed,
            context,
          });
        }
        const json = extractJsonArray(raw);
        if (json === null) continue;
        data = JSON.parse(json);
      } catch {
        continue; // bad batch — leave those entries for the next pass
      }
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          const rec = item as { id: string; text: string };
          if (textById.has(rec.id)) continue;
          textById.set(rec.id, rec.text);
          translated += 1;
        }
      }
    }
    pending = toTranslate.filter((e) => !textById.has(e.id));
    if (textById.size === knownBefore) break; // model keeps dropping — stop burning calls
  }

  if (translated === 0) return { ok: false, translated: 0, untouched: toTranslate.length };
```

末尾 return(155 行)改为:

```ts
  return { ok: true, translated, untouched: toTranslate.length - textById.size };
```

(其余不动:`toTranslate` 计算、`textById` 应用、`saveL3Doc` 原样。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/test/memory/translate.test.ts`
Expected: PASS — 原有 4 条用例(3 条全翻=1 轮、全废=ok:false、空文档跳过、120 条=3 batch)不受影响

- [ ] **Step 5: 提交**

```bash
git add src/memory/translate.ts src/test/memory/translate.test.ts
git commit -m "fix: retry untranslated profile entries for up to two extra passes"
```

---

### Task 5: 全量重建脚本 scripts/rebuild-profile.ts

**Files:**
- Create: `scripts/rebuild-profile.ts`

**Interfaces:**
- Consumes: Task 1-4 修复后的 `updateL2`/`updateL3`/`translateL3Doc`(签名不变);`OpenAIBackend`/`OllamaBackend`/`LlmMessage`(与 eval-profile.ts:21-23 同一导入面);`parseTraceLine`/`traceEventToEntity`(snapshot/adapter.ts,纯);`parseL2Meta`/`serializeL2Meta`/`parseL3Meta`/`serializeL3Meta`/`newL2Meta`/`newL3Meta`(meta.ts)
- Produces: CLI `node out/rebuild-profile.cjs [--storage=...] [--reset-only] [--provider=...] [--base-url=...] [--api-key=...] [--model=...]`;stdout 打印每阶段统计 + `renderDisplay` 全文。Task 6 的真跑验收使用它。

**注意:** 本脚本无法在单测中跑 LLM;其验证 = `--reset-only` 冒烟(无 key 即可跑)+ Task 6 真跑。逐段照抄下述代码。

- [ ] **Step 1: 创建脚本(完整代码)**

```ts
// Full L2+L3 rebuild from the on-disk trace: wipe all L2 docs + metas and
// the L3 profile, then re-run updateL2 for every surface, updateL3(profile),
// and the Chinese translation pass — printing the rendered display view.
//
// Why a reset is needed: the L2/L3 meta sidecars already mark every existing
// trace entity / L2 entry as "seen", so a normal Update is a no-op. Only a
// reset makes the fixed pipeline re-process existing data (2026-09-11 spec).
//
// L2 .md files are deleted too: old entries carry the old flattened sections
// (Patterns/Topics); appendFactsToDoc only appends, so re-organizing into
// per-knowledge-point sections requires starting from an empty doc.
//
// Run from repo root:
//   npx esbuild scripts/rebuild-profile.ts --bundle --platform=node --format=cjs \
//     --outfile=out/rebuild-profile.cjs && node out/rebuild-profile.cjs [flags]
//
// Flags (CLI wins over env, same convention as eval-profile.ts):
//   --storage     <dir>  globalStorage root; default
//                        %APPDATA%/Code/User/globalStorage/deeptutor.vscode-pylearner
//   --reset-only         delete L2/L3 docs+metas, then exit (no LLM — smoke test)
//   --provider    openai | ollama
//   --base-url    http://...
//   --api-key     sk-...           (required for openai)
//   --model       <name>
//
// Bundle constraint: NO runtime vscode imports in this closure — store.ts /
// paths.ts / reader.ts are vscode-coupled, so the thin fs layer below is
// reimplemented with node:fs. `import type { L3Slot }` from paths is fine
// (type-only, erased by esbuild).

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { SURFACES, type Surface } from "../src/constants";
import { parse, serialize, renderDisplay, type Document } from "../src/memory/document";
import {
  newL2Meta,
  newL3Meta,
  parseL2Meta,
  parseL3Meta,
  serializeL2Meta,
  serializeL3Meta,
  type L2Meta,
  type L3Meta,
} from "../src/memory/meta";
import type { L3Slot } from "../src/memory/paths"; // type-only — erased, never bundled
import { translateL3Doc } from "../src/memory/translate";
import { updateL2, updateL3, type ConsolidatorDeps } from "../src/memory/update";
import { parseTraceLine, traceEventToEntity } from "../src/snapshot/adapter";
import type { Entity } from "../src/snapshot/entity";
import { OpenAIBackend } from "../src/llm/openai";
import { OllamaBackend } from "../src/llm/ollama";
import type { LlmBackend, LlmMessage } from "../src/llm/router";

// ── Config ───────────────────────────────────────────────────────────────

function arg(name: string, env: string, def = ""): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag !== undefined) return flag.slice(`--${name}=`.length);
  return process.env[env] ?? def;
}

const defaultStorage = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Code", "User", "globalStorage", "deeptutor.vscode-pylearner")
  : "";
const storageDir = path.resolve(arg("storage", "PYLEARNER_STORAGE", defaultStorage));
const resetOnly = process.argv.includes("--reset-only");

const provider = arg("provider", "LLM_PROVIDER", "openai");
const baseUrl = arg(
  "base-url",
  "LLM_BASE_URL",
  provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com"
);
const apiKey = arg("api-key", "LLM_API_KEY", "");
const model = arg("model", "LLM_MODEL", provider === "ollama" ? "codellama" : "gpt-4o-mini");
const config = { provider, baseUrl, apiKey, model };

// ── Thin fs layer (store.ts is vscode-coupled — reimplement here) ───────

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file); // atomic on the same filesystem
}

async function rmIfExists(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

// ── Doc + meta I/O ───────────────────────────────────────────────────────

function l2DocFile(surface: string): string {
  return path.join(storageDir, "l2", `${surface}.md`);
}
function l2MetaPath(surface: string): string {
  return path.join(storageDir, "l2", `${surface}.meta.json`);
}
function l3DocPath(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}.md`);
}
function l3MetaPath(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}.meta.json`);
}

async function loadL2DocFs(surface: string): Promise<Document | null> {
  const text = await readText(l2DocFile(surface));
  return text === null ? null : parse(text);
}
async function saveL2DocFs(surface: string, doc: Document): Promise<void> {
  await writeTextAtomic(l2DocFile(surface), serialize(doc));
}
async function loadL3DocFs(slot: L3Slot): Promise<Document | null> {
  const text = await readText(l3DocPath(slot));
  return text === null ? null : parse(text);
}
async function saveL3DocFs(slot: L3Slot, doc: Document): Promise<void> {
  await writeTextAtomic(l3DocPath(slot), serialize(doc));
}

async function loadL2MetaFs(surface: string): Promise<L2Meta> {
  const text = await readText(l2MetaPath(surface));
  if (text === null) return newL2Meta();
  try {
    return parseL2Meta(JSON.parse(text));
  } catch {
    return newL2Meta();
  }
}
async function saveL2MetaFs(surface: string, meta: L2Meta): Promise<void> {
  await writeTextAtomic(l2MetaPath(surface), JSON.stringify(serializeL2Meta(meta), null, 2) + "\n");
}
async function loadL3MetaFs(slot: L3Slot): Promise<L3Meta> {
  const text = await readText(l3MetaPath(slot));
  if (text === null) return newL3Meta();
  try {
    return parseL3Meta(JSON.parse(text));
  } catch {
    return newL3Meta();
  }
}
async function saveL3MetaFs(slot: L3Slot, meta: L3Meta): Promise<void> {
  await writeTextAtomic(l3MetaPath(slot), JSON.stringify(serializeL3Meta(meta), null, 2) + "\n");
}

// ── Trace reader (reader.ts is vscode-coupled — reimplement here) ───────

async function readTraceEntitiesFs(surface: Surface): Promise<Entity[]> {
  const dir = path.join(storageDir, "trace", surface);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const entities: Entity[] = [];
  for (const name of names) {
    const text = await readText(path.join(dir, name));
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const event = parseTraceLine(line);
      if (event && event.surface === surface) entities.push(traceEventToEntity(event));
    }
  }
  return entities;
}

// ── Consolidator deps ────────────────────────────────────────────────────

function makeDeps(backend: LlmBackend): ConsolidatorDeps {
  return {
    readEntities: (surface) => readTraceEntitiesFs(surface),
    loadAllL2Docs: async () => {
      const docs: Record<string, Document> = {};
      for (const surface of SURFACES) {
        const doc = await loadL2DocFs(surface);
        if (doc) docs[surface] = doc;
      }
      return docs;
    },
    loadL2Meta: loadL2MetaFs,
    saveL2Meta: saveL2MetaFs,
    loadL3Meta: loadL3MetaFs,
    saveL3Meta: saveL3MetaFs,
    loadL2Doc: loadL2DocFs,
    saveL2Doc: saveL2DocFs,
    loadL3Doc: loadL3DocFs,
    saveL3Doc: saveL3DocFs,
    callLlm: async (system, user, context) => {
      const label = context ?? "unknown";
      const start = Date.now();
      let out = "";
      const messages: LlmMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      await backend.chat(messages, (chunk) => (out += chunk), AbortSignal.timeout(180_000));
      console.log(`[llm] ${label} ok (${Date.now() - start}ms)`);
      return out;
    },
  };
}

// ── Reset ────────────────────────────────────────────────────────────────

async function resetStorage(): Promise<void> {
  let removed = 0;
  for (const surface of SURFACES) {
    if (await rmIfExists(l2DocFile(surface))) removed += 1;
    if (await rmIfExists(l2MetaPath(surface))) removed += 1;
  }
  if (await rmIfExists(l3DocPath("profile"))) removed += 1;
  if (await rmIfExists(l3MetaPath("profile"))) removed += 1;
  console.log(`reset: removed ${removed} file(s) under ${storageDir}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!storageDir || !fs.existsSync(storageDir)) {
    console.error(`storage dir not found: ${storageDir} (pass --storage=<dir>)`);
    process.exit(1);
  }

  await resetStorage();
  if (resetOnly) return;

  if (provider === "openai" && !apiKey) {
    console.error("openai 需要 --api-key 或 LLM_API_KEY");
    process.exit(1);
  }
  const backend: LlmBackend =
    provider === "ollama" ? new OllamaBackend(config) : new OpenAIBackend(config);
  const deps = makeDeps(backend);

  for (const surface of SURFACES) {
    const r = await updateL2(deps, surface);
    console.log(
      `L2 ${surface}: chunks=${r.chunksProcessed} facts=${r.factsAdded} refsDropped=${r.refsDropped}`
    );
  }

  const l3 = await updateL3(deps, "profile");
  console.log(
    `L3 profile: chunks=${l3.chunksProcessed} facts=${l3.factsAdded} refsDropped=${l3.refsDropped}`
  );

  const tr = await translateL3Doc(deps, "profile");
  console.log(`translate: ok=${tr.ok} translated=${tr.translated} untouched=${tr.untouched}`);

  const doc = await loadL3DocFs("profile");
  if (!doc) {
    console.error("l3/profile.md missing after rebuild");
    process.exit(1);
  }
  console.log("\n===== renderDisplay(l3/profile.md) =====\n");
  console.log(renderDisplay(doc));
}

main().catch((err) => {
  console.error("rebuild failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: 冒烟——--reset-only(不需要 API key)**

```bash
npx esbuild scripts/rebuild-profile.ts --bundle --platform=node --format=cjs --outfile=out/rebuild-profile.cjs
node out/rebuild-profile.cjs --reset-only
```

Expected: `reset: removed 12 file(s) under <storageDir>`(5 surface × md+meta = 10,加 profile.md + profile.meta.json = 12)后正常退出 0。**⚠️ 这会真删 globalStorage 的 L2/L3 文件**——trace/ 与 chats/ 不受影响,且本计划的 Task 6 就是要重建,删除即目的。**若想在 Task 6 之前保留现状,先跳过此步,与 Task 6 合并执行。**

再跑一次验证幂等:

```bash
node out/rebuild-profile.cjs --reset-only
```

Expected: `reset: removed 0 file(s) ...`

- [ ] **Step 3: 提交**

```bash
git add scripts/rebuild-profile.ts
git commit -m "feat: add full L2+L3 rebuild script for the fixed mastery pipeline"
```

---

### Task 6: 全量测试 + 真跑验收

**Files:**
- 无新改动;验证 + 可能的小修(若真跑暴露问题,修复后补测试)

- [ ] **Step 1: vitest 全量**

Run: `npx vitest run`
Expected: 全绿(0 failed)。若 autoRefresh/graph/document 等既有用例因 section 行为变化而红,**逐条检查**:预期只有 update.test.ts:87-91 一条需要反转(Task 2 已做);其它红 = 实现有误,修实现而不是改测试。

- [ ] **Step 2: 真跑重建**

```bash
node out/rebuild-profile.cjs --provider=<你的 provider> --base-url=<你的 baseUrl> --api-key=<key> --model=<model>
```

(参数与你在 VS Code 设置里给扩展配的 LLM 一致;provider=ollama 可省 api-key。)

Expected 逐阶段:
1. `reset: removed 12 file(s)...` 或 `0 file(s)`(若 Task 5 Step 2 已删过)
2. 每行 `[llm] L2:<surface>:chunk... ok (…ms)`,无 FAIL/TIMEOUT
3. `L2 <surface>: chunks=N facts=N ...` ×5;`L3 profile: facts>=1`
4. `translate: ok=true translated=N untouched=0`
5. `renderDisplay` 输出:中文分节(如 `## 循环控制 🔴 存在误区`)、每条带档位标签、**无 Identity 节、无英文残留条目**

- [ ] **Step 3: 磁盘审计(可选但推荐)**

打开 `%APPDATA%/Code/User/globalStorage/deeptutor.vscode-pylearner/l3/profile.md`:
Expected: 具体知识点 section + 条目锚点带 `k=1..5`;`[^n]: edit/run/...` 脚注链完整。

- [ ] **Step 4: 覆盖度判断 → 触发模拟数据预案(spec §六)**

若 renderDisplay 知识点 section 数 < 3 或全部同档(说明证据太薄),按 spec §六 写模拟 trace(先与用户确认再动手——超出本计划范围,单独开任务)。

- [ ] **Step 5: (可选)A/B 验证导师引用薄弱点**

```bash
npx esbuild scripts/eval-profile.ts --bundle --platform=node --format=cjs --outfile=out/eval-profile.cjs
PROFILE_PATH="%APPDATA%/Code/User/globalStorage/deeptutor.vscode-pylearner/l3/profile.md" \
LLM_API_KEY=<key> node out/eval-profile.cjs --provider=<provider> --model=<model>
```

Expected: 「带画像」回答针对薄弱知识点(如 while/True 拼写)给出针对性讲解,「不带画像」回答泛泛。

- [ ] **Step 6: 收尾提交(如有小修)**

```bash
git add -A && git commit -m "fix: adjustments from the rebuild acceptance run"
```

(无改动则跳过。)

---

## Self-Review 记录

1. **Spec 覆盖**:spec §3.1→Task 1+2;§3.2→Task 2+3;§3.3→Task 3;§3.4→Task 4;§四→Task 5;§五→Task 1-4 测试 + Task 6;§六→Task 6 Step 4(触发预案,超出本计划单独开任务);§七 边界→各任务 clamp/幂等/空输入已覆盖;§八 非目标未越界(无 prompt 改动、无 renderMasteryMap、无别名表)。
2. **占位符扫描**:所有代码块完整,无 TBD/TODO/"类似 Task N"。
3. **类型一致性**:`appendFactsToDoc(doc, facts, fallbackSections: string[])` 在 Task 2 定义、Task 5 经 updateL2/updateL3 间接使用;`translateL3Doc` 返回字段 `ok/translated/untouched` 与 updateProfile.ts 现有消费一致;脚本 deps 满足 `ConsolidatorDeps` 全部成员(逐一核对过接口)。
