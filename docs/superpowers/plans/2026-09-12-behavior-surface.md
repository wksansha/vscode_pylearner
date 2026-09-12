# Behavior Surface(打字行为分析)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `behavior` L1 surface:本地提取打字行为特征(节奏/删改/错误复发),经现有 L1→L2→L3 管道汇成带 `knowledge_strength` 的掌握度断言,由老师总评呈现掌握/薄弱。

**Architecture:** 扩展端监听 `.py` 文件逐次变更(不防抖,内存缓冲)与诊断快照,按会话边界(切编辑器/关闭/空闲5min/90min/deactivate)提取为纯本地特征 payload,1 会话 = 1 条 `typing_session` 事件写入 `trace/behavior/`。下游 L2/L3/总评管道零改动,只新增 `SURFACE_FOCUS.behavior` 与 `contentOf` 的嵌套渲染增强。

**Tech Stack:** TypeScript 5.5 / VSCode Extension API (^1.96) / vitest 4 / esbuild

**Spec:** `docs/superpowers/specs/2026-09-12-behavior-surface-design-rev.md`

## Global Constraints

以下约束来自 spec,每个任务都隐含遵守:

- **不新增任何设置/config key**(用户决策,spec §九)。behavior 监听器常开,无独立开关。
- **初值常量,不做设置项**(spec §五/§六/§十二):粘贴阈值 ≥5 字符、空闲 5min、会话上限 90min、续会话窗口 3min、单会话变更上限 5000、`final_text` 截 200 字符、诊断消息截 100 字符、hot_regions 取 top-3、3 行一桶、errors_seen 截 20 条。
- **constructs 为 12 类初值常量表**(spec §六):`for` / `while` / `def` / `class` / `if-elif` / `import` / `try-except` / `dict` / `list comprehension` / `slicing` / `f-string` / `lambda`。不是课程体系,后续只改常量表。
- **不实现** `renderMasteryMap` 规则总览——掌握度呈现由 LLM 老师总评(synthesizeOverview)接管(spec 修订说明 1)。
- **L2/L3/overview 管道零改动**:`update.ts`、`overview.ts`、`document.ts`、`updateProfile.ts`、`store.ts` 一律不动;唯一例外是 `snapshot/adapter.ts` 的 `contentOf`(行为 payload 含嵌套对象,现渲染会输出 `[object Object]`)。
- **L2 focus 文本必须逐字采用 spec §七** 的 `SURFACE_FOCUS.behavior.focus`——它是 LLM 归因的唯一判据来源,含"单会话犹豫不许下结论"防过度概括硬规则。
- **k=5 = "No evidence"**,不是薄弱档;behavior 条目最易落 5,总评三档自然排除。
- **原始击键不持久化**(spec §十二 1):变更记录只存 `{t, line, ins, del}` 计数与行号,不存逐次文本;`final_text` 取自文本镜像。
- 测试框架 vitest,测试放 `src/test/`(include 模式 `src/**/*.test.ts`);现有 20 文件 179 测试必须持续全绿。
- Commit 风格沿用 repo:`feat:` / `test:` / `docs:` 前缀。

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/constants.ts` | Modify | `SURFACES` 加 `"behavior"`;`EVENT_KINDS` 加 `typingSession` |
| `src/memory/settings.ts` | Modify | `SURFACE_FOCUS.behavior`(spec §七逐字) |
| `src/memory/sectionLabels.ts` | Modify | 3 个新 L2 节的中文名 |
| `src/snapshot/adapter.ts` | Modify | `contentOf` 支持数组-of-对象块渲染 + 多行字符串展开 |
| `src/events/behaviorFeatures.ts` | Create | 纯函数特征提取:变更日志+诊断快照+镜像文本 → `TypingSessionPayload` |
| `src/events/behaviorListener.ts` | Modify(新文件) | `BehaviorSessionTracker` 纯状态机 + `createBehaviorListener` vscode 接线 |
| `src/extension.ts` | Modify | 注册 behaviorListener(1 处 import + 1 个 try 块) |
| `src/test/memory/update.test.ts` | Modify | 管道冒烟测试(behavior surface 可被 updateL2 消费) |
| `src/test/snapshot/adapter.test.ts` | Modify | contentOf 嵌套渲染测试 |
| `src/test/events/behaviorFeatures.test.ts` | Create | 特征提取单测(新目录) |
| `src/test/events/behaviorListener.test.ts` | Create | 会话状态机单测(新目录) |

依赖顺序:Task 1(注册)→ Task 2(contentOf)→ Task 3(features)→ Task 4(tracker)→ Task 5(接线)→ Task 6(验收)。

---

### Task 1: Surface 注册 + 管道冒烟测试

**Files:**
- Modify: `src/constants.ts:64-75`
- Modify: `src/memory/settings.ts:88-112`
- Modify: `src/memory/sectionLabels.ts:12-65`
- Test: `src/test/memory/update.test.ts`(文件末尾追加)

**Interfaces:**
- Produces: `Surface` 联合类型含 `"behavior"`;`EVENT_KINDS.typingSession === "typing_session"`;`SURFACE_FOCUS.behavior`。后续所有任务的 `writer.append("behavior", ...)` 与类型检查依赖此项。

- [ ] **Step 1: 在 constants.ts 注册 surface 与 kind**

`src/constants.ts` — `EVENT_KINDS` 末尾(`diagnosticsChange: "diagnostics_change",` 之后)加一行,`SURFACES` 数组末尾加 `"behavior"`:

```ts
export const EVENT_KINDS = {
  runSuccess: "execution_success",
  runError: "execution_error",
  debugSessionStart: "session_start",
  debugSessionEnd: "session_end",
  breakpointChange: "breakpoint_change",
  fileSave: "file_save",
  diagnosticsChange: "diagnostics_change",
  typingSession: "typing_session",
} as const;

export const SURFACES = ["edit", "run", "chat", "debug", "diag", "behavior"] as const;
```

- [ ] **Step 2: 加 SURFACE_FOCUS.behavior(spec §七逐字,这是 LLM 归因唯一判据来源,不得改写)**

`src/memory/settings.ts` — `SURFACE_FOCUS` 对象在 `diag` 条目后追加:

```ts
  behavior: {
    focus:
      "Typing fluency vs conceptual struggle. Judge by these criteria: " +
      "(1) Concept struggle: touches concentrate on one construct, the same " +
      "syntax error recurs (recurred>=2) or pauses/rewrites cluster on it. " +
      "(2) Typing fluency: deletions corrected within seconds, errors scattered " +
      "across constructs, no unresolved errors at end — NOT a knowledge gap. " +
      "(3) Paste reliance: paste_like_inserts dominate insert_chars; " +
      "long IME comment inserts are NOT paste evidence. " +
      "Never claim struggle from a single short session alone: hesitation in " +
      "one session is weak evidence — only report struggle when the same " +
      "construct shows it across 2+ sessions or alongside corroborating " +
      "chat/diag/run evidence.",
    sections: ["Typing fluency", "Concept struggles", "Edit habits"],
  },
```

- [ ] **Step 3: 加三个 L2 节的中文标签**

`src/memory/sectionLabels.ts` — `SECTION_LABELS` 中 `Issues: "问题",` 之后追加(所有其他 L2 节都有中文标签,不补则 Profile/审计视图回退英文):

```ts
  // L2 behavior sections
  "Typing fluency": "打字流畅度",
  "Concept struggles": "概念卡壳",
  "Edit habits": "编辑习惯",
```

- [ ] **Step 4: 写管道冒烟测试(先写,验证失败)**

`src/test/memory/update.test.ts` 文件末尾追加(文件已有 `import type { Surface } from "../../constants";`,不需新 import;`ULID` 常量复用文件顶部的):

```ts
describe("updateL2 with behavior surface", () => {
  it("extracts facts from a typing_session entity via SURFACE_FOCUS.behavior", async () => {
    // 端到端冒烟:手工构造一条 behavior 实体(等价于 behaviorListener 将产出的
    // L1 事件经 contentOf 渲染后的形态),验证 updateL2 按新 surface 走通并
    // 把 focus/sections 送进 LLM prompt。
    const typingEntity: Entity = {
      id: ULID,
      label: "typing_session main.py",
      ts: "2026-09-12T00:00:00.000Z",
      content: [
        "### typing_session",
        "file: main.py",
        "duration_ms: 1230000",
        "ended_by: idle",
        "truncated: false",
        'typing: {"changes":420,"insert_chars":1800,"delete_chars":640,"gap_median_ms":850,"gap_p90_ms":5000,"hesitations_5s":12,"max_gap_ms":230000}',
        "paste_like_inserts: 3",
        "hot_regions:",
        "  - lines: 12-14",
        "    final_text:",
        "      for i in range(10)",
        "          print(i)",
        "    touches: 31",
        "    insert_chars: 400",
        "    delete_chars: 210",
        "    constructs: for",
        'diagnostics: {"errors_seen":[{"msg":"expected \':\'","first_rel_ms":120000,"fixed":true,"latency_ms":45000,"recurred":3}],"unresolved":1}',
      ].join("\n"),
      metadata: { kind: "typing_session" },
      fingerprint: "fp-behavior",
    };
    const llmCalls: string[] = [];
    const deps = makeDeps({
      readEntities: async () => [typingEntity],
      callLlm: async (sys, user) => {
        llmCalls.push(`${sys}\n---\n${user}`);
        return JSON.stringify({
          facts: [
            {
              text: "31 touches clustered on a for-loop with 'expected colon' recurring across sessions",
              section: "Loop Control",
              refs: [`behavior:${ULID}`],
            },
          ],
        });
      },
    });

    const result = await updateL2(deps, "behavior");

    expect(result.factsAdded).toBe(1);
    expect(deps.savedL2).toHaveLength(1);
    const entry = deps.savedL2[0].allEntries()[0];
    expect(entry.section).toBe("Loop Control"); // off-list 动态节原样保留
    expect(entry.refs).toEqual([`behavior:${ULID}`]);
    // focus 文本与节名确实进入了 LLM prompt(system 侧)
    expect(llmCalls[0]).toContain("Typing fluency");
    expect(llmCalls[0]).toContain("Never claim struggle from a single short session alone");
  });
});
```

- [ ] **Step 5: 验证编译 + 全部测试**

Run: `npx tsc --noEmit && npm test`
Expected: tsc 无错误(behavior 进 SURFACES 后 Record<Surface,…> 若缺 SURFACE_FOCUS.behavior 会编译失败——Step 2 已补);vitest 21 文件 180 测试全过。

- [ ] **Step 6: Commit**

```bash
git add src/constants.ts src/memory/settings.ts src/memory/sectionLabels.ts src/test/memory/update.test.ts
git commit -m "feat: register behavior surface with SURFACE_FOCUS and pipeline smoke test"
```

---

### Task 2: contentOf 嵌套渲染(behavior payload 可读化)

**Files:**
- Modify: `src/snapshot/adapter.ts:55-69`(contentOf)及文件底部(新增 helper)
- Test: `src/test/snapshot/adapter.test.ts`(contentOf describe 后追加)

**Interfaces:**
- Consumes: 无(纯函数,独立于 Task 1)
- Produces: `contentOf(event: TraceEvent): string` 签名不变;行为约定升级——顶层 payload 值若为"对象数组"渲染为缩进块,字符串含 `\n` 展开为真实换行(缩进两格挂在键名下,空白行跳过)。Task 3/4 的 payload 渲染依赖此约定。

背景(执行者需知):`renderTracesForConcat` 用 `\n\n` 连接事件块,chunker 的段落边界是 `/\n\s*\n+/`。若把多行 `final_text` 原样展开,其中的空白行会成为假段落边界,chunker 可能拦腰截断事件——所以展开时必须跳过空白行。

- [ ] **Step 1: 写失败测试**

`src/test/snapshot/adapter.test.ts` — 在 `describe("contentOf", ...)` 之后追加:

```ts
describe("contentOf nested payloads", () => {
  const base: TraceEvent = {
    id: "behavior:01HZK4ABCDEFGHJKMNPQRSTVWX",
    ts: "2026-09-12T00:00:00.000Z",
    surface: "behavior",
    kind: "typing_session",
    payload: {},
  };

  it("renders arrays of objects as indented blocks", () => {
    const out = contentOf({
      ...base,
      payload: {
        file: "main.py",
        hot_regions: [
          {
            lines: "12-14",
            final_text: "for i in range(10)\n    print(i)",
            touches: 31,
            constructs: ["for"],
          },
        ],
      },
    });
    expect(out).toContain("hot_regions:");
    expect(out).toContain("  - lines: 12-14");
    expect(out).toContain("    final_text:");
    expect(out).toContain("      for i in range(10)");
    expect(out).toContain("          print(i)"); // 源码 4 空格缩进 + 渲染缩进 6
    expect(out).toContain("    touches: 31");
    expect(out).toContain("    constructs: for");
    expect(out).not.toContain("[object Object]");
  });

  it("skips blank lines inside multi-line strings (paragraph-boundary safety)", () => {
    const out = contentOf({
      ...base,
      payload: { hot_regions: [{ final_text: "a = 1\n\nb = 2", touches: 1 }] },
    });
    // 空白行被跳过:事件内部不得出现 chunker 段落边界 /\n\s*\n+/
    expect(/\n\s*\n/.test(out)).toBe(false);
    expect(out).toContain("      a = 1");
    expect(out).toContain("      b = 2");
  });

  it("renders arrays of strings as before (regression)", () => {
    const out = contentOf({ ...base, payload: { samples: ["err a", "err b"] } });
    expect(out).toContain("samples: err a, err b");
  });

  it("renders nested objects as JSON one-liners (regression)", () => {
    const out = contentOf({ ...base, payload: { typing: { changes: 5 } } });
    expect(out).toContain('typing: {"changes":5}');
  });

  it("renders scalars as before (regression)", () => {
    const out = contentOf({ ...base, payload: { file: "main.py", duration_ms: 123 } });
    expect(out).toContain("file: main.py");
    expect(out).toContain("duration_ms: 123");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/snapshot/adapter.test.ts`
Expected: FAIL——嵌套用例中断言 `hot_regions:`/`- lines:` 失败(现实现把对象数组 join 成 `[object Object]`)。

- [ ] **Step 3: 实现 contentOf 升级**

`src/snapshot/adapter.ts` — 用下面的实现替换现有 `contentOf`,并在文件底部(djb2Hex 之后)追加 `objectLines` helper:

```ts
/** Render a trace event's payload into a human-readable body for the LLM. */
export function contentOf(event: TraceEvent): string {
  const lines = [`### ${event.kind}`];
  for (const [key, value] of Object.entries(event.payload ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const allObjects = value.every(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null && !Array.isArray(v)
      );
      if (allObjects) {
        // Array of objects (e.g. typing_session hot_regions): one indented
        // block per element instead of "[object Object], [object Object]".
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(...objectLines(item, "  "));
        }
      } else {
        lines.push(`${key}: ${value.join(", ")}`);
      }
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render one object element of a payload array: keys at `indent`, string
 * values containing newlines expanded to real lines (two spaces deeper).
 * Blank/whitespace-only lines are SKIPPED: renderTracesForConcat joins
 * event blocks with "\n\n" and the chunker treats /\n\s*\n+/ as a paragraph
 * boundary — a blank source line inside final_text would otherwise let a
 * chunk cut split the event mid-block.
 */
function objectLines(obj: Record<string, unknown>, indent: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" && v.includes("\n")) {
      out.push(`${indent}${k}:`);
      for (const ln of v.split("\n")) {
        if (ln.trim() === "") continue;
        out.push(`${indent}  ${ln}`);
      }
    } else if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push(`${indent}${k}: ${v.join(", ")}`);
    } else if (typeof v === "object") {
      out.push(`${indent}${k}: ${JSON.stringify(v)}`);
    } else {
      out.push(`${indent}${k}: ${String(v)}`);
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/test/snapshot/adapter.test.ts && npm test`
Expected: adapter.test.ts 全过;全量 21 文件 180 测试过(现有 5 个 surface 的 payload 均为标量/字符串数组,唯一新分支是对象数组,无行为变化)。

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/adapter.ts src/test/snapshot/adapter.test.ts
git commit -m "feat: render object-array and multi-line payload values in contentOf"
```

---

### Task 3: behaviorFeatures.ts 纯函数特征提取

**Files:**
- Create: `src/events/behaviorFeatures.ts`
- Test: `src/test/events/behaviorFeatures.test.ts`

**Interfaces:**
- Consumes: 无依赖(vscode mock 环境下纯函数可测)
- Produces(Task 4 消费):
  - `interface BehaviorChangeRecord { t: number; line: number; ins: number; del: number }` — t 为绝对 ms
  - `interface BehaviorDiagSnapshot { t: number; errors: string[] }` — 原始消息,wiring 已截 100 字符
  - `type EndedBy = "editor_switch" | "editor_close" | "idle" | "max_duration" | "deactivate"`
  - `interface BehaviorExtractInput { file: string; startMs: number; endMs: number; endedBy: EndedBy; truncated: boolean; changes: BehaviorChangeRecord[]; diagnostics: BehaviorDiagSnapshot[]; finalText: string }`
  - `interface TypingSessionPayload { file: string; duration_ms: number; ended_by: EndedBy; truncated: boolean; typing: TypingFeatures; paste_like_inserts: number; hot_regions: HotRegion[]; diagnostics: DiagnosticsFeatures }`(子类型见实现)
  - `extractTypingSession(input: BehaviorExtractInput): TypingSessionPayload`
  - `normalizeDiagMsg(raw: string): string | null`
  - `detectConstructs(text: string): string[]`
  - `BEHAVIOR_CONSTANTS`(常量表,Task 5 wiring 引用 `DIAG_MSG_MAX_CHARS`)

- [ ] **Step 1: 写失败测试**

创建 `src/test/events/behaviorFeatures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  extractTypingSession,
  normalizeDiagMsg,
  detectConstructs,
  type BehaviorChangeRecord,
  type BehaviorDiagSnapshot,
} from "../../events/behaviorFeatures";

const multiLineFile = [
  "x = 1", "y = 2", "z = 3", "a = 4", "b = 5",
  "c = 6", "d = 7", "e = 8", "f = 9", "g = 10", "h = 11",
  "for i in range(10)", "    print(i)", "",
].join("\n");

describe("extractTypingSession: fast-typing-with-random-errors", () => {
  // 手滑:秒级删改重打、错误分散、结尾无未解决错误
  const changes: BehaviorChangeRecord[] = [
    { t: 0, line: 1, ins: 1, del: 0 },
    { t: 400, line: 1, ins: 0, del: 1 },
    { t: 700, line: 1, ins: 1, del: 0 },
    { t: 1100, line: 5, ins: 1, del: 0 },
    { t: 1500, line: 8, ins: 1, del: 0 },
    { t: 1600, line: 8, ins: 0, del: 1 },
    { t: 2000, line: 8, ins: 1, del: 0 },
  ];
  const diagnostics: BehaviorDiagSnapshot[] = [
    { t: 500, errors: ["name 'x' is not defined (main.py, line 1)"] },
    { t: 1200, errors: ["TypeError: bad operand type (main.py, line 5)"] },
    { t: 1900, errors: [] },
  ];

  const payload = extractTypingSession({
    file: "main.py",
    startMs: 0,
    endMs: 3000,
    endedBy: "editor_switch",
    truncated: false,
    changes,
    diagnostics,
    finalText: "x = 1",
  });

  it("has low hesitations and no paste reliance", () => {
    expect(payload.typing.hesitations_5s).toBe(0);
    expect(payload.paste_like_inserts).toBe(0);
    expect(payload.typing.gap_median_ms).toBeLessThan(1000);
  });

  it("aggregates scattered errors without recurrence and no unresolved", () => {
    expect(payload.diagnostics.errors_seen).toHaveLength(2);
    expect(payload.diagnostics.errors_seen[0].recurred).toBe(0);
    expect(payload.diagnostics.errors_seen[0].fixed).toBe(true);
    expect(payload.diagnostics.unresolved).toBe(0);
  });

  it("computes typing totals", () => {
    expect(payload.typing.changes).toBe(7);
    expect(payload.typing.insert_chars).toBe(5);
    expect(payload.typing.delete_chars).toBe(2);
    expect(payload.duration_ms).toBe(3000);
    expect(payload.ended_by).toBe("editor_switch");
  });
});

describe("extractTypingSession: for-loop struggle (spec §四 walkthrough)", () => {
  const changes: BehaviorChangeRecord[] = [
    { t: 0, line: 12, ins: 10, del: 0 },
    { t: 40_000, line: 12, ins: 0, del: 6 },
    { t: 42_000, line: 12, ins: 8, del: 0 },
    { t: 120_000, line: 13, ins: 12, del: 0 },
    { t: 222_000, line: 12, ins: 0, del: 1 },
    { t: 240_000, line: 12, ins: 4, del: 0 },
    { t: 260_000, line: 5, ins: 2, del: 0 },
  ];
  const diagnostics: BehaviorDiagSnapshot[] = [
    { t: 120_000, errors: ["expected ':' (main.py, line 12)"] },
    { t: 165_000, errors: [] },
    { t: 300_000, errors: ["expected ':' (main.py, line 13)"] }, // 不同行号 → 同一错误复发
  ];

  const payload = extractTypingSession({
    file: "main.py",
    startMs: 0,
    endMs: 560_000, // idle 结束:最后变更 260s + 空闲 300s
    endedBy: "idle",
    truncated: false,
    changes,
    diagnostics,
    finalText: multiLineFile,
  });

  it("clusters hot regions on the 3-line bucket containing the for loop", () => {
    // 桶按 3 行划分:行 12 → 桶 10-12(5 touches),行 13 → 桶 13-15(1),
    // 行 5 → 桶 4-6(1);top-3 全保留,touches 并列时按起始行升序。
    expect(payload.hot_regions).toHaveLength(3);
    expect(payload.hot_regions[0].lines).toBe("10-12");
    expect(payload.hot_regions[1].lines).toBe("4-6");
    expect(payload.hot_regions[2].lines).toBe("13-15");
    expect(payload.hot_regions[0].touches).toBe(5);
    expect(payload.hot_regions[0].insert_chars).toBe(22);
    expect(payload.hot_regions[0].delete_chars).toBe(7);
    expect(payload.hot_regions[0].constructs).toContain("for");
    expect(payload.hot_regions[0].final_text).toContain("for i in range(10)");
    expect(payload.hot_regions[0].final_text).toContain("\n");
  });

  it("counts the trailing idle gap into max gap and hesitations", () => {
    // gaps: 40000,2000,78000,102000,18000,20000 + 尾随 300000
    expect(payload.typing.max_gap_ms).toBe(300_000);
    expect(payload.typing.hesitations_5s).toBe(6);
    // median of [2000,18000,20000,40000,78000,102000,300000] → idx 3 = 40000
    expect(payload.typing.gap_median_ms).toBe(40_000);
    // p90 nearest-rank: ceil(0.9*7)-1 = idx 6 → 300000
    expect(payload.typing.gap_p90_ms).toBe(300_000);
  });

  it("aggregates recurrence across different line numbers", () => {
    const seen = payload.diagnostics.errors_seen;
    expect(seen).toHaveLength(1);
    expect(seen[0].msg).toBe("expected ':'");
    expect(seen[0].first_rel_ms).toBe(120_000);
    expect(seen[0].fixed).toBe(true);
    expect(seen[0].latency_ms).toBe(45_000); // 165s 消失 - 120s 首现
    expect(seen[0].recurred).toBe(1);        // 300s 复发一次
    expect(payload.diagnostics.unresolved).toBe(1); // 结束时最后快照仍有错误
  });
});

describe("extractTypingSession: paste-heavy session", () => {
  it("counts inserts >= 5 chars as paste-like (incl. long IME comments)", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 60_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 40, del: 0 },
        { t: 30_000, line: 2, ins: 60, del: 0 },
        { t: 60_000, line: 3, ins: 20, del: 0 }, // IME 中文注释长插入,同样计入
      ],
      diagnostics: [],
      finalText: "# 注释\n# 注释\n# 注释",
    });
    expect(payload.paste_like_inserts).toBe(3);
  });

  it("does not count <= 4 char inserts (typing aids: brackets, auto-indent)", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 10_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 4, del: 0 },
        { t: 5_000, line: 1, ins: 1, del: 0 },
        { t: 9_000, line: 1, ins: 2, del: 0 },
      ],
      diagnostics: [],
      finalText: "x = (",
    });
    expect(payload.paste_like_inserts).toBe(0);
  });
});

describe("extractTypingSession: edge cases", () => {
  it("handles a single change (no gaps) without crashing", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 5_000,
      endedBy: "editor_close",
      truncated: false,
      changes: [{ t: 0, line: 1, ins: 3, del: 0 }],
      diagnostics: [],
      finalText: "abc",
    });
    expect(payload.typing.gap_median_ms).toBe(0);
    expect(payload.typing.gap_p90_ms).toBe(0);
    expect(payload.typing.max_gap_ms).toBe(0);
    expect(payload.typing.hesitations_5s).toBe(0);
    expect(payload.diagnostics.errors_seen).toEqual([]);
    expect(payload.diagnostics.unresolved).toBe(0);
  });

  it("does not count trailing idle gap for non-idle endings", () => {
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 400_000,
      endedBy: "editor_switch",
      truncated: false,
      changes: [
        { t: 0, line: 1, ins: 2, del: 0 },
        { t: 100_000, line: 1, ins: 2, del: 0 },
      ],
      diagnostics: [],
      finalText: "ab",
    });
    // gaps 只有 [100000];尾随 300s 不计入
    expect(payload.typing.max_gap_ms).toBe(100_000);
    expect(payload.typing.hesitations_5s).toBe(1);
  });

  it("flags truncated sessions and keeps change count at the cap boundary", () => {
    const changes: BehaviorChangeRecord[] = Array.from({ length: 5001 }, (_, i) => ({
      t: i,
      line: 1,
      ins: 1,
      del: 0,
    }));
    const payload = extractTypingSession({
      file: "main.py",
      startMs: 0,
      endMs: 6000,
      endedBy: "idle",
      truncated: true, // tracker 超上限后置位;features 只透传
      changes,
      diagnostics: [],
      finalText: "a",
    });
    expect(payload.truncated).toBe(true);
    expect(payload.typing.changes).toBe(5001); // features 不截断,截断是 tracker 的职责
  });
});

describe("normalizeDiagMsg", () => {
  it("strips file/line location suffixes and lowercases", () => {
    expect(normalizeDiagMsg("expected ':' (main.py, line 12)")).toBe("expected ':'");
    expect(normalizeDiagMsg("SyntaxError: invalid syntax (main.py, line 3)")).toBe(
      "syntaxerror: invalid syntax"
    );
  });

  it("aggregates the same error across different files and lines", () => {
    expect(normalizeDiagMsg("expected ':' (a.py, line 1)")).toBe(
      normalizeDiagMsg("expected ':' (b.py, line 99)")
    );
  });

  it("returns null for empty-after-normalization messages", () => {
    expect(normalizeDiagMsg("   ")).toBeNull();
    expect(normalizeDiagMsg("(main.py, line 3)")).toBeNull();
  });
});

describe("detectConstructs", () => {
  it("detects for-loops and f-strings in a region", () => {
    const text = 'for i in range(10):\n    print(f"item {i}")';
    const tags = detectConstructs(text);
    expect(tags).toContain("for");
    expect(tags).toContain("f-string");
    expect(tags).not.toContain("while");
  });

  it("matches multiple constructs and keeps the fixed order", () => {
    // {k: v for k, v in items} 含冒号 → dict 标签;无方括号 for → 无 list comprehension
    const tags = detectConstructs("data = {k: v for k, v in items}\nslice = xs[1:5]");
    expect(tags).toEqual(["for", "dict", "slicing"]);
  });

  it("does not mistake keywords inside identifiers (if → f-string)", () => {
    expect(detectConstructs('if("x"):')).not.toContain("f-string");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/events/behaviorFeatures.test.ts`
Expected: FAIL——模块不存在(vite 报 failed to resolve import)。

- [ ] **Step 3: 实现 behaviorFeatures.ts**

创建 `src/events/behaviorFeatures.ts`(完整实现,无 vscode 依赖):

```ts
// Typing-behavior feature extraction (pure, no vscode, no LLM).
//
// Converts one session's buffered change records + diagnostic snapshots +
// final text mirror into the compact `typing_session` payload described in
// the behavior-surface spec §六. The listener owns session lifecycle; this
// module only does math, so every rule is unit-testable and auditable.
//
// Numeric thresholds live in BEHAVIOR_CONSTANTS as initial-value constants
// (spec §十二) — deliberately NOT user settings. They are evidence for the
// LLM's attribution (SURFACE_FOCUS.behavior), never code-level verdicts.

export const BEHAVIOR_CONSTANTS = {
  /** Single-event inserts ≥ this many chars count as paste-like. */
  PASTE_LIKE_MIN_CHARS: 5,
  /** Gaps above this are hesitations (long pauses). */
  HESITATION_MS: 5_000,
  /** Line-bucket size for hot regions. */
  HOT_REGION_LINE_BUCKET: 3,
  /** Keep at most this many hot regions. */
  HOT_REGION_MAX: 3,
  /** Cap for hot-region final_text. */
  FINAL_TEXT_MAX_CHARS: 200,
  /** Cap applied by the wiring when snapshotting diagnostic messages. */
  DIAG_MSG_MAX_CHARS: 100,
  /** Cap for the errors_seen list (sorted by first appearance). */
  ERRORS_SEEN_MAX: 20,
} as const;

export type EndedBy =
  | "editor_switch"
  | "editor_close"
  | "idle"
  | "max_duration"
  | "deactivate";

/** One buffered document change. `t` is absolute ms (Date.now() at record). */
export interface BehaviorChangeRecord {
  t: number;
  /** 1-based start line of the change. */
  line: number;
  /** Inserted chars (change.text.length). */
  ins: number;
  /** Deleted chars (change.rangeLength). */
  del: number;
}

/** One diagnostic snapshot within the session. Messages raw (wiring truncates). */
export interface BehaviorDiagSnapshot {
  t: number;
  errors: string[];
}

export interface BehaviorExtractInput {
  file: string;
  startMs: number;
  endMs: number;
  endedBy: EndedBy;
  truncated: boolean;
  changes: BehaviorChangeRecord[];
  diagnostics: BehaviorDiagSnapshot[];
  /** Full current text of the file (from the listener's mirror). */
  finalText: string;
}

export interface TypingFeatures {
  changes: number;
  insert_chars: number;
  delete_chars: number;
  gap_median_ms: number;
  gap_p90_ms: number;
  hesitations_5s: number;
  max_gap_ms: number;
}

export interface HotRegion {
  /** "12-14" for a range, "12" for a single line. */
  lines: string;
  final_text: string;
  touches: number;
  insert_chars: number;
  delete_chars: number;
  constructs: string[];
}

export interface ErrorSighting {
  msg: string;
  first_rel_ms: number;
  fixed: boolean;
  /** First-fix latency (firstSeen → first disappearance). Omitted if never fixed. */
  latency_ms?: number;
  /** Times the error reappeared after having been absent. */
  recurred: number;
}

export interface DiagnosticsFeatures {
  errors_seen: ErrorSighting[];
  /** Distinct errors still present in the last snapshot. */
  unresolved: number;
}

export interface TypingSessionPayload {
  file: string;
  duration_ms: number;
  ended_by: EndedBy;
  truncated: boolean;
  typing: TypingFeatures;
  paste_like_inserts: number;
  hot_regions: HotRegion[];
  diagnostics: DiagnosticsFeatures;
}

// 12-entry initial-value construct table (spec §六). Keyword-based, so
// false positives are accepted noise; finer classification is the LLM's
// job at L2 time via final_text.
const CONSTRUCT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["for", /\bfor\b/],
  ["while", /\bwhile\b/],
  ["def", /\bdef\b/],
  ["class", /\bclass\b/],
  ["if-elif", /\b(?:if|elif)\b/],
  ["import", /\b(?:import|from)\b/],
  ["try-except", /\b(?:try|except)\b/],
  ["dict", /\{[^{}\n]*:[^{}\n]*\}/],
  ["list comprehension", /\[[^\]\n]*\bfor\b[^\]\n]*\]/],
  ["slicing", /\[\s*-?[\w.]*\s*:\s*-?[\w.]*\s*\]/],
  ["f-string", /\bf["']/],
  ["lambda", /\blambda\b/],
];

export function detectConstructs(text: string): string[] {
  const out: string[] = [];
  for (const [name, re] of CONSTRUCT_PATTERNS) {
    if (re.test(text)) out.push(name);
  }
  return out;
}

// Spec §六 normalization: strip "(file.py, line N)" location suffixes and
// bare "line N" fragments, collapse whitespace, lowercase. Same message at
// different lines aggregates as one recurring error; empty results drop.
const _LOC_PARENS_RE = /\((?:[^()]*\.py[^()]*)\)/g;
const _LINE_NUM_RE = /(?:, )?\bline \d+/gi;

export function normalizeDiagMsg(raw: string): string | null {
  let msg = raw.trim();
  msg = msg.replace(_LOC_PARENS_RE, "");
  msg = msg.replace(_LINE_NUM_RE, "");
  msg = msg.replace(/\s+/g, " ").trim().toLowerCase();
  return msg.length > 0 ? msg : null;
}

export function extractTypingSession(input: BehaviorExtractInput): TypingSessionPayload {
  const { changes, diagnostics, finalText, startMs, endMs, endedBy } = input;
  const c = BEHAVIOR_CONSTANTS;

  const durationMs = Math.max(0, endMs - startMs);

  // Gap series between consecutive changes. For idle-ended sessions the
  // trailing pause (last change → extraction) IS the max hesitation signal
  // (spec §五) and joins the series; other endings exclude it.
  const gaps: number[] = [];
  for (let i = 1; i < changes.length; i++) {
    gaps.push(Math.max(0, changes[i].t - changes[i - 1].t));
  }
  if (endedBy === "idle" && changes.length > 0) {
    gaps.push(Math.max(0, endMs - changes[changes.length - 1].t));
  }
  const sorted = [...gaps].sort((a, b) => a - b);

  const hotRegions = extractHotRegions(changes, finalText);

  return {
    file: input.file,
    duration_ms: durationMs,
    ended_by: endedBy,
    truncated: input.truncated,
    typing: {
      changes: changes.length,
      insert_chars: changes.reduce((s, ch) => s + ch.ins, 0),
      delete_chars: changes.reduce((s, ch) => s + ch.del, 0),
      gap_median_ms: median(sorted),
      gap_p90_ms: percentile90(sorted),
      hesitations_5s: gaps.filter((g) => g > c.HESITATION_MS).length,
      max_gap_ms: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    },
    paste_like_inserts: changes.filter((ch) => ch.ins >= c.PASTE_LIKE_MIN_CHARS).length,
    hot_regions: hotRegions,
    diagnostics: aggregateDiagnostics(diagnostics, startMs),
  };
}

function extractHotRegions(
  changes: BehaviorChangeRecord[],
  finalText: string
): HotRegion[] {
  const c = BEHAVIOR_CONSTANTS;
  if (changes.length === 0) return [];
  const bucketSize = c.HOT_REGION_LINE_BUCKET;

  // Group by 3-line bucket, keyed by the bucket's first line (1-based).
  const buckets = new Map<number, { touches: number; ins: number; del: number }>();
  for (const ch of changes) {
    const bucketStart = Math.floor((ch.line - 1) / bucketSize) * bucketSize + 1;
    const b = buckets.get(bucketStart) ?? { touches: 0, ins: 0, del: 0 };
    b.touches += 1;
    b.ins += ch.ins;
    b.del += ch.del;
    buckets.set(bucketStart, b);
  }

  const top = [...buckets.entries()]
    .sort((a, b) => b[1].touches - a[1].touches || a[0] - b[0])
    .slice(0, c.HOT_REGION_MAX);

  const lines = finalText.split("\n");
  return top.map(([bucketStart, b]) => {
    const bucketEnd = bucketStart + bucketSize - 1;
    const slice = lines.slice(Math.max(0, bucketStart - 1), bucketEnd);
    const text = slice.join("\n").slice(0, c.FINAL_TEXT_MAX_CHARS);
    return {
      lines: bucketStart === bucketEnd ? `${bucketStart}` : `${bucketStart}-${bucketEnd}`,
      final_text: text,
      touches: b.touches,
      insert_chars: b.ins,
      delete_chars: b.del,
      constructs: detectConstructs(text),
    };
  });
}

interface DiagTrack {
  firstSeen: number;
  currentlyPresent: boolean;
  fixed: boolean;
  fixedAt: number;
  recurred: number;
}

function aggregateDiagnostics(
  snapshots: BehaviorDiagSnapshot[],
  startMs: number
): DiagnosticsFeatures {
  const c = BEHAVIOR_CONSTANTS;
  const tracks = new Map<string, DiagTrack>();
  for (const snap of snapshots) {
    const present = new Set<string>();
    for (const raw of snap.errors) {
      const msg = normalizeDiagMsg(raw);
      if (!msg) continue;
      present.add(msg);
      const tr = tracks.get(msg);
      if (!tr) {
        tracks.set(msg, { firstSeen: snap.t, currentlyPresent: true, fixed: false, fixedAt: 0, recurred: 0 });
      } else if (!tr.currentlyPresent) {
        tr.recurred += 1; // was absent, now back → recurrence
        tr.currentlyPresent = true;
      }
    }
    for (const [msg, tr] of tracks) {
      if (!present.has(msg) && tr.currentlyPresent) {
        tr.currentlyPresent = false;
        if (!tr.fixed) {
          tr.fixed = true;
          tr.fixedAt = snap.t;
        }
      }
    }
  }

  const errors_seen: ErrorSighting[] = [...tracks.entries()]
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    .slice(0, c.ERRORS_SEEN_MAX)
    .map(([msg, tr]) => ({
      msg,
      first_rel_ms: Math.max(0, tr.firstSeen - startMs),
      fixed: tr.fixed,
      ...(tr.fixed ? { latency_ms: Math.max(0, tr.fixedAt - tr.firstSeen) } : {}),
      recurred: tr.recurred,
    }));

  const unresolved = [...tracks.values()].filter((tr) => tr.currentlyPresent).length;
  return { errors_seen, unresolved };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile90(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/test/events/behaviorFeatures.test.ts`
Expected: PASS 全部用例。若 hot_regions 断言失败,检查桶计算:`floor((line-1)/3)*3+1`,行 12 → 桶 10(10-12),行 13 → 同桶。

- [ ] **Step 5: 全量回归**

Run: `npm test`
Expected: 22 文件全过。

- [ ] **Step 6: Commit**

```bash
git add src/events/behaviorFeatures.ts src/test/events/behaviorFeatures.test.ts
git commit -m "feat: add pure typing-behavior feature extraction"
```

---

### Task 4: BehaviorSessionTracker 会话状态机

**Files:**
- Create: `src/events/behaviorListener.ts`(本任务只实现 tracker 部分;接线在 Task 5)
- Test: `src/test/events/behaviorListener.test.ts`

**Interfaces:**

- Consumes: Task 3 的 `extractTypingSession` / `TypingSessionPayload` / `BehaviorChangeRecord` / `BehaviorDiagSnapshot` / `EndedBy`
- Produces(Task 5 与 extension.ts 消费):
  - `class BehaviorSessionTracker` — 纯状态机,时间戳由调用方显式传入:
    - `onEdit(file: string, line: number, ins: number, del: number, mirrorText: string, t: number): void`
    - `onDiagnostics(file: string, errorMessages: string[], t: number): void`
    - `onEditorSwitch(fromFile: string, t: number): void`
    - `onFileClosed(file: string, t: number): void`
    - `checkIdle(t: number): void`
    - `dispose(t: number): void` — 以 `deactivate` 结束所有开会话
    - `drain(t: number): TypingSessionPayload[]` — 先把续会话窗口已过期的挂起会话落定为 payload,再取走全部待发 payload
  - `function createBehaviorListener(writer: L1Writer): vscode.Disposable`(Task 5 实现主体)

设计说明(执行者需知):状态机与 vscode 接线分离在同一文件——tracker 不触碰任何 vscode API(时间全部入参),可零 mock 测试;`createBehaviorListener` 是薄接线(订阅/过滤/时钟),沿用 editListener 的模式但不写单测(与现有 `editListener`/`diagnosticsListener` 无单测的先例一致,行为断言全部落在 tracker 测试;这偏离 spec §十一测试 2 的"mock vscode 事件"措辞,但覆盖了其中列出的全部行为:边界触发提取、续会话、dispose 清理——L1 写入接线仅 3 行,由 Task 6 手动验收覆盖)。

**发射模型(park + materialize,2026-09-12 评审后修订):**
会话边界触发时**不立即**提取写 L1,而是把已结束会话挂起(closed 槽位)进入 3min 续会话窗口;窗口内同文件再编辑 → 续会话(沿用原缓冲与起止时间,spec §五);窗口过期/被其它会话让位/dispose 时才提取为 payload 入队。这样"对照抄代码来回切"场景在 trace 里只出现**一条**延续会话事件(而非先发一条再发重叠的一条),打字统计不被重复计数;代价是 payload 落盘最多延迟 ~3min(或到 idle tick / dispose),对批量 Update 流程无感。`<3` 变更的会话在 endSession 时直接丢弃(spec §八),不可续。

- [ ] **Step 1: 写失败测试**

创建 `src/test/events/behaviorListener.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BehaviorSessionTracker } from "../../events/behaviorListener";
import type { TypingSessionPayload } from "../../events/behaviorFeatures";

const RESUME_WINDOW = 3 * 60_000; // 与 tracker DEFAULTS.resumeWindowMs 一致

function drain(tracker: BehaviorSessionTracker, t: number): TypingSessionPayload[] {
  return tracker.drain(t);
}

describe("BehaviorSessionTracker", () => {
  it("ends a session on editor switch and emits one payload after the resume window", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "print(1)", 0);
    tracker.onEdit("main.py", 1, 0, 1, "print()", 1_000);
    tracker.onEdit("main.py", 2, 3, 0, "print()\nx=1", 2_000);
    tracker.onEditorSwitch("main.py", 3_000);

    expect(drain(tracker, 3_000)).toHaveLength(0); // 挂起中,等待续会话窗口
    const out = drain(tracker, 3_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("main.py");
    expect(out[0].ended_by).toBe("editor_switch");
    expect(out[0].typing.changes).toBe(3);
    expect(out[0].duration_ms).toBe(3_000);
  });

  it("drops <3-change sessions outright for every end reason", () => {
    // editor_switch
    const t1 = new BehaviorSessionTracker();
    t1.onEdit("main.py", 1, 5, 0, "x", 0);
    t1.onEdit("main.py", 1, 0, 1, "", 1_000);
    t1.onEditorSwitch("main.py", 2_000);
    expect(drain(t1, 2_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // idle
    const t2 = new BehaviorSessionTracker();
    t2.onEdit("main.py", 1, 5, 0, "x", 0);
    t2.onEdit("main.py", 1, 0, 1, "", 100_000);
    t2.checkIdle(400_000);
    expect(drain(t2, 400_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // editor_close
    const t3 = new BehaviorSessionTracker();
    t3.onEdit("main.py", 1, 5, 0, "x", 0);
    t3.onEdit("main.py", 1, 0, 1, "", 1_000);
    t3.onFileClosed("main.py", 2_000);
    expect(drain(t3, 2_000 + RESUME_WINDOW + 1)).toHaveLength(0);

    // deactivate(dispose 即时落定,无需等窗口)
    const t4 = new BehaviorSessionTracker();
    t4.onEdit("main.py", 1, 5, 0, "x", 0);
    t4.onEdit("main.py", 1, 0, 1, "", 1_000);
    t4.dispose(2_000);
    expect(drain(t4, 2_000)).toHaveLength(0);

    // max_duration(拆分点的 <3 半段同样丢弃)
    const t5 = new BehaviorSessionTracker();
    t5.onEdit("main.py", 1, 5, 0, "x", 0);
    t5.onEdit("main.py", 1, 0, 1, "", 91 * 60_000); // 超 90min → 拆分
    t5.onEditorSwitch("main.py", 91 * 60_000 + 1_000);
    expect(drain(t5, 91 * 60_000 + 1_000 + RESUME_WINDOW + 1)).toHaveLength(0);
  });

  it("ends sessions on idle and includes the trailing gap in max gap", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abcd", 100_000);
    tracker.onEdit("main.py", 2, 2, 0, "abcd\ncd", 200_000);
    tracker.checkIdle(500_000); // 距最后编辑 300_000ms = 5min

    expect(drain(tracker, 500_000)).toHaveLength(0); // 挂起中
    const out = drain(tracker, 500_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("idle");
    expect(out[0].duration_ms).toBe(500_000);
    expect(out[0].typing.max_gap_ms).toBe(300_000); // 尾随空闲计入
  });

  it("does not end sessions below the idle threshold", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abc", 100_000);
    tracker.onEdit("main.py", 2, 2, 0, "abc\nde", 300_000);
    tracker.checkIdle(599_000); // 距最后编辑 299s < 5min
    expect(drain(tracker, 599_000 + RESUME_WINDOW + 1)).toHaveLength(0);
  });

  it("ends a session at max duration and starts a fresh one", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 2, 0, "ab", 0);
    tracker.onEdit("main.py", 1, 2, 0, "abc", 1_000);
    tracker.onEdit("main.py", 2, 2, 0, "abc\nde", 2_000);
    tracker.onEdit("main.py", 1, 2, 0, "ab", 91 * 60_000); // 超 90min → 拆分
    tracker.onEdit("main.py", 1, 2, 0, "abc", 91 * 60_000 + 500);
    tracker.onEdit("main.py", 3, 2, 0, "abc\nde\nfg", 91 * 60_000 + 1_000);
    tracker.onEditorSwitch("main.py", 91 * 60_000 + 2_000);

    // 切走时前半段因"让位"已落定入队,后半段仍挂起
    let out = drain(tracker, 91 * 60_000 + 2_000);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("max_duration");
    expect(out[0].duration_ms).toBe(91 * 60_000);
    expect(out[0].typing.changes).toBe(3);

    // 后半段窗口过期落定,从 91min 重新计时
    out = drain(tracker, 91 * 60_000 + 2_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("editor_switch");
    expect(out[0].typing.changes).toBe(3);
    expect(out[0].duration_ms).toBe(2_000);
  });

  it("resumes a same-file session within the 3min window (single buffer, original start)", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000); // a 结束 → 挂起,未发射
    tracker.onEdit("a.py", 1, 3, 0, "xy", 150_000); // 2.5min 内回来 → 续会话
    tracker.onEditorSwitch("a.py", 200_000);

    expect(drain(tracker, 200_000)).toHaveLength(0); // 挂起中
    const out = drain(tracker, 200_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1); // 续会话只发一条,不是两条
    expect(out[0].duration_ms).toBe(200_000); // 起止沿用原会话
    expect(out[0].typing.changes).toBe(4);    // 缓冲沿用
  });

  it("does not resume when another file's session intervened", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000);  // a 结束 → 挂起
    tracker.onEdit("b.py", 1, 5, 0, "y", 120_000);
    tracker.onEdit("b.py", 1, 5, 0, "yy", 125_000);
    tracker.onEdit("b.py", 1, 5, 0, "yyy", 129_000);
    tracker.onEditorSwitch("b.py", 130_000);  // b 结束 → a 让位落定,b 挂起
    tracker.onEdit("a.py", 1, 3, 0, "xy", 140_000); // a 回来 → 不续,全新会话
    tracker.onEditorSwitch("a.py", 150_000);  // a' 结束(1 次变更 → 丢弃)

    const out = drain(tracker, 150_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(2); // a 原始 payload + b;a' 因 <3 变更被丢弃
    expect(out[0].file).toBe("a.py");
    expect(out[0].duration_ms).toBe(100_000);
    expect(out[1].file).toBe("b.py");
    expect(out[1].duration_ms).toBe(10_000);
  });

  it("does not resume after the 3min window expires", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("a.py", 1, 5, 0, "x", 0);
    tracker.onEdit("a.py", 1, 5, 0, "xx", 10_000);
    tracker.onEdit("a.py", 1, 5, 0, "xxx", 20_000);
    tracker.onEditorSwitch("a.py", 100_000); // a 挂起
    tracker.onEdit("a.py", 1, 3, 0, "xy", 280_001); // 3min+1ms → 窗口已过
    tracker.onEdit("a.py", 1, 3, 0, "xyz", 280_002);
    tracker.onEdit("a.py", 1, 3, 0, "xyzw", 280_500);
    tracker.onEditorSwitch("a.py", 281_000);

    const out = drain(tracker, 281_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(2); // 原会话照常落定,新会话独立
    expect(out[0].duration_ms).toBe(100_000);
    expect(out[0].typing.changes).toBe(3);
    expect(out[1].duration_ms).toBe(999); // 281_000 - 280_001
    expect(out[1].typing.changes).toBe(3);
  });

  it("emits deactivate payloads on dispose without waiting for the resume window", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 5, 0, "xx", 1_000);
    tracker.onEdit("main.py", 1, 5, 0, "xxx", 2_000);
    tracker.dispose(3_000);
    const out = drain(tracker, 3_000);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("deactivate");
  });

  it("closes a session on file close", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onEdit("main.py", 1, 5, 0, "x", 0);
    tracker.onEdit("main.py", 1, 5, 0, "xx", 1_000);
    tracker.onEdit("main.py", 1, 5, 0, "xxx", 2_000);
    tracker.onFileClosed("main.py", 3_000);

    const out = drain(tracker, 3_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].ended_by).toBe("editor_close");
    expect(out[0].typing.changes).toBe(3);
  });

  it("marks truncated at the change cap and stops buffering further records", () => {
    const tracker = new BehaviorSessionTracker();
    for (let i = 0; i < 5_002; i++) {
      tracker.onEdit("main.py", 1, 1, 0, "a", i);
    }
    tracker.onEditorSwitch("main.py", 5_002);
    const out = drain(tracker, 5_002 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].truncated).toBe(true);
    expect(out[0].typing.changes).toBe(5_000);
  });

  it("attaches diagnostics only to open sessions and skips duplicate snapshots", () => {
    const tracker = new BehaviorSessionTracker();
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 0); // 无会话 → 忽略
    tracker.onEdit("main.py", 12, 10, 0, "for i in range(10)", 1_000);
    tracker.onEdit("main.py", 12, 0, 1, "for i in range(10)", 2_000);
    tracker.onEdit("main.py", 12, 4, 0, "for i in range(10)", 3_000);
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 4_000);
    tracker.onDiagnostics("main.py", ["expected ':' (main.py, line 12)"], 5_000); // 重复快照
    tracker.onEditorSwitch("main.py", 6_000);

    const out = drain(tracker, 6_000 + RESUME_WINDOW + 1);
    expect(out).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen).toHaveLength(1);
    expect(out[0].diagnostics.errors_seen[0].msg).toBe("expected ':'");
    expect(out[0].diagnostics.unresolved).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/test/events/behaviorListener.test.ts`
Expected: FAIL——`BehaviorSessionTracker` 不存在。

- [ ] **Step 3: 实现 tracker(文件含接线函数占位,Task 5 填充)**

创建 `src/events/behaviorListener.ts`:

```ts
// Typing-behavior session collection (behavior surface).
//
// BehaviorSessionTracker is a pure state machine: one open session per .py
// file, ended by editor switch / file close / idle ≥5min / duration ≥90min /
// dispose ("deactivate"). Time is always passed in by the caller — tests use
// synthetic timestamps, the wiring passes Date.now().
//
// Emission is deferred (park + materialize): an ended session waits in the
// single `closed` slot for the 3min resume window (spec §五 — a same-file
// re-activation within the window continues that session, reusing its
// buffer and start time). The payload is extracted only when the window
// expires (drain), when another session needs the slot (endSession), or on
// dispose — so a resumed stretch appears in the trace as ONE typing_session
// event, never as two overlapping ones. Sessions with <3 changes are
// dropped outright at endSession (spec §八) and are not resumable.
//
// createBehaviorListener wires vscode events onto the tracker (change /
// diagnostics / active editor / close / idle timer) and appends drained
// payloads to the L1 writer.

import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { EVENT_KINDS } from "../constants";
import {
  extractTypingSession,
  type TypingSessionPayload,
  type BehaviorChangeRecord,
  type BehaviorDiagSnapshot,
  type EndedBy,
} from "./behaviorFeatures";

const DEFAULTS = {
  idleMs: 5 * 60_000,
  maxSessionMs: 90 * 60_000,
  resumeWindowMs: 3 * 60_000,
  minChanges: 3,
  maxChanges: 5000,
} as const;

interface OpenSession {
  file: string;
  startMs: number;
  changes: BehaviorChangeRecord[];
  diagnostics: BehaviorDiagSnapshot[];
  lastMirror: string;
  lastActivityMs: number;
  truncated: boolean;
}

// A session that has ended but is held for the 3min resume window. Only the
// most recent closed session is resumable (spec §五: no other file's session
// may have intervened).
interface ClosedSession {
  file: string;
  endT: number;
  endedBy: EndedBy;
  session: OpenSession;
}

export class BehaviorSessionTracker {
  private idleMs: number;
  private maxSessionMs: number;
  private resumeWindowMs: number;
  private minChanges: number;
  private maxChanges: number;

  private open = new Map<string, OpenSession>();
  private closed: ClosedSession | null = null;
  private ended: TypingSessionPayload[] = [];

  constructor(deps: Partial<typeof DEFAULTS> = {}) {
    this.idleMs = deps.idleMs ?? DEFAULTS.idleMs;
    this.maxSessionMs = deps.maxSessionMs ?? DEFAULTS.maxSessionMs;
    this.resumeWindowMs = deps.resumeWindowMs ?? DEFAULTS.resumeWindowMs;
    this.minChanges = deps.minChanges ?? DEFAULTS.minChanges;
    this.maxChanges = deps.maxChanges ?? DEFAULTS.maxChanges;
  }

  onEdit(file: string, line: number, ins: number, del: number, mirrorText: string, t: number): void {
    let s = this.open.get(file);
    if (!s) {
      const c = this.closed;
      if (c && c.file === file && t - c.endT <= this.resumeWindowMs) {
        s = c.session; // 续会话:沿用原缓冲与起止时间(spec §五)
        this.closed = null;
        s.lastMirror = mirrorText;
        s.lastActivityMs = t;
        this.open.set(file, s);
      } else {
        s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false };
        this.open.set(file, s);
      }
    }

    // Max-duration boundary: flush and roll into a fresh session that
    // includes the current edit.
    if (t - s.startMs >= this.maxSessionMs) {
      this.endSession(s, "max_duration", t);
      s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false };
      this.open.set(file, s);
    }

    if (s.changes.length < this.maxChanges) {
      s.changes.push({ t, line, ins, del });
    } else {
      s.truncated = true; // 异常写入源(如格式化器全文件重写)防御
    }
    s.lastMirror = mirrorText;
    s.lastActivityMs = t;
  }

  /** Attach a diagnostic snapshot; only open sessions consume them. */
  onDiagnostics(file: string, errorMessages: string[], t: number): void {
    const s = this.open.get(file);
    if (!s) return;
    const prev = s.diagnostics[s.diagnostics.length - 1];
    if (prev && prev.errors.length === errorMessages.length &&
        prev.errors.every((m, i) => m === errorMessages[i])) {
      return; // consecutive identical snapshot — no new information
    }
    s.diagnostics.push({ t, errors: errorMessages });
  }

  onEditorSwitch(fromFile: string, t: number): void {
    const s = this.open.get(fromFile);
    if (!s) return;
    this.endSession(s, "editor_switch", t);
  }

  onFileClosed(file: string, t: number): void {
    const s = this.open.get(file);
    if (!s) return;
    this.endSession(s, "editor_close", t);
  }

  /** Idle sweep: end every session idle ≥ idleMs. */
  checkIdle(t: number): void {
    for (const s of [...this.open.values()]) {
      if (t - s.lastActivityMs >= this.idleMs) {
        this.endSession(s, "idle", t);
      }
    }
  }

  /** Extension shutdown: end every open session as "deactivate" and flush
 *  everything (open sessions AND any session parked for its resume window)
 *  so nothing is lost on shutdown. */
  dispose(t: number): void {
    for (const s of [...this.open.values()]) {
      this.endSession(s, "deactivate", t);
    }
    this.materializeClosed();
  }

  /**
   * Take all payloads whose resume window has expired as of `t`, plus any
   * emitted since the last drain. The wiring calls this with Date.now()
   * after every event batch, so a parked payload lands in the trace at the
   * first event/drain after its window expires.
   */
  drain(t: number): TypingSessionPayload[] {
    this.materializeExpired(t);
    return this.ended.splice(0);
  }

  // An ended session waits in `closed` for the resume window; the payload
  // is extracted (materialized) when the window expires, when another
  // session needs the slot, or at dispose. A resumed session never
  // materializes its pre-resume state — the merged session emits once.
  private materializeExpired(t: number): void {
    if (this.closed && t - this.closed.endT > this.resumeWindowMs) {
      this.materializeClosed();
    }
  }

  private materializeClosed(): void {
    const c = this.closed;
    if (!c) return;
    this.closed = null;
    this.ended.push(extractTypingSession({
      file: c.file,
      startMs: c.session.startMs,
      endMs: c.endT,
      endedBy: c.endedBy,
      truncated: c.session.truncated,
      changes: c.session.changes,
      diagnostics: c.session.diagnostics,
      finalText: c.session.lastMirror,
    }));
  }

  private endSession(s: OpenSession, endedBy: EndedBy, t: number): void {
    this.open.delete(s.file);
    this.materializeClosed(); // 单槽位让位:上一个挂起会话此时落定为最终 payload
    // 空会话(<3 次变更)不写事件也不可续(spec §八)。
    if (s.changes.length < this.minChanges) return;
    this.closed = { file: s.file, endT: t, endedBy, session: s };
  }
}

export function createBehaviorListener(writer: L1Writer): vscode.Disposable {
  // Implemented in Task 5.
  void vscode;
  void writer;
  throw new Error("not implemented yet");
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/test/events/behaviorListener.test.ts && npm test`
Expected: tracker 测试全过;`tsc --noEmit` 因 createBehaviorListener 占位通过编译(有 vscode 类型占位);全量测试绿。

- [ ] **Step 5: Commit**

```bash
git add src/events/behaviorListener.ts src/test/events/behaviorListener.test.ts
git commit -m "feat: add typing-session state machine with boundary and resume rules"
```

---

### Task 5: vscode 接线 + extension.ts 注册

**Files:**
- Modify: `src/events/behaviorListener.ts`(替换 createBehaviorListener 占位实现)
- Modify: `src/extension.ts:39-46`(import)与 `:145-151` 后(注册,diagnostics listener 之后)

**Interfaces:**
- Consumes: Task 4 的 `BehaviorSessionTracker` / `createBehaviorListener(writer)` 签名;Task 1 的 `EVENT_KINDS.typingSession`;Task 3 的 `BEHAVIOR_CONSTANTS.DIAG_MSG_MAX_CHARS`
- Produces: 扩展激活时 behavior 采集随其它监听器常开;dispose 时缓冲以 `deactivate` 落盘

- [ ] **Step 1: 实现接线**

`src/events/behaviorListener.ts` — 把 Task 4 的 `createBehaviorListener` 占位整体替换为:

```ts
export function createBehaviorListener(writer: L1Writer): vscode.Disposable {
  const tracker = new BehaviorSessionTracker();
  let activeFile: string | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const flushEnded = () => {
    for (const payload of tracker.drain(Date.now())) {
      void writer.append("behavior", EVENT_KINDS.typingSession, payload);
    }
  };

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      tracker.checkIdle(Date.now());
      flushEnded();
    }, DEFAULTS.idleMs);
  };

  const relativePathOf = (uri: vscode.Uri): string => {
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri);
    return workspaceRoot ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
  };

  const isTracked = (fileName: string, scheme: string): boolean =>
    scheme === "file" && fileName.endsWith(".py");

  const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
    if (!isTracked(e.document.fileName, e.document.uri.scheme)) return;
    if (e.contentChanges.length === 0) return;
    const t = Date.now();
    const file = relativePathOf(e.document.uri);
    for (const change of e.contentChanges) {
      tracker.onEdit(
        file,
        change.range.start.line + 1,
        change.text.length,
        change.rangeLength,
        e.document.getText(),
        t
      );
    }
    resetIdleTimer();
    flushEnded();
  });

  const diagSub = vscode.languages.onDidChangeDiagnostics((e) => {
    for (const uri of e.uris) {
      if (!isTracked(uri.fsPath, uri.scheme)) continue;
      const msgs = vscode.languages
        .getDiagnostics(uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error)
        .map((d) => d.message.slice(0, BEHAVIOR_CONSTANTS.DIAG_MSG_MAX_CHARS));
      tracker.onDiagnostics(relativePathOf(uri), msgs, Date.now());
      flushEnded();
    }
  });

  const editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
    const doc = editor?.document;
    const file =
      doc && isTracked(doc.fileName, doc.uri.scheme) ? relativePathOf(doc.uri) : null;
    if (activeFile && activeFile !== file) {
      tracker.onEditorSwitch(activeFile, Date.now());
      flushEnded();
    }
    activeFile = file;
  });

  const closeSub = vscode.workspace.onDidCloseTextDocument((doc) => {
    if (!isTracked(doc.fileName, doc.uri.scheme)) return;
    tracker.onFileClosed(relativePathOf(doc.uri), Date.now());
    flushEnded();
  });

  return {
    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      changeSub.dispose();
      diagSub.dispose();
      editorSub.dispose();
      closeSub.dispose();
      tracker.dispose(Date.now());
      flushEnded();
    },
  };
}
```

- [ ] **Step 2: extension.ts 注册**

`src/extension.ts` — import 区(`createDiagnosticsListener` 之后)加:

```ts
import { createBehaviorListener } from "./events/behaviorListener";
```

`activateCore` 中 diagnostics listener 的 try 块之后加:

```ts
  try {
    context.subscriptions.push(createBehaviorListener(l1Writer));
    console.log("[pylearner] behavior listener registered");
  } catch (err) {
    console.error("[pylearner] failed to register behavior listener:", err);
    throw err;
  }
```

- [ ] **Step 3: 验证编译、类型与全量测试**

Run: `npx tsc --noEmit && npm test && npm run compile`
Expected: 全部通过。context.subscriptions 的 dispose 在扩展停用时由 VS Code 自动调用 → 缓冲会话以 `deactivate` 落盘(spec §五),无需改动 `deactivate()`。

- [ ] **Step 4: Commit**

```bash
git add src/events/behaviorListener.ts src/extension.ts
git commit -m "feat: wire behavior listener into extension activation"
```

---

### Task 6: 端到端手动验收(spec §十一)

**Files:** 无代码改动。本任务产出验收记录;自动化部分只有编译与全量测试。

**Interfaces:**
- Consumes: Task 1-5 的完整链路;`scripts/eval-profile.ts`(注入回归)

- [ ] **Step 1: 自动化全绿确认**

Run: `npx tsc --noEmit && npm test && npm run compile`
Expected: 类型干净、全部测试通过、esbuild 构建成功。

- [ ] **Step 2: 卡壳场景采集(人工)**

F5 启动扩展开发主机,打开任一工作区的 `main.py`,模拟"for 循环卡壳":在含 `for i in range(10):` 的行反复删改(删几个字符再重打)、故意漏冒号让诊断报 `expected ':'`、中途发呆超过 5 秒数次、最后一次改完**停 5 分钟**(空闲边界)。然后任切一次编辑器。

检查(文件在扩展宿主的 globalStorage 下,可用 "Python Learner: Memory Graph" 或直接看目录):
- `trace/behavior/YYYY-MM-DD.jsonl` 出现 1 条 `typing_session` 事件,`hot_regions[0].touches` 明显高于其余行、`constructs` 含 `for`、`ended_by: "idle"`
- `diagnostics.errors_seen` 有规范化后的错误条目,`recurred`/`fixed`/`latency_ms` 符合操作

- [ ] **Step 3: 手滑场景采集(人工)**

同工作区快速打字 + 个别错字秒改(间隔 <1s),错误分散在不同行且全部修好,等空闲结束后确认事件:`gap_median_ms` 秒级、`hesitations_5s` 低、`unresolved: 0`。

- [ ] **Step 4: 管道归因验收(人工)**

执行命令 `Python Learner: Update Learner Profile`,检查:
- `l2/behavior.md` 出现三节(Typing fluency / Concept struggles / Edit habits),卡壳场景的 facts 落在"Concept struggles"或动态主题节、引用 `behavior:<ULID>` ref
- `l3/profile.md` 的知识级断言吸收行为证据并带 `knowledge_strength`
- Profile 面板老师总评的维度表反映行为证据带来的 🟢/🟡/🔴 变化;手滑场景**没有**被断言为 struggle(单会话犹豫不许下结论的硬规则生效)

- [ ] **Step 5: 注入回归(人工,可选)**

Run: `npx esbuild scripts/eval-profile.ts --bundle --platform=node --format=cjs --outfile=out/eval-profile.cjs && node out/eval-profile.cjs`
Expected: 脚本正常跑通,注入了 profile 的回答质量与之前一致(spec §十一 验收末条;需要 `--api-key`/`--model` 参数,无 LLM 配置时可跳过,不阻塞)。

- [ ] **Step 6: 记录验收结果并收尾**

```bash
git status   # 确认无遗漏文件;验收发现的问题回到对应任务修复
```

---

## Self-Review 记录(计划完成后已核对)

- **Spec 覆盖:** §四数据流→Task 3/4/5;§五会话/边界/续会话→Task 4(+idle 尾随间隔 Task 3 断言);§六 schema/constructs/规范化→Task 3;§七 SURFACE_FOCUS→Task 1(逐字);修订说明 1(不做 renderMasteryMap)→ 全计划无渲染改动,document.test.ts 回归由全量测试覆盖;§八边界表→Task 3/4 对应用例(空会话/truncated/≤4 字符/IME/非 .py 不跟踪=接线过滤);§九无设置→无 config 改动;§十落点表→各任务 Files 对齐(唯一补充:sectionLabels.ts 三个中文标签,与既有"所有 L2 节都有中文名"的模式一致);§十一测试 1/2→Task 3/4(测试 2 的 vscode mock 改为纯状态机断言,理由见 Task 4 设计说明),测试 3→全量回归含 document.test.ts;验收→Task 6。
- **占位符扫描:** 无 TBD/TODO;Task 5 前的 `createBehaviorListener` 占位是任务间显式交接(Task 4 Step 3 注明 Task 5 填充),非计划缺口。
- **类型一致性:** `TypingSessionPayload`/`BehaviorChangeRecord`/`EndedBy` 在 Task 3 定义、Task 4/5 引用,字段名逐一对齐;`drain(t)`/`onEdit(file, line, ins, del, mirrorText, t)` 签名在 Task 4 测试与 Task 5 接线中一致;`EVENT_KINDS.typingSession` 由 Task 1 定义、Task 5 使用。