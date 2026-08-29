# Learner Profile Pipeline Implementation Plan

> **Status: superseded by the actual implementation.** This plan describes the
> original mock-based structure (`src/consolidator/…`, `analyzeL2`/`generateL2`).
> The shipped pipeline lives in `src/memory/` (`update.ts` + `dedup.ts` +
> `merge.ts` + `lineDoc.ts`), with wiring in `src/commands/`. See
> [2026-08-29-remaining-work.md](./2026-08-29-remaining-work.md) for the current
> state and what's left.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the L1→L2→L3 learner profile pipeline with atomic ops, two-step thought chain, and profile injection.

**Architecture:** Pure functions-first approach with DeepTutor patterns, GBrain TypeScript idioms, and LLM Wiki two-step ingestion.

**Tech Stack:** TypeScript (VS Code Extension API), ULID, Markdown parsing (no LLM/runtime in Phase 1a), LlmRouter (P0), globalStorageUri persistence.

---

## Global Constraints

- Type safety: Strict TypeScript, no any types
- Memory safety: Atomic ops prevent partial updates, no manual GC needed
- Event ordering: Surface-level locking to prevent interleaving writes
- Privacy: No external APIs, local storage only
- Zero LLM dependencies in Phase 1a (pure functions only)
- Follow P0 existing patterns: L1Writer, TraceEvent, Surface enum
- Use ULID for all IDs (already in P0 for trace IDs)
- Markdown files in `globalStorageUri/l2/` and `globalStorageUri/l3/`

---

## Phase 1a: Pure Functions移植 (3-4 days)

### Task 1: 基础类型与 ID 工具

**Files:**
- Create: `src/memory/ids.ts`
- Test: `src/test/memory/ids.test.ts`

**Interfaces:**
- Consumes: ULID patterns from DeepTutor
- Produces: `is_entry_id()`, `is_trace_id()`, `new_entry_id()`, `new_trace_id()`, `is_valid_ref()`

- [ ] **Step 1: Write the failing test**

```typescript
import { new_entry_id, new_trace_id, is_entry_id, is_trace_id, is_valid_ref } from "../../memory/ids";

test("new_entry_id generates ULID format", () => {
  const id = new_entry_id();
  expect(is_entry_id(id)).toBe(true);
});

test("new_trace_id adds surface prefix", () => {
  const id = new_trace_id("edit");
  expect(id).toMatch(/^edit:/);
  expect(is_trace_id(id)).toBe(true);
});

test("is_valid_ref accepts all forms", () => {
  expect(is_valid_ref("edit:01HZK4AB")).toBe(true);
  expect(is_valid_ref("m_01HZK4AB")).toBe(true);
  expect(is_valid_ref("chat:session-abc")).toBe(true);
  expect(is_valid_ref("chat")).toBe(true); // L3 surface ref
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/ids.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/ids.ts
import { ulid } from "ulidx";

export const _ENTRY_RE = /^m_[0-9A-HJKMNP-TV-Z]{26}$/;
export const _TRACE_RE = /^[a-z][a-z0-9_-]*:[0-9A-HJKMNP-TV-Z]{26}$/;
export const _SNAPSHOT_RE = /^[a-z][a-z0-9_-]*:[A-Za-z0-9_.:\-]+$/;
export const _SHORTNAME_REFS = new Set(["edit", "run", "chat", "debug", "diag"]);

export function new_entry_id(): string {
  return `m_${ulid()}`;
}

export function new_trace_id(surface: string): string {
  return `${surface}:${ulid()}`;
}

export function is_entry_id(s: string): boolean {
  return _ENTRY_RE.test(s);
}

export function is_trace_id(s: string): boolean {
  return _TRACE_RE.test(s);
}

export function is_snapshot_ref(s: string): boolean {
  return _SNAPSHOT_RE.test(s);
}

export function is_shortname_ref(s: string): boolean {
  return _SHORTNAME_REFS.has(s);
}

export function is_valid_ref(s: string): boolean {
  return is_entry_id(s) || is_trace_id(s) || is_snapshot_ref(s) || is_shortname_ref(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/ids.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/ids.ts src/test/memory/ids.test.ts
git commit -m "feat: add ID utilities with ULID validation"
```

### Task 2: 文档模型与序列化

**Files:**
- Create: `src/memory/document.ts`
- Create: `src/test/memory/document.test.ts`

**Interfaces:**
- Consumes: Entry/Document interfaces from DeepTutor
- Produces: `parse()`, `serialize()`, `renderWithMarkers()` functions

- [ ] **Step 1: Write the failing test**

```typescript
import { parse, serialize, renderWithMarkers, type Document, type Entry } from "../../memory/document";

test("parse and serialize round-trip", () => {
  const md = `# Test Document

## Code Patterns
- Uses list comprehensions frequently [^1] <!--m_01HZK4AB-->
- Prefers f-strings over .format() [^1] <!--m_01HZK5CD>

---

[^1]: edit:01HZK4AB
[^1]: edit:01HZK5CD`;
  
  const doc = parse(md);
  const serialized = serialize(doc);
  expect(serialized).toContain("Uses list comprehensions frequently [^1]");
});

test("renderWithMarkers adds ULID anchors", () => {
  const doc = parse(`# Test\n## Patterns\n- Pattern [^1] <!--m_xyz-->`);
  const rendered = renderWithMarkers(doc);
  expect(rendered).toContain("<!--m_xyz-->");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/document.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/document.ts
import { is_valid_ref, new_entry_id } from "./ids";

interface Entry {
  id: string;
  section: string;
  text: string;
  refs: string[];
}

interface Document {
  title: string;
  sections: [string, Entry[]][];
}

function parse(md: string): Document {
  const lines = md.split("\n");
  const doc: Document = { title: "", sections: [] };
  
  // 简化版解析（P1+ 可扩展复杂格式）
  let currentSection: string | null = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    if (!doc.title && trimmed.startsWith("# ")) {
      doc.title = trimmed.substring(2).trim();
      continue;
    }
    
    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.substring(3).trim();
      doc.sections.push([currentSection, []]);
      continue;
    }
    
    if (trimmed.startsWith("- ") && currentSection) {
      const match = trimmed.match(/^-\s*(.+?)\s*<!--\s*(m_[^\s]+)\s*-->/);
      if (match) {
        const [_, text, id] = match;
        const entry: Entry = {
          id,
          section: currentSection,
          text,
          refs: [] // P1+ 可扩展 refs 解析
        };
        doc.sections[doc.sections.length - 1][1].push(entry);
      }
    }
  }
  
  return doc;
}

function serialize(doc: Document): string {
  const lines: string[] = [];
  
  if (doc.title) {
    lines.push(`# ${doc.title}`);
    lines.push("");
  }
  
  for (const [section, entries] of doc.sections) {
    if (!entries.length) continue;
    
    lines.push(`## ${section}`);
    lines.push("");
    
    for (const entry of entries) {
      markers = entry.refs.length > 0 
        ? " " + entry.refs.map((_, i) => `^[${i + 1}]`).join("") 
        : "";
      lines.push(`- ${entry.text}${markers} <!--${entry.id}-->`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

function renderWithMarkers(doc: Document): string {
  return serialize(doc); // P1+ 可扩展为更复杂渲染
}

export { parse, serialize, renderWithMarkers, type Document, type Entry };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/document.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/document.ts src/test/memory/document.test.ts
git commit -m "feat: add Markdown document model with parse/serialize"
```

### Task 3: 原子操作与验证

**Files:**
- Create: `src/memory/ops.ts`
- Create: `src/test/memory/ops.test.ts`

**Interfaces:**
- Consumes: Document, Entry types from document.ts
- Produces: `AddOp | EditOp | DeleteOp`, `validate()`, `apply()` functions

- [ ] **Step 1: Write the failing test**

```typescript
import { validate, apply, type Op, type ApplyReport } from "../../memory/ops";
import { parse, type Document } from "../../memory/document";

test("validate accepts valid add op", () => {
  const doc = parse("# Test\n## Patterns\n- Old pattern [^1] <!--m_old-->");
  const op: Op = {
    op: "add",
    section: "New Patterns",
    text: "Uses lambda functions",
    refs: ["edit:01HZK6EF"]
  };
  
  expect(() => validate(doc, [op])).not.toThrow();
});

test("validate rejects conflicting ops", () => {
  const doc = parse("# Test\n## Patterns\n- Pattern [^1] <!--m_old-->");
  const ops: Op[] = [
    { op: "edit", target_id: "m_old", new_text: "New text", new_refs: ["edit:01"] },
    { op: "delete", target_id: "m_old", reason: "superseded" }
  ];
  
  expect(() => validate(doc, ops)).toThrow("batch conflict");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/ops.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/ops.ts
import { is_entry_id, is_valid_ref } from "./ids";
import { type Document, type Entry } from "./document";

export type Op = AddOp | EditOp | DeleteOp;

export interface AddOp {
  op: "add";
  section: string;
  text: string;
  refs: string[];
}

export interface EditOp {
  op: "edit";
  target_id: string;
  new_text: string;
  new_refs: string[];
}

export interface DeleteOp {
  op: "delete";
  target_id: string;
  reason: "contradicted" | "superseded" | "stale" | "low-signal";
}

export interface OpResult {
  op: Op;
  status: "applied";
  entry_id?: string;
  detail: string;
}

export interface ApplyReport {
  accepted: boolean;
  results: OpResult[];
  reason: string;
}

class OpValidationError extends Error {}

function validate(doc: Document, ops: Op[]): void {
  const edits = new Set<string>();
  const deletes = new Set<string>();
  
  for (const op of ops) {
    if (op.op === "add") {
      if (!op.text || op.text.length > 240) {
        throw new OpValidationError("add: text length 1..240");
      }
      if (!op.section || op.section.length > 80) {
        throw new OpValidationError("add: invalid section");
      }
      if (!op.refs.some(ref => is_valid_ref(ref))) {
        throw new OpValidationError("add: invalid refs");
      }
    } else if (op.op === "edit") {
      if (!is_entry_id(op.target_id)) throw new OpValidationError("edit: bad id");
      if (!doc.sections.some(([_, entries]) => 
        entries.some(e => e.id === op.target_id))) {
        throw new OpValidationError("edit: id not found");
      }
      if (deletes.has(op.target_id)) throw new OpValidationError("conflict");
      edits.add(op.target_id);
    } else if (op.op === "delete") {
      if (!is_entry_id(op.target_id)) throw new OpValidationError("delete: bad id");
      if (!doc.sections.some(([_, entries]) => 
        entries.some(e => e.id === op.target_id))) {
        throw new OpValidationError("delete: id not found");
      }
      if (edits.has(op.target_id)) throw new OpValidationError("conflict");
      deletes.add(op.target_id);
    }
  }
}

function apply(doc: Document, ops: Op[]): ApplyReport {
  try {
    validate(doc, ops);
  } catch (err) {
    if (err instanceof OpValidationError) {
      return { accepted: false, results: [], reason: err.message };
    }
    throw err;
  }
  
  const results: OpResult[] = [];
  
  for (const op of ops) {
    if (op.op === "add") {
      const entry: Entry = {
        id: `m_${Date.now().toString(36)}`, // 简化版，P1+ 用 ULID
        section: op.section,
        text: op.text,
        refs: op.refs
      };
      
      const sectionIndex = doc.sections.findIndex(([name]) => name === op.section);
      if (sectionIndex === -1) {
        doc.sections.push([op.section, [entry]]);
      } else {
        doc.sections[sectionIndex][1].push(entry);
    }
      
      results.push({ op, status: "applied", entry_id: entry.id });
    } else if (op.op === "edit") {
      const entry = doc.sections
        .flatMap(([_, entries]) => entries)
        .find(e => e.id === op.target_id);
      
      if (entry) {
        entry.text = op.new_text;
        entry.refs = op.new_refs;
      }
      
      results.push({ op, status: "applied" });
    } else if (op.op === "delete") {
      for (const [_, entries] of doc.sections) {
        const index = entries.findIndex(e => e.id === op.target_id);
        if (index !== -1) {
          entries.splice(index, 1);
          break;
        }
      }
      
      results.push({ op, status: "applied", detail: op.reason });
    }
  }
  
  return { accepted: true, results };
}

export { validate, apply };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/ops.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/ops.ts src/test/memory/ops.test.ts
git commit -m "feat: add atomic operations with batch validation"
```

### Task 4: 分块工具与边界对齐

**Files:**
- Create: `src/memory/chunker.ts`
- Create: `src/test/memory/chunker.test.ts`

**Interfaces:**
- Consumes: ULID generation, string boundaries
- Produces: `chunk_with_boundary()` function with CJK support

- [ ] **Step 1: Write the failing test**

```typescript
import { chunk_with_boundary, type ChunkResult } from "../../memory/chunker";

test("chunks at paragraph boundaries", () => {
  const text = "Paragraph 1.\n\nParagraph 2.";
  const chunks = chunk_with_boundary(text, 100);
  
  expect(chunks.length).toBe(2);
  expect(chunks[0].text).toBe("Paragraph 1.");
  expect(chunks[0].boundary).toBe("\n\n");
});

test("respects CJK sentence boundaries", () => {
  const text = "中文句子。另一个句子。";
  const chunks = chunk_with_boundary(text, 20);
  
  expect(chunks[0].text).toBe("中文句子。");
  expect(chunks[0].boundary).toBe("。");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/chunker.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/chunker.ts
export interface ChunkResult {
  text: string;
  boundary: string;
  isLast: boolean;
}

export function chunk_with_boundary(text: string, maxLen: number): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  let pos = 0;
  
  while (pos < text.length) {
    const end = Math.min(pos + maxLen, text.length);
    let boundary = "";
    
    // 优先查找段落边界
    if (end < text.length) {
      const paraBoundary = text.indexOf('\n\n', end);
      if (paraBoundary !== -1 && paraBoundary - pos <= maxLen * 1.5) {
        chunks.push({
          text: text.slice(pos, paraBoundary),
          boundary: '\n\n',
          isLast: false
        });
        pos = paraBoundary + 2;
        continue;
      }
    }
    
    // 其次查找句子边界
    const boundaries = ['。', '！', '？', '.', '!', '?'];
    let bestBoundaryPos = -1;
    let bestBoundary = '';
    
    for (const boundary of boundaries) {
      const pos = text.indexOf(boundary, end - 50);
      if (pos !== -1 && pos < end + 50) {
        bestBoundaryPos = pos + 1; // 包含标点
        bestBoundary = boundary;
        break;
      }
    }
    
    if (bestBoundaryPos !== -1) {
      chunks.push({
        text: text.slice(pos, bestBoundaryPos),
        boundary: bestBoundary,
        isLast: false
      });
      pos = bestBoundaryPos;
    } else {
      // 无边界，强制分割
      chunks.push({
        text: text.slice(pos, end),
        boundary: '',
        isLast: true
      });
      pos = end;
    }
  }
  
  if (chunks.length > 0) {
    chunks[chunks.length - 1].isLast = true;
  }
  
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/chunker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/chunker.ts src/test/memory/chunker.test.ts
git commit -m "feat: add chunker with paragraph and CJK sentence boundaries"
```

### Task 5: 防御层 - Banned Phrase 过滤

**Files:**
- Create: `src/memory/guards.ts`
- Create: `src/test/memory/guards.test.ts`

**Interfaces:**
- Consumes: LLM outputs
- Produces: `banned_phrases` array, `filter_banned()` function

- [ ] **Step 1: Write the failing test**

```typescript
import { banned_phrases, filter_banned } from "../../memory/guards";

test("filter_banned catches banned phrases", () => {
  const input = "You have fully mastered async/await concepts.";
  const filtered = filter_banned(input);
  
  expect(filtered).not.toContain("fully mastered");
});

test("filter_banned preserves valid content", () => {
  const input = "You understand async/await basics.";
  const filtered = filter_banned(input);
  
  expect(filtered).toBe(input);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/guards.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/guards.ts
export const banned_phrases = [
  "你已经完全掌握",
  "你不需要再学习", 
  "你是专家",
  "永远不会再犯",
  "100% 掌握",
  "perfect understanding",
  "fully mastered",
  "no need to study"
];

export function filter_banned(text: string): string {
  let filtered = text;
  
  for (const phrase of banned_phrases) {
    // 精确匹配，避免误伤
    const regex = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    filtered = filtered.replace(regex, "***REDACTED***");
  }
  
  return filtered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/guards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/guards.ts src/test/memory/guards.test.ts
git commit -m "feat: add banned phrase filtering for safety"
```

### Task 6: Meta Sidecar 和增量检测

**Files:**
- Create: `src/memory/meta.ts`
- Create: `src/test/memory/meta.test.ts`

**Interfaces:**
- Consumes: Entity snapshots, seen-ID lists
- Produces: `load_meta()`, `save_meta()`, `compute_diff()` functions

- [ ] **Step 1: Write the failing test**

```typescript
import { load_meta, save_meta, compute_diff } from "../../memory/meta";

test("compute_diff detects new entity refs", () => {
  const current = { entityRefs: ["edit:01", "edit:02"] };
  const seen = ["edit:01"];
  
  const diff = compute_diff(current, seen);
  
  expect(diff.added).toEqual(["edit:02"]);
  expect(diff.modified).toEqual([]);
  expect(diff.removed).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/meta.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/meta.ts
export interface SurfaceMeta {
  seen_entity_refs: string[];
  last_updated: string;
}

export interface ProfileMeta {
  seen_l2_entry_ids: string[];
  last_updated: string;
}

function load_meta(surface: string): SurfaceMeta {
  // P1b 接入 globalStorageUri，现在返回 mock
  return {
    seen_entity_refs: [],
    last_updated: new Date().toISOString()
  };
}

function save_meta(surface: string, meta: SurfaceMeta): void {
  // P1b 接入 globalStorageUri，现在 mock
  console.log(`Saving meta for ${surface}`, meta);
}

function compute_diff(current: any, seen: string[]): { added: string[], modified: string[], removed: string[] } {
  const currentSet = new Set(current.entityRefs);
  const seenSet = new Set(seen);
  
  const added = Array.from(currentSet).filter(id => !seenSet.has(id));
  const removed = Array.from(seenSet).filter(id => !currentSet.has(id));
  const modified = Array.from(currentSet).filter(id => seenSet.has(id));
  
  return { added, modified, removed };
}

export { load_meta, save_meta, compute_diff };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/meta.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/meta.ts src/test/memory/meta.test.ts
git commit -m "feat: add meta sidecar with incremental diff"
```

## Phase 1b: I/O 适配 + 参考池 (2-3 days)

### Task 7: 路径管理工具

**Files:**
- Create: `src/memory/paths.ts`

**Interfaces:**
- Consumes: VS Code Context.globalStorageUri
- Produces: path builders for l2/ and l3/ directories

- [ ] **Step 1: Write the failing test**

```typescript
import { getL2Path, getL3Path, getMetaPath } from "../../memory/paths";

test("getL2Path builds correct path", () => {
  const baseUri = mockUri("workspace");
  const path = getL2Path(baseUri, "edit");
  
  expect(path.path).toContain("edit.md");
});

// 简化的 mock
function mockUri(path: string): any {
  return { path, joinPath: (uri: string, name: string) => mockUri(`${uri}/${name}`) };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/paths.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/paths.ts
import * as vscode from "vscode";

export function getL2Path(storageUri: vscode.Uri, surface: string): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l2", `${surface}.md`);
}

export function getMetaPath(storageUri: vscode.Uri, surface: string): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l2", `${surface}.meta.json`);
}

export function getProfilePath(storageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l3", "profile.md");
}

export function getProfileMetaPath(storageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storageUri, "l3", "profile.meta.json`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/paths.ts src/test/paths.test.ts
git commit -m "feat: add path builders for l2/l3 storage"
```

### Task 8: L1 适配器与实体快照

**Files:**
- Create: `src/snapshot/adapter.ts`
- Create: `src/test/snapshot/adapter.test.ts`

**Interfaces:**
- Consumes: L1 JSONL files from P0
- Produces: EntitySnapshot objects

- [ ] **Step 1: Write the failing test**

```typescript
import { build_entity_snapshot } from "../../snapshot/adapter";
import type { Surface } from "../../constants";

test("build_entity_snapshot aggregates surface events", () => {
  const events = [
    { id: "edit:01", kind: "file_save", payload: { path: "test.py" } },
    { id: "edit:02", kind: "file_save", payload: { path: "main.py" } }
  ];
  
  const snapshot = build_entity_snapshot(events, "edit");
  
  expect(snapshot.entityRefs).toEqual(["edit:01", "edit:02"]);
  expect(snapshot.traceCount).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/snapshot/adapter.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/snapshot/adapter.ts
import type { Surface } from "../constants";
import type { TraceEvent } from "../events/types";

export interface EntitySnapshot {
  surface: Surface;
  entityRefs: string[];
  traceCount: number;
  errorCount?: number;
  editLineCount?: number;
  chatTurnCount?: number;
  debugStepCount?: number;
}

export function build_entity_snapshot(events: TraceEvent[], surface: Surface): EntitySnapshot {
  const entityRefs = events.map(e => e.id);
  
  // P1+ 可扩展 surface 特定字段
  const snapshot: EntitySnapshot = {
    surface,
    entityRefs,
    traceCount: events.length
  };
  
  // 根据事件类型填充字段
  for (const event of events) {
    switch (event.kind) {
      case "execution_error":
        snapshot.errorCount = (snapshot.errorCount || 0) + 1;
        break;
      // P1+ 添加更多事件类型处理
    }
  }
  
  return snapshot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/snapshot/adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/adapter.ts src/test/snapshot/adapter.test.ts
git commit -m "feat: add L1 adapter for building entity snapshots"
```

### Task 9: 参考池计算

**Files:**
- Create: `src/memory/references.ts`
- Create: `src/test/memory/references.test.ts`

**Interfaces:**
- Consumes: Document objects and trace IDs
- Produces: ReferencePool with valid refs

- [ ] **Step 1: Write the failing test**

```typescript
import { buildReferencePool } from "../../memory/references";
import { parse } from "../../memory/document";

test("buildReferencePool includes all valid refs", () => {
  const doc = parse("# Test\n## Patterns\n- Pattern [^1] <!--m_xyz-->");
  const traceIds = ["edit:01", "edit:02"];
  
  const pool = buildReferencePool(doc, traceIds);
  
  expect(pool.entryIds.has("m_xyz")).toBe(true);
  expect(pool.traceIds.has("edit:01")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/memory/references.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/references.ts
import { is_valid_ref } from "./ids";
import { type Document, type Footnote } from "./document";

export interface ReferencePool {
  entryIds: Set<string>;
  footnoteIds: Set<string>;
  traceIds: Set<string>;
}

export function buildReferencePool(l2Doc: Document, l1TraceIds: string[]): ReferencePool {
  const entryIds = new Set<string>();
  const footnoteIds = new Set<string>();
  const traceIds = new Set(l1TraceIds);
  
  // 收集所有 entry IDs
  for (const [_, entries] of l2Doc.sections) {
    for (const entry of entries) {
      entryIds.add(entry.id);
    }
  }
  
  // P1+ 可扩展 footnote 解析
  // 简化版：无额外 footnote IDs
  
  return { entryIds, footnoteIds, traceIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/memory/references.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/references.ts src/test/memory/references.test.ts
git commit -m "feat: add reference pool for validation"
```

## Phase 1c: LLM 集成 + 两步思维链 (4-5 days)

### Task 10: L2 分析 Prompt

**Files:**
- Create: `src/consolidator/prompts/analyzeL2.ts`

**Interfaces:**
- Consumes: 学习事件 chunk，已有 L2 文档
- Produces: LLM prompt for analysis

- [ ] **Step 1: Write the failing test**

```typescript
import { buildAnalyzePrompt } from "../../consolidator/prompts/analyzeL2";

test("buildAnalyzePrompt includes chunk and existing content", () => {
  const chunk = "Student saved test.py with list comprehension";
  const existingDoc = "# Edit Activities\n## Patterns\n- Old pattern";
  
  const prompt = buildAnalyzePrompt(chunk, existingDoc);
  
  expect(prompt).toContain("list comprehension");
  expect(prompt).toContain("Edit Activities");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/prompts/analyzeL2.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/consolidator/prompts/analyzeL2.ts
export interface AnalysisResult {
  signals: string[];
  relations: string[];
}

export function buildAnalyzePrompt(chunk: string, existingDoc: string): string {
  return `你是 Python 学习分析专家。分析以下学习事件，识别关键学习信号。

**新事件:**
${chunk}

**已有知识:**
${existingDoc}

请输出 JSON 格式的分析结果：
{
  "signals": ["信号1", "信号2"],
  "relations": ["与已有知识的关系描述"]
}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/prompts/analyzeL2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidator/prompts/analyzeL2.ts src/test/prompts/analyzeL2.test.ts
git commit -m "feat: add L2 analysis prompt builder"
```

### Task 11: L2 生成 Prompt

**Files:**
- Create: `src/consolidator/prompts/generateL2.ts`

**Interfaces:**
- Consumes: 分析结果，新事件，参考池
- Produces: LLM prompt for ops generation

- [ ] **Step 1: Write the failing test**

```typescript
import { buildGeneratePrompt } from "../../consolidator/prompts/generateL2";

test("buildGeneratePrompt creates valid ops prompt", () => {
  const analysis = { signals: ["prefers list comprehensions"], relations: [] };
  const chunk = "Used list comprehension in test.py";
  const existingDoc = "# Edit Activities\n## Patterns";
  const pool = { entryIds: new Set(), traceIds: new Set(["edit:01"]) };
  
  const prompt = buildGeneratePrompt(analysis, chunk, existingDoc, pool);
  
  expect(prompt).toContain("AddOp | EditOp | DeleteOp");
  expect(prompt).toContain("edit:01");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/prompts/generateL2.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/consolidator/prompts/generateL2.ts
import type { ReferencePool } from "../../memory/references";

export interface GenerateResult {
  ops: Array<{
    op: "add" | "edit" | "delete";
    section?: string;
    text?: string;
    new_text?: string;
    refs: string[];
  }>;
}

export function buildGeneratePrompt(
  analysis: any,
  chunk: string,
  existingDoc: string,
  pool: ReferencePool
): string {
  const validRefs = Array.from(pool.traceIds).join(", ");
  
  return `你是学习画像构建专家。根据分析结果生成事实条目。

**分析结果:**
${JSON.stringify(analysis, null, 2)}

**新事件:**
${chunk}

**已有知识:**
${existingDoc}

**可用的有效引用:**
${validRefs}

请输出 JSON 格式的操作：
{
  "ops": [
    {
      "op": "add",
      "section": "Patterns",
      "text": "自然语言描述",
      "refs": ["valid:ref1"]
    }
  ]
}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/prompts/generateL2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidator/prompts/generateL2.ts src/test/prompts/generateL2.test.ts
git commit -m "feat: add L2 generation prompt builder"
```

### Task 12: L2 更新流程

**Files:**
- Create: `src/consolidator/updateL2.ts`

**Interfaces:**
- Consumes: EntitySnapshot, meta, LlmRouter
- Produces: 更新后的 L2 文档

- [ ] **Step 1: Write the failing test**

```typescript
import { updateL2Document } from "../../consolidator/updateL2";

test("updateL2Document processes new events", async () => {
  const snapshot = { surface: "edit", entityRefs: ["edit:01"], traceCount: 1 };
  const meta = { seen_entity_refs: [] };
  const newEvents = ["edit:01"];
  
  const result = await updateL2Document(snapshot, meta, newEvents);
  
  expect(result.title).toBe("Edit Activities");
  expect(result.sections.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/consolidator/updateL2.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/consolidator/updateL2.ts
import { chunk_with_boundary } from "../memory/chunker";
import { parse, serialize } from "../memory/document";
import { buildReferencePool } from "../memory/references";
import { buildAnalyzePrompt } from "./prompts/analyzeL2";
import { buildGeneratePrompt } from "./prompts/generateL2";

export interface UpdateL2Result {
  success: boolean;
  document?: any;
  error?: string;
}

export async function updateL2Document(
  snapshot: any,
  meta: any,
  newEvents: string[]
): Promise<UpdateL2Result> {
  try {
    // P1+ 实现完整逻辑，现在返回 mock
    return {
      success: true,
      document: {
        title: "Edit Activities",
        sections: [["Patterns", []]]
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/consolidator/updateL2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidator/updateL2.ts src/test/consolidator/updateL2.test.ts
git commit -m "feat: add L2 update workflow (mock for P1c)"
```

### Task 13: L3 分析与重写 Prompt

**Files:**
- Create: `src/consolidator/prompts/analyzeL3.ts`
- Create: `src/consolidator/prompts/rewriteL3.ts`

**Interfaces:**
- Consumes: 各面新增条目，当前 profile
- Produces: L3 重写 prompt

- [ ] **Step 1: Write the failing test for analyzeL3**

```typescript
import { buildAnalyzePrompt } from "../../consolidator/prompts/analyzeL3";

test("buildAnalyzePrompt includes cross-surface data", () => {
  const newEntries = {
    edit: ["Prefers list comprehensions"],
    chat: ["Confused about decorators"]
  };
  const currentProfile = "# Python Learner Profile";
  
  const prompt = buildAnalyzePrompt(newEntries, currentProfile);
  
  expect(prompt).toContain("cross-surface");
  expect(prompt).toContain("decorators");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/prompts/analyzeL3.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/consolidator/prompts/analyzeL3.ts
export function buildAnalyzePrompt(newEntries: any, currentProfile: string): string {
  return `你是学习者画像分析专家。分析跨面学习信号的变化。

**新增条目:**
${JSON.stringify(newEntries, null, 2)}

**当前画像:**
${currentProfile}

请分析关键变化和重点关注领域。`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/prompts/analyzeL3.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidator/prompts/analyzeL3.ts src/test/prompts/analyzeL3.test.ts
git commit -m "feat: add L3 analysis prompt"
```

### Task 14: L3 重写流程

**Files:**
- Create: `src/consolidator/updateL3.ts`

**Interfaces:**
- Consumes: 各面更新，当前 profile
- Produces: 新的 profile.md

- [ ] **Step 1: Write the failing test**

```typescript
import { updateL3Profile } from "../../consolidator/updateL3";

test("updateL3Profile produces new profile", async () => {
  const updates = { edit: ["New pattern"], chat: ["New confusion"] };
  const currentProfile = "# Python Learner Profile\n\n## Strengths";
  
  const result = await updateL3Profile(updates, currentProfile);
  
  expect(result).toContain("Python Learner Profile");
  expect(result).toContain("## Areas for Improvement");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/consolidator/updateL3.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/consolidator/updateL3.ts
export interface UpdateL3Result {
  success: boolean;
  newProfile?: string;
  error?: string;
}

export async function updateL3Profile(
  updates: any,
  currentProfile: string
): Promise<UpdateL3Result> {
  try {
    // P1+ 实现完整 REWRITE 逻辑，现在 mock
    const newProfile = `---
type: profile
title: Python Learner Profile
created: 2026-08-28
updated: ${new Date().toISOString()}
---

# Python Learner Profile

## Areas for Improvement
${Object.entries(updates).flatMap(([surface, entries]: [string, string[]]) => 
  entries.map(entry => `- ${entry}`)
).join("\n")}`;
    
    return { success: true, newProfile };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/consolidator/updateL3.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/consolidator/updateL3.ts src/test/consolidator/updateL3.test.ts
git commit -m "feat: add L3 rewrite workflow (mock for P1c)"
```

## Phase 1d: UI + 画像注入 (2-3 days)

### Task 15: 画像注入工具

**Files:**
- Create: `src/memory/profileInjector.ts`

**Interfaces:**
- Consumes: profile.md, context budget
- Produces: system prompt with learner profile

- [ ] **Step 1: Write the failing test**

```typescript
import { buildSystemPromptWithProfile } from "../../memory/profileInjector";

test("buildSystemPromptWithProfile includes learner data", () => {
  const profile = `---
type: profile
title: Python Learner Profile
---

# Python Learner Profile

## Learning Style
- Prefers examples
- Struggles with async
`;
  
  const basePrompt = "You are a Python tutor";
  const budget = { maxCtx: 4000, profileBudget: 800 };
  
  const result = buildSystemPromptWithProfile(basePrompt, profile, budget);
  
  expect(result).toContain("Learner Profile");
  expect(result).toContain("Prefers examples");
  expect(result.length).toBeLessThan(basePrompt.length + budget.profileBudget);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/profileInjector.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/memory/profileInjector.ts
export interface ContextBudget {
  maxCtx: number;
  profileRatio: number;
  readonly profileBudget: number;
}

export function buildSystemPromptWithProfile(
  baseSystemPrompt: string,
  profileMd: string,
  budget: ContextBudget
): string {
  const profileSection = profileMd.split('\n---\n')[0];
  const truncated = profileSection.slice(0, budget.profileBudget);
  
  return `${baseSystemPrompt}

## Learner Profile
The following is the learner's profile. Use it to personalize your responses:
- Focus explanations on their areas for improvement
- Reference their strengths to build confidence
- Match their preferred learning style
- Skip topics they've already mastered

${truncated}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/profileInjector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/profileInjector.ts src/test/profileInjector.test.ts
git commit -m "feat: add profile injection into system prompt"
```

### Task 16: "更新画像"命令

**Files:**
- Create: `src/commands/updateProfile.ts`
- Modify: `src/constants.ts` (添加 CMD_IDS.updateProfile)

**Interfaces:**
- Consumes: VS Code extension context
- Produces: Command that triggers L1→L2→L3 pipeline

- [ ] **Step 1: Write the failing test**

```typescript
import { registerUpdateProfileCommand } from "../../commands/updateProfile";
import * as vscode from "vscode";

test("registerUpdateProfileCommand registers command", () => {
  const mockContext = { subscriptions: [] };
  registerUpdateProfileCommand(mockContext as any);
  
  expect(mockContext.subscriptions.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/commands/updateProfile.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/constants.ts
export const CMD_IDS = {
  // ... existing
  updateProfile: "pylearner.updateProfile"
} as const;

// src/commands/updateProfile.ts
import * as vscode from "vscode";
import { CMD_IDS } from "../constants";

export function registerUpdateProfileCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.updateProfile, async () => {
      vscode.window.showInformationMessage("开始更新学习者画像...");
      
      // P1+ 实现 L1→L2→L3 调用
      console.log("Update profile pipeline triggered");
    })
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/commands/updateProfile.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/constants.ts src/commands/updateProfile.ts src/test/commands/updateProfile.test.ts
git commit -m "feat: add update profile command"
```

### Task 17: 画像预览面板

**Files:**
- Create: `webview-ui/src/components/ProfilePanel.tsx`
- Modify: `src/extension.ts` 注册新视图

**Interfaces:**
- Consumes: profile.md content
- Produces: Webview display of learner profile

- [ ] **Step 1: Write the failing test for React component**

```typescript
import { renderProfilePanel } from "../../webview-ui/src/components/ProfilePanel";

test("ProfilePanel renders sections correctly", () => {
  const profile = {
    title: "Python Learner Profile",
    strengths: ["Basic syntax"],
    weaknesses: ["Async concepts"]
  };
  
  const result = renderProfilePanel(profile);
  
  expect(result).toContain("Python Learner Profile");
  expect(result).toContain("Strengths");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/test/webview/ProfilePanel.test.ts`
Expected: "Module not found"

- [ ] **Step 3: Write minimal implementation**

```tsx
// webview-ui/src/components/ProfilePanel.tsx
import * as React from "react";

interface Profile {
  title: string;
  strengths: string[];
  weaknesses: string[];
}

interface ProfilePanelProps {
  profile: Profile | null;
}

export function ProfilePanel({ profile }: ProfilePanelProps) {
  if (!profile) {
    return <div>暂无学习者画像</div>;
  }

  return (
    <div className="profile-panel">
      <h2>{profile.title}</h2>
      
      <section>
        <h3>Strengths</h3>
        <ul>
          {profile.strengths.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </section>
      
      <section>
        <h3>Areas for Improvement</h3>
        <ul>
          {profile.weaknesses.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/test/webview/ProfilePanel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/components/ProfilePanel.tsx src/test/webview/ProfilePanel.test.ts
git commit -m "feat: add profile preview webview component"
```

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-28-learner-profile-pipeline.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**