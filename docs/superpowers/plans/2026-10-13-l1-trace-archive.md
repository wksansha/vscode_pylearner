# L1 Trace 全量归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学生端 L1 全量事件按学号分目录本地存储，并通过独立归档通道增量同步到 classroom-assistant 服务器（纯文件归档，不入库）。

**Architecture:** 客户端 L1Writer 写路径加学号目录层（`trace/<studentId>/<surface>/<date>.jsonl`，未设身份落 `unknown/`）；新增 `src/archive/` 激活时读本地 JSONL + 字节位点，按学号目录的 `.identity.json` 取批次身份，POST 到服务端新路由 `POST /api/trace/archive`；服务器按事件 id 幂等合并落文件。归档与分析上报两条链路完全解耦，L1Writer 除落盘目录外零改动。

**Tech Stack:** TypeScript + VS Code Extension API (^1.96, 仅稳定 API)；服务端 Express 5 + node:fs；测试 vitest（客户端）/ vitest + supertest（服务端）。

**Spec:** `docs/superpowers/specs/2026-10-13-l1-trace-archive-design.md`（协议、位点规则、错误处理以 spec 为准）

## Global Constraints

- 两个仓库：客户端 `d:\ruan\vscode-pylearner`，服务端 `D:\ruan\classroom-assistant`。git 提交分别在各仓库执行（PowerShell 下用 `;` 分隔命令，不支持 `&&`）
- 客户端测试：`npx vitest run <file>`；类型检查 `npx tsc --noEmit`；不新增任何 npm 依赖
- 服务端测试：`pnpm --filter @classroom/server exec vitest run <file>`（在 `D:\ruan\classroom-assistant` 下执行）；类型检查 `pnpm --filter @classroom/server build`
- 批次上限：≤200 事件或 ≤512KB/批；触发：仅激活后 10s 首扫一次，无定时/事件驱动触发（spec §4.4）
- 保留字 `unknown` 目录永不归档；学号目录名仅 `[A-Za-z0-9_-]` 且 ≤32 字符、不与 6 个 surface 名冲突，不合法落 `unknown`
- 协议字段：`student_id`/`student_name`/`class_id`/`surface`/`date`/`events`；响应 `{ ok, accepted, duplicated }`
- 只用 VS Code 稳定 API（`vscode.workspace.fs` 等），麒麟兼容
- 注释用中文（跟随现有代码风格）

---

### Task 1: 服务端归档路由（classroom-assistant）

**Files:**
- Create: `packages/server/src/routes/traceArchive.ts`
- Test: `packages/server/src/__tests__/traceArchive.test.ts`
- Modify: `packages/server/src/index.ts`（注册路由 + TRACE_DIR 解析）

**Interfaces:**
- Consumes: `logEvent` from `../logger`（现有）
- Produces: `registerTraceArchiveRoutes(app: Express, deps: { traceDir: string }): void`；供 Task 6 客户端调用的协议 `POST /api/trace/archive` → `200 { ok: true, accepted: number, duplicated: number }`，校验失败 400

- [ ] **Step 1: 写失败测试**

```ts
// packages/server/src/__tests__/traceArchive.test.ts
import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTraceArchiveRoutes } from "../routes/traceArchive";

const bases: string[] = [];
function makeApp() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trace-archive-"));
  bases.push(base);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerTraceArchiveRoutes(app, { traceDir: base });
  return app;
}
afterAll(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

const ev = (id: string) => ({ id, ts: "2026-10-13T00:00:00.000Z", surface: "edit", kind: "code_change", payload: {} });
const post = (app: express.Express, body: Record<string, unknown>) =>
  request(app).post("/api/trace/archive").send(body);

function archived(baseDir: string, classId = "default", studentId = "2024001", surface = "edit", date = "2026-10-13") {
  return path.join(baseDir, "trace", classId, studentId, surface, `${date}.jsonl`);
}

describe("POST /api/trace/archive", () => {
  it("归档落位 + accepted 计数", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const res = await post(app, { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] }).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 2, duplicated: 0 });
    const text = fs.readFileSync(archived(base), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe("e1");
  });

  it("同 id 重传幂等（duplicated 计数、文件不重复）", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const batch = { student_id: "2024001", student_name: "张三", surface: "edit", date: "2026-10-13", events: [ev("e1"), ev("e2")] };
    await post(app, batch).expect(200);
    const res = await post(app, batch).expect(200);
    expect(res.body).toEqual({ ok: true, accepted: 0, duplicated: 2 });
    expect(fs.readFileSync(archived(base), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("两台机器同日交错合并（不同 id 全部落盘）", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    await post(app, { student_id: "2024001", student_name: "张三", surface: "run", date: "2026-10-13", events: [ev("a:1")] }).expect(200);
    await post(app, { student_id: "2024001", student_name: "张三", surface: "run", date: "2026-10-13", events: [ev("b:1")] }).expect(200);
    expect(fs.readFileSync(archived(base, "default", "2024001", "run"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("class_id 缺省 default；自定义 class_id 落对应目录", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    await post(app, { student_id: "2024001", student_name: "张三", surface: "chat", date: "2026-10-13", events: [ev("c1")] }).expect(200);
    await post(app, { student_id: "2024002", student_name: "李四", class_id: "class-2", surface: "chat", date: "2026-10-13", events: [ev("c2")] }).expect(200);
    expect(fs.existsSync(archived(base, "default", "2024001", "chat"))).toBe(true);
    expect(fs.existsSync(archived(base, "class-2", "2024002", "chat"))).toBe(true);
  });

  it.each([
    [{ student_id: "../etc", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "路径穿越"],
    [{ student_id: "2024.01", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "含点非法字符"],
    [{ student_id: "unknown", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "保留字"],
    [{ surface: "edit", date: "2026-10-13", events: [ev("x")] }, "缺 student_id"],
    [{ student_id: "2024001", surface: "photo", date: "2026-10-13", events: [ev("x")] }, "非法 surface"],
    [{ student_id: "2024001", surface: "edit", date: "20261013", events: [ev("x")] }, "非法 date"],
    [{ student_id: "2024001", surface: "edit", date: "2026-10-13", events: [] }, "空 events"],
    [{ student_id: "2024001", class_id: "a/b", surface: "edit", date: "2026-10-13", events: [ev("x")] }, "非法 class_id"],
  ])("校验拒绝：%#", async (body) => {
    const app = makeApp();
    await post(app, body as Record<string, unknown>).expect(400);
  });

  it("并发写同一文件不丢行", async () => {
    const app = makeApp();
    const base = bases[bases.length - 1];
    const mk = (p: string) => ({ student_id: "2024001", student_name: "张三", surface: "debug", date: "2026-10-13", events: [ev(`d-${p}-1`), ev(`d-${p}-2`)] });
    await Promise.all([post(app, mk("a")), post(app, mk("b"))]);
    expect(fs.readFileSync(archived(base, "default", "2024001", "debug"), "utf8").trim().split("\n")).toHaveLength(4);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run（在 `D:\ruan\classroom-assistant`）: `pnpm --filter @classroom/server exec vitest run src/__tests__/traceArchive.test.ts`
Expected: FAIL（模块 `../routes/traceArchive` 不存在）

- [ ] **Step 3: 实现路由**

```ts
// packages/server/src/routes/traceArchive.ts
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { logEvent } from "../logger";

const SURFACE_VALUES = new Set(["edit", "run", "chat", "debug", "diag", "behavior"]);
// student_id / class_id 直接拼进归档路径，目录名白名单防路径穿越
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface TraceArchiveDeps {
  /** 数据根目录（TRACE_DIR 环境变量；归档落在 <traceDir>/trace/<classId>/<studentId>/<surface>/<date>.jsonl） */
  traceDir: string;
}

export function registerTraceArchiveRoutes(app: Express, deps: TraceArchiveDeps): void {
  // per-file 写锁：并发请求对同一归档文件读改写时串行化，防丢行（与客户端 L1Writer 锁模式同思路）
  const locks = new Map<string, Promise<void>>();

  app.post("/api/trace/archive", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const studentId = typeof body.student_id === "string" ? body.student_id : "";
    const classId = typeof body.class_id === "string" && body.class_id !== "" ? body.class_id : "default";
    const surface = typeof body.surface === "string" ? body.surface : "";
    const date = typeof body.date === "string" ? body.date : "";
    const events = Array.isArray(body.events) ? body.events : [];

    if (!studentId || !NAME_PATTERN.test(studentId) || studentId === "unknown") {
      logEvent({ event: "archive.batch_rejected", level: "warn", data: { reason: "student_id", studentId } });
      return res.status(400).json({ error: "student_id 非法" });
    }
    if (!NAME_PATTERN.test(classId)) {
      return res.status(400).json({ error: "class_id 非法" });
    }
    if (!SURFACE_VALUES.has(surface)) {
      return res.status(400).json({ error: "surface 非法" });
    }
    if (!DATE_PATTERN.test(date)) {
      return res.status(400).json({ error: "date 非法" });
    }
    if (events.length === 0) {
      return res.status(400).json({ error: "events 不能为空" });
    }

    const fileDir = path.join(deps.traceDir, "trace", classId, studentId, surface);
    const filePath = path.join(fileDir, `${date}.jsonl`);

    const prev = locks.get(filePath) ?? Promise.resolve();
    const task = prev.catch(() => {}).then(() => {
      fs.mkdirSync(fileDir, { recursive: true });
      // 按事件 id 幂等判重：多机同日同名文件交错、客户端重传均不产生重复
      const existing = new Set<string>();
      if (fs.existsSync(filePath)) {
        for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { id?: unknown };
            if (typeof parsed.id === "string") existing.add(parsed.id);
          } catch {
            // 坏行跳过，不影响判重
          }
        }
      }
      const fresh: string[] = [];
      let duplicated = 0;
      for (const item of events) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || existing.has(id)) {
          duplicated++;
          continue;
        }
        existing.add(id);
        fresh.push(JSON.stringify(item));
      }
      if (fresh.length > 0) {
        fs.appendFileSync(filePath, fresh.join("\n") + "\n");
      }
      return { accepted: fresh.length, duplicated };
    });
    locks.set(filePath, task.catch(() => {}));

    task
      .then(({ accepted, duplicated }) => {
        logEvent({ event: "archive.batch_received", data: { studentId, classId, surface, date, accepted, duplicated } });
        return res.json({ ok: true, accepted, duplicated });
      })
      .catch((err: unknown) => {
        // 兜底：未捕获异常返回 JSON（避免 Express 5 默认 HTML 500）
        logEvent({ event: "archive.batch_error", level: "error", data: { error: err instanceof Error ? err.message : String(err) } });
        return res.status(500).json({ error: "服务器内部错误" });
      });
  });
}
```

- [ ] **Step 4: 在 index.ts 注册**

`packages/server/src/index.ts` 顶部 import 区（`registerReviewRoutes` 之后）加：

```ts
import { registerTraceArchiveRoutes } from "./routes/traceArchive";
```

在 `registerReviewRoutes(app, reviewRequestDeps);`（约 208 行）之后加：

```ts
  // L1 全量归档（独立于分析链路；<TRACE_DIR>/trace/<classId>/<studentId>/...，与 DB_PATH 同款环境变量约定）
  registerTraceArchiveRoutes(app, {
    traceDir: process.env.TRACE_DIR || path.join(process.cwd(), "data"),
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @classroom/server exec vitest run src/__tests__/traceArchive.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 6: 全量回归 + 类型检查**

Run: `pnpm --filter @classroom/server test` ；`pnpm --filter @classroom/server build`
Expected: 全部 PASS；tsc 无错误

- [ ] **Step 7: 提交（classroom-assistant 仓库）**

```bash
git -C D:\ruan\classroom-assistant add packages/server/src/routes/traceArchive.ts packages/server/src/__tests__/traceArchive.test.ts packages/server/src/index.ts
git -C D:\ruan\classroom-assistant commit -m "feat: L1 trace 全量归档接口 /api/trace/archive（按事件 id 幂等合并，per-file 写锁）"
```

---

### Task 2: 客户端归档基础纯函数（identity + archiveState）

**Files:**
- Create: `src/archive/identity.ts`
- Create: `src/archive/archiveState.ts`
- Test: `src/test/archive/archiveState.test.ts`

**Interfaces:**
- Consumes: `SURFACES` from `../constants`（现有：`["edit","run","chat","debug","diag","behavior"]`）
- Produces（Task 3/5/6 依赖）:
  - `UNKNOWN_DIR = "unknown"`
  - `studentDirName(studentId: string | null | undefined): string`
  - `isArchivableDirName(name: string): boolean`
  - `offsetsKey(studentId: string, surface: string, date: string): string`
  - `parseOffsets(json: string | null): Record<string, number>`
  - `serializeOffsets(offsets: Record<string, number>): string`
  - `OFFSETS_FILE = "archive-state.json"`

- [ ] **Step 1: 写失败测试**

```ts
// src/test/archive/archiveState.test.ts
import { describe, it, expect } from "vitest";
import {
  UNKNOWN_DIR,
  studentDirName,
  isArchivableDirName,
  offsetsKey,
  parseOffsets,
  serializeOffsets,
} from "../../archive/identity";
import { serializeOffsets as ser, parseOffsets as par } from "../../archive/archiveState";

describe("studentDirName", () => {
  it("合法学号原样返回", () => {
    expect(studentDirName("2024001")).toBe("2024001");
    expect(studentDirName("abc_123-X")).toBe("abc_123-X");
  });
  it("空/未设身份 → unknown", () => {
    expect(studentDirName(null)).toBe(UNKNOWN_DIR);
    expect(studentDirName(undefined)).toBe(UNKNOWN_DIR);
    expect(studentDirName("")).toBe(UNKNOWN_DIR);
    expect(studentDirName("   ")).toBe(UNKNOWN_DIR);
  });
  it("非法字符（路径穿越/点/斜杠）→ unknown", () => {
    expect(studentDirName("../etc")).toBe(UNKNOWN_DIR);
    expect(studentDirName("2024.01")).toBe(UNKNOWN_DIR);
    expect(studentDirName("a/b")).toBe(UNKNOWN_DIR);
  });
  it("保留字与 surface 名冲突 → unknown", () => {
    expect(studentDirName("unknown")).toBe(UNKNOWN_DIR);
    expect(studentDirName("edit")).toBe(UNKNOWN_DIR);
    expect(studentDirName("diag")).toBe(UNKNOWN_DIR);
  });
  it("超长 → unknown", () => {
    expect(studentDirName("a".repeat(33))).toBe(UNKNOWN_DIR);
    expect(studentDirName("a".repeat(32))).toBe("a".repeat(32));
  });
});

describe("isArchivableDirName", () => {
  it("学号目录 true；unknown/旧布局 surface 目录/非法名 false", () => {
    expect(isArchivableDirName("2024001")).toBe(true);
    expect(isArchivableDirName("unknown")).toBe(false);
    expect(isArchivableDirName("edit")).toBe(false);
    expect(isArchivableDirName("../x")).toBe(false);
    expect(isArchivableDirName("a".repeat(33))).toBe(false);
  });
});

describe("archiveState", () => {
  it("offsetsKey 组装与 parse/serialize 往返", () => {
    expect(offsetsKey("2024001", "edit", "2026-10-13")).toBe("2024001/edit/2026-10-13.jsonl");
    const offsets = { "2024001/edit/2026-10-13.jsonl": 123 };
    expect(par(ser(offsets))).toEqual(offsets);
  });
  it("parseOffsets 容错：null/坏 JSON/非法值 → 空或过滤", () => {
    expect(parseOffsets(null)).toEqual({});
    expect(parseOffsets("not json")).toEqual({});
    expect(parseOffsets(JSON.stringify({ a: 1, b: "x", c: -1, d: Infinity }))).toEqual({ a: 1 });
  });
});
```

注：`identity.ts` 与 `archiveState.ts` 的测试写在一起；`describe("archiveState")` 里 import 用 `../../archive/archiveState` 的 `ser/par` 别名避免重名。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/test/archive/archiveState.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/archive/identity.ts
// 归档相关的学号目录名规则（纯函数，不 import vscode）。
// 本地布局：trace/<studentId>/<surface>/<date>.jsonl；未设身份/学号非法 → trace/unknown/（永不归档）。
import { SURFACES } from "../constants";

export const UNKNOWN_DIR = "unknown";

const STUDENT_DIR_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_LEN = 32; // 与 validateStudentId 的 MAX_LEN 对齐

/** 学号 → 本地 trace 子目录名；不合法（空/超长/非法字符/与保留字或 surface 名冲突）一律 unknown */
export function studentDirName(studentId: string | null | undefined): string {
  if (!studentId) return UNKNOWN_DIR;
  const v = studentId.trim();
  if (!v || v.length > MAX_LEN || !STUDENT_DIR_PATTERN.test(v)) return UNKNOWN_DIR;
  if (v === UNKNOWN_DIR || (SURFACES as readonly string[]).includes(v)) return UNKNOWN_DIR;
  return v;
}

/** trace/ 顶层目录名是否为可归档学号目录（排除 unknown、旧布局顶层 surface 目录、非法名） */
export function isArchivableDirName(name: string): boolean {
  if (name === UNKNOWN_DIR) return false;
  if ((SURFACES as readonly string[]).includes(name)) return false;
  return name.length <= MAX_LEN && STUDENT_DIR_PATTERN.test(name);
}
```

```ts
// src/archive/archiveState.ts
// 归档位点（纯字符串逻辑，可脱离 vscode 单测）。
// 位点文件 trace/archive-state.json：{ "<studentId>/<surface>/<date>.jsonl": 已归档字节数 }
export type ArchiveOffsets = Record<string, number>;

export const OFFSETS_FILE = "archive-state.json";

export function offsetsKey(studentId: string, surface: string, date: string): string {
  return `${studentId}/${surface}/${date}.jsonl`;
}

/** 容错解析：缺文件/坏 JSON 返回空对象；非有限非负数字值丢弃 */
export function parseOffsets(json: string | null): ArchiveOffsets {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: ArchiveOffsets = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number" && v >= 0 && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeOffsets(offsets: ArchiveOffsets): string {
  return JSON.stringify(offsets, null, 2);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/test/archive/archiveState.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/archive/identity.ts src/archive/archiveState.ts src/test/archive/archiveState.test.ts
git commit -m "feat(archive): 学号目录名规则与归档位点纯函数"
```

---

### Task 3: L1Writer 按学号落盘 + identity.json 快照

**Files:**
- Modify: `src/storage/l1Writer.ts`
- Test: `src/test/storage/l1Writer-identity.test.ts`

**Interfaces:**
- Consumes: `studentDirName`, `UNKNOWN_DIR`（Task 2）
- Produces（Task 7 装配依赖）: `L1Writer.setIdentityProvider(provider?: () => { studentId: string | null; studentName: string | null; classId?: string } | undefined): void`；本地布局变为 `trace/<studentId|unknown>/<surface>/<date>.jsonl` + `trace/<studentId>/.identity.json`（`{"studentId","studentName","classId"}`，仅内容变化时覆写）

- [ ] **Step 1: 写失败测试**

```ts
// src/test/storage/l1Writer-identity.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { L1Writer } from "../../storage/l1Writer";

const today = new Date().toISOString().slice(0, 10);

function makeWriter() {
  return new L1Writer({ fsPath: "/tmp/x", toString: () => "file:///tmp/x" } as never);
}
const writtenPaths = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.map((c) => (c[0] as { path: string }).path);
const identityWrites = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.filter((c) => (c[0] as { path: string }).path.endsWith(".identity.json"));

beforeEach(() => {
  vi.mocked(vscode.workspace.fs.readFile).mockResolvedValue(new Uint8Array(0));
  vi.mocked(vscode.workspace.fs.createDirectory).mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
});

describe("L1Writer 按学号落盘", () => {
  it("有身份 → trace/<学号>/<surface>/<date>.jsonl，并写 .identity.json", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    const paths = writtenPaths();
    expect(paths.some((p) => p === `/tmp/x/trace/2024001/edit/${today}.jsonl`)).toBe(true);
    expect(identityWrites()).toHaveLength(1);
    const payload = JSON.parse(new TextDecoder().decode(identityWrites()[0][1] as Uint8Array));
    expect(payload).toEqual({ studentId: "2024001", studentName: "张三", classId: "default" });
  });

  it("未设身份 → trace/unknown/，不写 identity.json", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => undefined);
    await w.append("edit", "code_change", {});
    expect(writtenPaths().some((p) => p === `/tmp/x/trace/unknown/edit/${today}.jsonl`)).toBe(true);
    expect(identityWrites()).toHaveLength(0);
  });

  it("非法学号 → unknown", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "../x", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    expect(writtenPaths().some((p) => p.startsWith(`/tmp/x/trace/unknown/`))).toBe(true);
    expect(identityWrites()).toHaveLength(0);
  });

  it("身份切换 → 下一条事件落新目录，identity.json 覆写", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    w.setIdentityProvider(() => ({ studentId: "2024002", studentName: "李四", classId: "c2" }));
    await w.append("edit", "code_change", {});
    const paths = writtenPaths();
    expect(paths.some((p) => p.startsWith("/tmp/x/trace/2024001/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/tmp/x/trace/2024002/"))).toBe(true);
    expect(identityWrites()).toHaveLength(2);
    const second = JSON.parse(new TextDecoder().decode(identityWrites()[1][1] as Uint8Array));
    expect(second).toEqual({ studentId: "2024002", studentName: "李四", classId: "c2" });
  });

  it("同身份连续 append → identity.json 只写一次", async () => {
    const w = makeWriter();
    w.setIdentityProvider(() => ({ studentId: "2024001", studentName: "张三" }));
    await w.append("edit", "code_change", {});
    await w.append("edit", "code_change", {});
    expect(identityWrites()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/test/storage/l1Writer-identity.test.ts`
Expected: FAIL（`setIdentityProvider` 不存在；落盘路径仍是旧布局）

- [ ] **Step 3: 修改 L1Writer**

`src/storage/l1Writer.ts` 全文替换为：

```ts
import * as vscode from "vscode";
import { ulid } from "ulidx";
import type { Surface } from "../constants";
import type { TraceEvent } from "../events/types";
import { makeEvent } from "../events/types";
import { studentDirName, UNKNOWN_DIR } from "../archive/identity";

export interface TeacherReporter {
  report(event: TraceEvent): Promise<void>;
}

/** 学号目录下的身份快照（供归档批次取身份，spec §4.3） */
export interface ArchiveIdentity {
  studentId: string;
  studentName: string;
  classId: string;
}

/** append 时读取的当前身份；classId 缺省由快照层补 default */
export type IdentityProvider = () => { studentId: string | null; studentName: string | null; classId?: string } | undefined;

export class L1Writer {
  private baseUri: vscode.Uri;
  private locks: Map<string, Promise<void>> = new Map();
  private reporter?: TeacherReporter;
  private submissionHandler?: (event: TraceEvent) => void;
  private getIdentity?: IdentityProvider;
  // identity.json 变更检测（内存缓存，避免每事件读盘）
  private lastIdentityJson: string | null = null;

  constructor(storageUri: vscode.Uri) {
    this.baseUri = vscode.Uri.joinPath(storageUri, "trace");
  }

  setTeacherReporter(reporter: TeacherReporter | undefined) {
    this.reporter = reporter;
  }

  setSubmissionHandler(handler?: (event: TraceEvent) => void) {
    this.submissionHandler = handler;
  }

  /** 注入身份读取器：每次 append 时调用，学号变更后下一条事件立即落新目录（spec §4.1） */
  setIdentityProvider(provider?: IdentityProvider) {
    this.getIdentity = provider;
  }

  async append(
    surface: Surface,
    kind: string,
    payload: Record<string, unknown>,
    sessionId?: string
  ): Promise<void> {
    const event = makeEvent(surface, kind, payload, () => ulid(), () =>
      new Date().toISOString(), sessionId
    );
    await this.writeEvent(event);

    // 异步上报到教师端（非阻塞，失败不影响 L1 持久化）
    if (this.reporter && shouldReportToTeacher(surface, kind)) {
      this.reporter.report(event).catch((err: unknown) => {
        console.warn("[L1Writer] 教师端上报失败:", err instanceof Error ? err.message : String(err));
      });
    }

    // 分发给提交通道（仅 run success；失败不影响 L1 持久化）
    if (this.submissionHandler && surface === "run" && kind === "execution_success") {
      try {
        this.submissionHandler(event);
      } catch (err: unknown) {
        console.warn("[L1Writer] 提交通道分发失败:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async writeEvent(event: TraceEvent): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dirName = studentDirName(this.getIdentity?.()?.studentId ?? null);
    const dirUri = vscode.Uri.joinPath(this.baseUri, dirName, event.surface);
    const fileUri = vscode.Uri.joinPath(dirUri, `${today}.jsonl`);
    const line = JSON.stringify(event) + "\n";

    // Serialize writes per surface to avoid interleaving. The stored lock is
    // normalized to never reject — one failed append must not poison the chain
    // (a rejected promise would make every later `.then` skip, silently
    // killing the surface). Callers still see the real error via `await next`.
    const prev = this.locks.get(event.surface) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // directory exists
      }
      await this.writeIdentitySnapshot(dirName);
      const encoder = new TextEncoder();
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        existing = new Uint8Array(0);
      }
      const combined = new Uint8Array(existing.length + encoder.encode(line).length);
      combined.set(existing, 0);
      combined.set(encoder.encode(line), existing.length);
      await vscode.workspace.fs.writeFile(fileUri, combined);
    });
    this.locks.set(event.surface, next.catch(() => {}));
    await next;
  }

  /** 学号目录下维护 .identity.json（仅内容变化时覆写；写失败不影响事件落盘） */
  private async writeIdentitySnapshot(dirName: string): Promise<void> {
    const identity = this.getIdentity?.();
    if (!identity?.studentId || !identity.studentName || dirName === UNKNOWN_DIR) return;
    const snapshot: ArchiveIdentity = {
      studentId: identity.studentId,
      studentName: identity.studentName,
      classId: identity.classId || "default",
    };
    const json = JSON.stringify(snapshot);
    if (json === this.lastIdentityJson) return;
    this.lastIdentityJson = json;
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.baseUri, dirName, ".identity.json"),
        new TextEncoder().encode(json + "\n")
      );
    } catch {
      // 快照写失败下一条事件会再试
    }
  }
}

function shouldReportToTeacher(surface: Surface, kind: string): boolean {
  return (
    (surface === "diag" && kind === "diagnostics_change") ||
    (surface === "run" && (kind === "execution_success" || kind === "execution_error"))
  );
}
```

- [ ] **Step 4: 运行测试确认通过（含旧用例回归）**

Run: `npx vitest run src/test/storage/`
Expected: PASS（新用例 + l1Writer-submission 旧用例。旧用例未设 identityProvider → 落 `unknown/`，断言只查 handler 调用不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/storage/l1Writer.ts src/test/storage/l1Writer-identity.test.ts
git commit -m "feat(l1): 本地 trace 按学号分目录落盘 + .identity.json 身份快照（unknown 保留字兜底）"
```

---

### Task 4: 画像管线按学号读取（reader + 3 调用方 + vscode-mock 扩展）

**Files:**
- Modify: `src/test/vscode-mock.ts`（补 `readDirectory` 与 `FileType`）
- Modify: `src/snapshot/reader.ts`
- Modify: `src/commands/updateProfile.ts`
- Modify: `src/commands/autoRefresh.ts`
- Modify: `src/commands/memoryGraph.ts`
- Test: `src/test/snapshot/reader.test.ts`

**Interfaces:**
- Consumes: `studentDirName`, `UNKNOWN_DIR`（Task 2）；`loadStudentIdentity`（现有 `src/identity/studentIdentity.ts`）
- Produces: `readTraceEntities(storageUri: vscode.Uri, surface: Surface, studentId: string | null): Promise<Entity[]>`（无身份返回空数组）；`ProfileRefresher` 构造器第 4 参 `getIdentity: () => StudentIdentity`；`runProfileUpdate` 第 4 参 `studentId: string | null`

- [ ] **Step 1: 扩展 vscode-mock**

`src/test/vscode-mock.ts` 的 `vi.mock("vscode", ...)` 返回对象中，`workspace.fs` 增加 `readDirectory: vi.fn()`，并在 `Uri` 之前加：

```ts
  FileType: { File: 1, Directory: 2 },
```

- [ ] **Step 2: 写失败测试**

```ts
// src/test/snapshot/reader.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { readTraceEntities } from "../../snapshot/reader";

const enc = new TextEncoder();
const file = (name: string): [string, vscode.FileType] => [name, vscode.FileType.File];
const dir = (name: string): [string, vscode.FileType] => [name, vscode.FileType.Directory];
const storage = { fsPath: "/gs", toString: () => "file:///gs" } as never;

beforeEach(() => {
  vi.mocked(vscode.workspace.fs.readDirectory).mockReset();
  vi.mocked(vscode.workspace.fs.readFile).mockReset();
});

describe("readTraceEntities（按学号）", () => {
  it("无身份 → 空数组，不做任何 IO", async () => {
    expect(await readTraceEntities(storage, "chat", null)).toEqual([]);
    expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
  });

  it("非法学号 → 空数组", async () => {
    expect(await readTraceEntities(storage, "chat", "../x")).toEqual([]);
  });

  it("读 trace/<studentId>/<surface>/ 下的 jsonl 并解析", async () => {
    vi.mocked(vscode.workspace.fs.readDirectory).mockResolvedValue([
      file("2026-10-12.jsonl"),
      file("2026-10-13.jsonl"),
      file("other.txt"),
    ]);
    vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
      const p = (uri as { path: string }).path;
      if (p.endsWith("2026-10-12.jsonl")) {
        return enc.encode('{"id":"chat:e1","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n');
      }
      return Promise.reject(new Error("missing"));
    });
    const entities = await readTraceEntities(storage, "chat", "2024001");
    expect(entities).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/test/snapshot/reader.test.ts`
Expected: FAIL（签名只有 2 参 / 读的是旧布局）

- [ ] **Step 4: 修改 reader.ts**

`src/snapshot/reader.ts` 全文替换为：

```ts
// I/O entry point: read L1 trace JSONL for a surface → `Entity[]`.
//
// Kept separate from the pure mapping in `adapter.ts` so that the mapping is
// unit-testable without the `vscode` module. This is the only L1 read path
// the consolidation flow needs (trace events are append-only; the id-set diff
// against `*.meta.json` decides what is "new since last update").
//
// 本地 L1 按学号分目录（spec §4.1）：读 trace/<studentId>/<surface>/；无身份返回空。

import * as vscode from "vscode";
import type { Surface } from "../constants";
import { studentDirName, UNKNOWN_DIR } from "../archive/identity";
import { parseTraceLine, traceEventToEntity } from "./adapter";
import type { Entity } from "./entity";

export async function readTraceEntities(
  storageUri: vscode.Uri,
  surface: Surface,
  studentId: string | null
): Promise<Entity[]> {
  const dirName = studentDirName(studentId);
  if (dirName === UNKNOWN_DIR) return [];
  const dirUri = vscode.Uri.joinPath(storageUri, "trace", dirName, surface);
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(dirUri);
  } catch {
    return [];
  }

  const jsonlFiles = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".jsonl"))
    .map(([name]) => name)
    .sort();

  const entities: Entity[] = [];
  for (const name of jsonlFiles) {
    const fileUri = vscode.Uri.joinPath(dirUri, name);
    let data: Uint8Array;
    try {
      data = await vscode.workspace.fs.readFile(fileUri);
    } catch {
      continue;
    }
    const text = new TextDecoder().decode(data);
    for (const line of text.split("\n")) {
      const event = parseTraceLine(line);
      if (event && event.surface === surface) {
        entities.push(traceEventToEntity(event));
      }
    }
  }
  return entities;
}
```

- [ ] **Step 5: 修改三个调用方**

**updateProfile.ts**（`src/commands/updateProfile.ts`）：

1. import 区加：`import { loadStudentIdentity } from "../identity/studentIdentity";`
2. `makeDeps` 签名（第 20 行）与 readEntities 改为：

```ts
function makeDeps(storageUri: vscode.Uri, router: LlmRouter, apiKey: string, studentId: string | null, onEvent?: (event: Record<string, unknown>) => void, log?: (msg: string) => void): ConsolidatorDeps {
  return {
    readEntities: (surface) => readTraceEntities(storageUri, surface, studentId),
```

3. `runProfileUpdate` 签名（第 122 行）改为（插入 `studentId` 第 4 参）：

```ts
export async function runProfileUpdate(
  storageUri: vscode.Uri,
  secrets: vscode.SecretStorage,
  router: LlmRouter,
  studentId: string | null,
  onEvent?: (event: Record<string, unknown>) => void,
  cancellationToken?: vscode.CancellationToken,
  log?: (msg: string) => void
): Promise<void> {
```

第 132 行 `makeDeps(...)` 调用改为：`const deps = makeDeps(storageUri, router, apiKey, studentId, onEvent, log);`

4. `registerUpdateProfileCommand` 内（第 220 行附近）`runProfileUpdate` 调用在 `context.globalStorageUri, context.secrets, router,` 之后插一行：

```ts
            loadStudentIdentity(context.globalState).studentId,
```

5. `registerResetProfileCommand` 内（第 298 行附近）同样插入该行。

**autoRefresh.ts**（`src/commands/autoRefresh.ts`）：

1. import 区加：`import { loadStudentIdentity, type StudentIdentity } from "../identity/studentIdentity";`
2. 构造器加第 4 参：

```ts
  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly routerFactory: () => LlmRouter,
    private readonly getIdentity: () => StudentIdentity
  ) {}
```

3. `countNewEvents`（第 77 行）改为：

```ts
      const entities = await readTraceEntities(this.storageUri, surface, this.getIdentity().studentId);
```

4. `maybeRefresh` 内的 `runProfileUpdate` 调用（第 45 行）补第 4 参：

```ts
        await runProfileUpdate(this.storageUri, this.secrets, router, this.getIdentity().studentId);
```

**memoryGraph.ts**（`src/commands/memoryGraph.ts`）：

1. import 区加：`import { loadStudentIdentity } from "../identity/studentIdentity";`
2. 命令处理里两处 `postGraph(panel.webview, context.globalStorageUri)`（第 40、44 行）改为：

```ts
        await postGraph(panel.webview, context.globalStorageUri, loadStudentIdentity(context.globalState).studentId);
```

```ts
    await postGraph(panel.webview, context.globalStorageUri, loadStudentIdentity(context.globalState).studentId);
```

3. `postGraph` 与 `loadGraph` 签名加参：

```ts
async function postGraph(
  webview: vscode.Webview,
  storageUri: vscode.Uri,
  studentId: string | null
): Promise<void> {
  try {
    const graph = await loadGraph(storageUri, studentId);
```

```ts
async function loadGraph(storageUri: vscode.Uri, studentId: string | null): Promise<CitationGraph> {
```

第 75 行改为：`entities[surface] = await readTraceEntities(storageUri, surface, studentId);`

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npx tsc --noEmit` ；`npx vitest run`
Expected: tsc 无错误；全部 PASS（若 `src/test/memory/autoRefresh.test.ts` 或其他用例因签名变化失败，按新签名修正用例——构造器补第 4 参 `() => ({ studentId: null, studentName: null })`）

- [ ] **Step 7: 提交**

```bash
git add src/snapshot/reader.ts src/commands/updateProfile.ts src/commands/autoRefresh.ts src/commands/memoryGraph.ts src/test/vscode-mock.ts src/test/snapshot/reader.test.ts
git commit -m "feat(memory): 画像管线按学号读取 L1 trace（无身份返回空，适配分目录布局）"
```

---

### Task 5: batcher——扫描/位点 diff/切批（纯逻辑）

**Files:**
- Create: `src/archive/batcher.ts`
- Test: `src/test/archive/batcher.test.ts`

**Interfaces:**
- Consumes: `isArchivableDirName`（Task 2）、`offsetsKey`（Task 2）、`Surface`/`SURFACES`（constants）、`TraceEvent`（events/types）
- Produces（Task 6 依赖）:
  - `interface ArchiveFs { listDirs(rel: string): Promise<string[]>; listFiles(rel: string): Promise<string[]>; readFileBytes(rel: string): Promise<Uint8Array | null>; writeFileBytes(rel: string, data: Uint8Array): Promise<void>; }`
  - `interface BatchIdentity { studentId: string; studentName: string; classId: string }`
  - `interface UploadJob { fileKey: string; relPath: string; identity: BatchIdentity; surface: Surface; date: string; events: TraceEvent[]; batchBytes: number; startOffset: number; endOffset: number; fileEnd: number; }`
  - `planBatches(fs: ArchiveFs, offsets: ArchiveOffsets, getIdentity: (studentId: string) => Promise<BatchIdentity | null>): Promise<{ jobs: UploadJob[]; offsets: ArchiveOffsets }>`（`offsets` 为含"文件缩小重置 0"修正后的副本）

- [ ] **Step 1: 写失败测试**

```ts
// src/test/archive/batcher.test.ts
import { describe, it, expect } from "vitest";
import {
  planBatches,
  type ArchiveFs,
  type BatchIdentity,
} from "../../archive/batcher";
import { OFFSETS_FILE } from "../../archive/archiveState";

const enc = new TextEncoder();
const IDENTITY: BatchIdentity = { studentId: "2024001", studentName: "张三", classId: "default" };
const line = (i: number) => `{"id":"chat:e${i}","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n`;

function memFs(files: Record<string, string>): ArchiveFs {
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) store.set(k, enc.encode(v));
  return {
    async listDirs(rel) {
      const prefix = rel ? rel + "/" : "";
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg && rest.includes("/")) names.add(seg);
      }
      return [...names];
    },
    async listFiles(rel) {
      const prefix = rel + "/";
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map((k) => k.slice(prefix.length));
    },
    async readFileBytes(rel) {
      return store.get(rel) ?? null;
    },
    async writeFileBytes(rel, data) {
      store.set(rel, data);
    },
  };
}
const getIdentity = async (id: string): Promise<BatchIdentity | null> =>
  id === "2024001" ? IDENTITY : null;

describe("planBatches", () => {
  it("全新文件 → 从 0 全量一批，位点 key 正确", async () => {
    const files: Record<string, string> = {
      "2024001/.identity.json": JSON.stringify(IDENTITY),
      "2024001/chat/2026-10-13.jsonl": line(1) + line(2),
    };
    const { jobs, offsets } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.fileKey).toBe("2024001/chat/2026-10-13.jsonl");
    expect(j.identity).toEqual(IDENTITY);
    expect(j.surface).toBe("chat");
    expect(j.date).toBe("2026-10-13");
    expect(j.events.map((e) => e.id)).toEqual(["chat:e1", "chat:e2"]);
    expect(j.startOffset).toBe(0);
    expect(j.endOffset).toBe(j.fileEnd);
    expect(offsets).toEqual({});
  });

  it("增量：位点已归档前半 → 只产出后半", async () => {
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": line(1) + line(2) + line(3),
    };
    const first = enc.encode(line(1)).length;
    const { jobs } = await planBatches(memFs(files), { "2024001/chat/2026-10-13.jsonl": first }, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e2", "chat:e3"]);
    expect(jobs[0].startOffset).toBe(first);
  });

  it("unknown/ 与旧布局顶层 surface 目录跳过；非法学号目录跳过", async () => {
    const files: Record<string, string> = {
      "unknown/edit/2026-10-13.jsonl": line(1),
      "edit/2026-10-13.jsonl": line(1), // 旧布局顶层
      "2024001/chat/2026-10-13.jsonl": line(2),
      "../evil/chat/2026-10-13.jsonl": line(3), // memFs 不含非法键则无影响
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].fileKey).toBe("2024001/chat/2026-10-13.jsonl");
  });

  it("identity.json 缺失 → 该学号整目录跳过", async () => {
    const files: Record<string, string> = {
      "2024002/chat/2026-10-13.jsonl": line(1),
      "2024001/chat/2026-10-13.jsonl": line(2),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].identity.studentId).toBe("2024001");
  });

  it(">200 事件切多批，位点按批推进", async () => {
    let content = "";
    for (let i = 0; i < 250; i++) content += line(i);
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": content,
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].events).toHaveLength(200);
    expect(jobs[1].events).toHaveLength(50);
    expect(jobs[0].endOffset).toBe(jobs[1].startOffset);
    expect(jobs[1].endOffset).toBe(jobs[0].fileEnd);
  });

  it("坏行跳过（不产出事件）但位点字节仍推进", async () => {
    const bad = "not-json\n";
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": bad + line(1),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e1"]);
    expect(jobs[0].endOffset).toBe(enc.encode(bad + line(1)).length);
  });

  it("文件比位点小（异常）→ 从 0 全量重传并在返回 offsets 中重置", async () => {
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": line(9),
    };
    const { jobs, offsets } = await planBatches(
      memFs(files),
      { "2024001/chat/2026-10-13.jsonl": 99999 },
      getIdentity
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].startOffset).toBe(0);
    expect(offsets["2024001/chat/2026-10-13.jsonl"]).toBe(0);
  });

  it("尾部不完整行（写盘中）不产出、位点不含", async () => {
    const partial = line(1) + '{"id":"chat:e2","ts":"t",';
    const files: Record<string, string> = {
      "2024001/chat/2026-10-13.jsonl": partial,
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].events.map((e) => e.id)).toEqual(["chat:e1"]);
    expect(jobs[0].endOffset).toBe(enc.encode(line(1)).length);
  });

  it("位点状态文件 OFFSETS_FILE 不参与扫描", async () => {
    const files: Record<string, string> = {
      [OFFSETS_FILE]: "{}",
      "2024001/chat/2026-10-13.jsonl": line(1),
    };
    const { jobs } = await planBatches(memFs(files), {}, getIdentity);
    expect(jobs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/test/archive/batcher.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 batcher**

```ts
// src/archive/batcher.ts
// 扫描本地按学号分目录的 L1 JSONL，对比位点产出上传批次。
// 纯逻辑 + 注入 fs（ArchiveFs），运行时由 archiver.ts 适配 vscode.workspace.fs，测试用内存实现（spec §4.2/§4.5）。
import { SURFACES, type Surface } from "../constants";
import type { TraceEvent } from "../events/types";
import { isArchivableDirName } from "./identity";
import { offsetsKey, type ArchiveOffsets } from "./archiveState";

export const MAX_EVENTS_PER_BATCH = 200;
export const MAX_BATCH_BYTES = 512 * 1024;

/** batcher 所需的最小文件系统能力（rel 为相对 trace/ 的 "/" 分隔路径） */
export interface ArchiveFs {
  /** 列子目录名；目录不存在返回 [] */
  listDirs(rel: string): Promise<string[]>;
  /** 列文件名；目录不存在返回 [] */
  listFiles(rel: string): Promise<string[]>;
  /** 读整个文件字节；不存在返回 null */
  readFileBytes(rel: string): Promise<Uint8Array | null>;
  writeFileBytes(rel: string, data: Uint8Array): Promise<void>;
}

export interface BatchIdentity {
  studentId: string;
  studentName: string;
  classId: string;
}

export interface UploadJob {
  /** 位点 key："<studentId>/<surface>/<date>.jsonl" */
  fileKey: string;
  relPath: string;
  identity: BatchIdentity;
  surface: Surface;
  date: string;
  events: TraceEvent[];
  batchBytes: number;
  startOffset: number;
  /** 本批推完后的位点 */
  endOffset: number;
  /** 扫描时文件总长（400 跳尾目标，spec §4.6） */
  fileEnd: number;
}

const encoder = new TextEncoder();

async function planFile(
  fs: ArchiveFs,
  rel: string,
  fileKey: string,
  offsets: ArchiveOffsets,
  identity: BatchIdentity,
  surface: Surface,
  date: string
): Promise<UploadJob[]> {
  const bytes = await fs.readFileBytes(rel);
  if (!bytes || bytes.length === 0) return [];
  let start = offsets[fileKey] ?? 0;
  if (start > bytes.length) {
    // 文件比位点小（异常，理论只追加）→ 全量重传；服务器按 id 幂等（spec §4.5）
    offsets[fileKey] = 0;
    start = 0;
  }
  if (start >= bytes.length) return [];

  const tail = new TextDecoder().decode(bytes.subarray(start));
  // 尾部不完整行（正在写盘）回退到上一个 \n；位点不推进到不完整行
  const usable = tail.endsWith("\n") ? tail : tail.slice(0, tail.lastIndexOf("\n") + 1);
  if (!usable) return [];

  const fileEnd = bytes.length;
  const jobs: UploadJob[] = [];
  let cur: TraceEvent[] = [];
  let curBytes = 0;
  let cursor = start;

  const flush = () => {
    if (cur.length === 0) return;
    jobs.push({
      fileKey, relPath: rel, identity, surface, date,
      events: cur, batchBytes: curBytes,
      startOffset: cursor, endOffset: cursor + curBytes, fileEnd,
    });
    cursor += curBytes;
    cur = [];
    curBytes = 0;
  };

  // usable 以 \n 结尾，split 后最后一段必为空，丢弃
  const segments = usable.split("\n");
  segments.pop();
  for (const seg of segments) {
    const lineBytes = encoder.encode(seg + "\n").length;
    if (cur.length >= MAX_EVENTS_PER_BATCH || (cur.length > 0 && curBytes + lineBytes > MAX_BATCH_BYTES)) {
      flush();
    }
    curBytes += lineBytes; // 坏行的字节也计入位点推进（内容已损坏，重试无意义）
    if (!seg.trim()) continue;
    try {
      cur.push(JSON.parse(seg) as TraceEvent);
    } catch {
      // 坏行跳过
    }
  }
  flush();
  return jobs;
}

/**
 * 扫描所有可归档学号目录（跳过 unknown/旧布局顶层目录），为每个学号读 .identity.json
 * 取批次身份；缺失/损坏 → 跳过该学号下轮重试（spec §4.3/§6）。
 * 返回的 offsets 是含"文件缩小重置"修正后的副本，archiver 应以其为后续推进基底。
 */
export async function planBatches(
  fs: ArchiveFs,
  offsets: ArchiveOffsets,
  getIdentity: (studentId: string) => Promise<BatchIdentity | null>
): Promise<{ jobs: UploadJob[]; offsets: ArchiveOffsets }> {
  const eff: ArchiveOffsets = { ...offsets };
  const jobs: UploadJob[] = [];
  for (const dirName of await fs.listDirs("")) {
    if (!isArchivableDirName(dirName)) continue;
    const identity = await getIdentity(dirName);
    if (!identity) continue;
    for (const surface of SURFACES) {
      const surfaceRel = `${dirName}/${surface}`;
      for (const name of await fs.listFiles(surfaceRel)) {
        if (!name.endsWith(".jsonl")) continue;
        const date = name.slice(0, -".jsonl".length);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        jobs.push(
          ...(await planFile(fs, `${surfaceRel}/${name}`, offsetsKey(dirName, surface, date), eff, identity, surface, date))
        );
      }
    }
  }
  return { jobs, offsets: eff };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/test/archive/batcher.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/archive/batcher.ts src/test/archive/batcher.test.ts
git commit -m "feat(archive): batcher——按学号扫描/位点 diff/字节切批（≤200 事件或 ≤512KB）"
```

---

### Task 6: archiver——调度 + 上传 + 位点推进

**Files:**
- Create: `src/archive/archiver.ts`
- Test: `src/test/archive/archiver.test.ts`

**Interfaces:**
- Consumes: Task 2 全部、Task 5 全部、`CONFIG_KEYS.teacherEnabled`（constants）
- Produces（Task 7 依赖）: `createTraceArchiver(deps: TraceArchiverDeps): TraceArchiver`，其中 `TraceArchiverDeps = { globalStorageUri: vscode.Uri; teacherUrl: () => string; isEnabled: () => boolean; log?: (msg: string) => void }`，`TraceArchiver extends vscode.Disposable { runOnce(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

```ts
// src/test/archive/archiver.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../vscode-mock";
import * as vscode from "vscode";
import { createTraceArchiver } from "../../archive/archiver";

const enc = new TextEncoder();
const IDENTITY = { studentId: "2024001", studentName: "张三", classId: "default" };
const line = (i: number) => `{"id":"chat:e${i}","ts":"t","surface":"chat","kind":"user_message","payload":{}}\n`;
// edit 文件 1 条、chat 文件 2 条 → 共 2 个上传批次（edit 批先于 chat 批，SURFACES 顺序）
const EDIT_KEY = "2024001/edit/2026-10-13.jsonl";
const CHAT_KEY = "2024001/chat/2026-10-13.jsonl";

function seedFs() {
  vi.mocked(vscode.workspace.fs.readDirectory).mockImplementation(async (uri: unknown) => {
    const p = (uri as { path: string }).path;
    if (p === "/gs/trace") return [["2024001", vscode.FileType.Directory]];
    if (p === "/gs/trace/2024001") return [[".identity.json", vscode.FileType.File]];
    if (p === "/gs/trace/2024001/edit") return [["2026-10-13.jsonl", vscode.FileType.File]];
    if (p === "/gs/trace/2024001/chat") return [["2026-10-13.jsonl", vscode.FileType.File]];
    return [];
  });
  vi.mocked(vscode.workspace.fs.readFile).mockImplementation(async (uri: unknown) => {
    const p = (uri as { path: string }).path;
    if (p === "/gs/trace/2024001/.identity.json") return enc.encode(JSON.stringify(IDENTITY));
    if (p === "/gs/trace/2024001/edit/2026-10-13.jsonl") return enc.encode(line(1));
    if (p === "/gs/trace/2024001/chat/2026-10-13.jsonl") return enc.encode(line(1) + line(2));
    if (p.endsWith("archive-state.json")) return enc.encode("{}");
    throw new Error("missing: " + p);
  });
  vi.mocked(vscode.workspace.fs.createDirectory).mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.fs.writeFile).mockResolvedValue(undefined);
}

function makeArchiver() {
  return createTraceArchiver({
    globalStorageUri: { fsPath: "/gs", toString: () => "file:///gs" } as never,
    teacherUrl: () => "http://t:3000/",
    isEnabled: () => true,
  });
}

const stubFetch = (impl: (...a: unknown[]) => unknown) =>
  vi.stubGlobal("fetch", vi.fn(impl) as unknown as typeof fetch) as unknown as ReturnType<typeof vi.fn>;
const stateWrites = () =>
  vi.mocked(vscode.workspace.fs.writeFile).mock.calls.filter((c) => (c[0] as { path: string }).path.endsWith("archive-state.json"));
const lastOffsets = () =>
  JSON.parse(new TextDecoder().decode(stateWrites().at(-1)![1] as Uint8Array));

beforeEach(() => {
  seedFs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TraceArchiver.runOnce", () => {
  it("2xx → 两批全部上传，批次字段齐全，位点推进并落 archive-state.json", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url1).toBe("http://t:3000/api/trace/archive");
    expect(JSON.parse(init1.body as string)).toMatchObject({
      student_id: "2024001", student_name: "张三", class_id: "default", surface: "edit", date: "2026-10-13",
    });
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).events).toHaveLength(2);
    expect(lastOffsets()[EDIT_KEY]).toBe(enc.encode(line(1)).length);
    expect(lastOffsets()[CHAT_KEY]).toBe(enc.encode(line(1) + line(2)).length);
    archiver.dispose();
  });

  it("5xx → 本轮中止：第一批失败后第二批不再 fetch，位点不动", async () => {
    const fetchMock = stubFetch(() => new Response("err", { status: 500 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stateWrites()).toHaveLength(0);
    archiver.dispose();
  });

  it("400 → 该文件位点跳到扫描时文件尾，其余文件继续", async () => {
    const fetchMock = stubFetch(() => new Response("bad", { status: 400 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastOffsets()[EDIT_KEY]).toBe(enc.encode(line(1)).length);
    expect(lastOffsets()[CHAT_KEY]).toBe(enc.encode(line(1) + line(2)).length);
    archiver.dispose();
  });

  it("网络异常 → 本轮中止，位点不动", async () => {
    const fetchMock = stubFetch(() => { throw new Error("ECONNREFUSED"); });
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stateWrites()).toHaveLength(0);
    archiver.dispose();
  });

  it("isEnabled=false → 不扫描不上传", async () => {
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = createTraceArchiver({
      globalStorageUri: { fsPath: "/gs", toString: () => "file:///gs" } as never,
      teacherUrl: () => "http://t:3000",
      isEnabled: () => false,
    });
    await archiver.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
    archiver.dispose();
  });

  it("identity.json 缺失 → 学号跳过，无 fetch", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue(new Error("missing"));
    const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
    const archiver = makeArchiver();
    await archiver.runOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    archiver.dispose();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/test/archive/archiver.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 archiver**

```ts
// src/archive/archiver.ts
// 归档调度器：启动 10s 首扫 + 每 60 分钟一轮（spec §4.4，不做事件驱动/高频推送）。
// 每轮：读位点 → batcher 扫描切批 → 按批 POST /api/trace/archive → 2xx/400 推进位点。
// 触发频率只影响服务器数据新鲜度；本地 JSONL 是事实源，断网/崩溃后下轮自动补传（spec §2/§6）。
import * as vscode from "vscode";
import { parseOffsets, serializeOffsets, OFFSETS_FILE } from "./archiveState";
import {
  planBatches,
  type ArchiveFs,
  type BatchIdentity,
} from "./batcher";

const STARTUP_DELAY_MS = 10_000;

export interface TraceArchiverDeps {
  globalStorageUri: vscode.Uri;
  /** 每次触发时读取（跟随配置变化），复用 pylearner.teacher.url */
  teacherUrl: () => string;
  /** 归档开关，复用 pylearner.teacher.enabled（spec §4.7） */
  isEnabled: () => boolean;
  log?: (msg: string) => void;
}

export interface TraceArchiver extends vscode.Disposable {
  /** 立即执行一轮（测试/手动入口） */
  runOnce(): Promise<void>;
}

export function createTraceArchiver(deps: TraceArchiverDeps): TraceArchiver {
  const traceRoot = vscode.Uri.joinPath(deps.globalStorageUri, "trace");
  const child = (rel: string): vscode.Uri =>
    vscode.Uri.joinPath(traceRoot, ...rel.split("/"));

  // ArchiveFs 的 vscode.workspace.fs 运行时适配（rel → Uri）
  const fsx: ArchiveFs = {
    async listDirs(rel) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(child(rel));
        return entries.filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n);
      } catch {
        return [];
      }
    },
    async listFiles(rel) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(child(rel));
        return entries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n);
      } catch {
        return [];
      }
    },
    async readFileBytes(rel) {
      try {
        return await vscode.workspace.fs.readFile(child(rel));
      } catch {
        return null;
      }
    },
    async writeFileBytes(rel, data) {
      const parent = rel.split("/").slice(0, -1).join("/");
      if (parent) {
        try {
          await vscode.workspace.fs.createDirectory(child(parent));
        } catch {
          // exists
        }
      }
      await vscode.workspace.fs.writeFile(child(rel), data);
    },
  };

  /** 学号目录 → 批次身份；.identity.json 缺失/损坏/与目录不符 → null（跳过该学号） */
  async function readIdentity(studentId: string): Promise<BatchIdentity | null> {
    const raw = await fsx.readFileBytes(`${studentId}/.identity.json`);
    if (!raw) return null;
    try {
      const p = JSON.parse(new TextDecoder().decode(raw)) as Partial<BatchIdentity>;
      if (p.studentId !== studentId || !p.studentName) return null;
      return {
        studentId,
        studentName: p.studentName,
        classId: typeof p.classId === "string" && p.classId ? p.classId : "default",
      };
    } catch {
      return null;
    }
  }

  let running = false;

  async function saveOffsets(offsets: Record<string, number>): Promise<void> {
    await fsx.writeFileBytes(OFFSETS_FILE, new TextEncoder().encode(serializeOffsets(offsets)));
  }

  async function runOnce(): Promise<void> {
    if (running || !deps.isEnabled()) return;
    running = true;
    try {
      const stateRaw = await fsx.readFileBytes(OFFSETS_FILE);
      const stored = parseOffsets(stateRaw ? new TextDecoder().decode(stateRaw) : null);
      const plan = await planBatches(fsx, stored, readIdentity);
      const offsets = plan.offsets;
      if (plan.jobs.length === 0) return;

      const url = deps.teacherUrl().replace(/\/+$/, "") + "/api/trace/archive";
      let dirty = false;
      for (const job of plan.jobs) {
        // 同文件前面的批次已因 400 跳尾 → 后续批次跳过
        if ((offsets[job.fileKey] ?? 0) >= job.fileEnd) continue;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              student_id: job.identity.studentId,
              student_name: job.identity.studentName,
              class_id: job.identity.classId,
              surface: job.surface,
              date: job.date,
              events: job.events,
            }),
          });
          if (res.ok) {
            offsets[job.fileKey] = job.endOffset;
            dirty = true;
          } else if (res.status === 400) {
            // 数据本身有问题，重试无意义 → 跳到扫描时文件尾（spec §4.6）
            offsets[job.fileKey] = job.fileEnd;
            dirty = true;
            deps.log?.(`[archive] 400 拒收 ${job.fileKey}，位点跳到文件尾`);
          } else {
            // 5xx/其它 → 本轮中止，位点不动，下轮续传
            deps.log?.(`[archive] 上报失败 ${res.status} ${job.fileKey}，本轮中止`);
            break;
          }
        } catch (err) {
          deps.log?.(`[archive] 网络异常，本轮中止：${err instanceof Error ? err.message : String(err)}`);
          break;
        } finally {
          if (dirty) {
            try {
              await saveOffsets(offsets);
            } catch (err) {
              deps.log?.(`[archive] 位点写入失败：${err instanceof Error ? err.message : String(err)}`);
            }
            dirty = false;
          }
        }
      }
    } finally {
      running = false;
    }
  }

  // 仅激活后延迟 10s 归档一次（spec §4.4）；无定时器/事件驱动，零后台常驻
  const startup = setTimeout(() => {
    void runOnce().catch((err: unknown) =>
      deps.log?.(`[archive] 启动归档失败：${err instanceof Error ? err.message : String(err)}`)
    );
  }, STARTUP_DELAY_MS);

  return {
    runOnce,
    dispose() {
      clearTimeout(startup);
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/test/archive/archiver.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/archive/archiver.ts src/test/archive/archiver.test.ts
git commit -m "feat(archive): 归档调度器——激活后 10s 归档一次，2xx/400 推进位点、5xx/断网下次激活续传"
```

---

### Task 7: 装配 + 打开数据文件夹命令

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3 `setIdentityProvider`、Task 6 `createTraceArchiver`、现有 `getIdentity`（extension.ts:142）、现有 `identityDeps.teacherUrl`（extension.ts:212）
- Produces: 激活即生效的归档链路；命令 `pylearner.openDataFolder`

- [ ] **Step 1: constants.ts 加命令 id**

`CMD_IDS` 对象（`src/constants.ts`）加一行：

```ts
  openDataFolder: "pylearner.openDataFolder",
```

- [ ] **Step 2: package.json 注册命令**

`contributes.commands` 数组（第 46 行起）加：

```json
      {
        "command": "pylearner.openDataFolder",
        "title": "Python Learner: 打开数据文件夹"
      },
```

- [ ] **Step 3: extension.ts 装配**

1. import 区（`createTeacherReporter` 之后）加：

```ts
import { createTraceArchiver } from "./archive/archiver";
```

2. `const getIdentity = ...`（第 142 行附近）之后、`applyTeacherReporter` 定义之前，加一行（归档与分析共用同一身份源，spec §4.1）：

```ts
  l1Writer.setIdentityProvider(getIdentity);
```

3. `identityDeps` 定义（第 211 行附近）之后加：

```ts
  // —— L1 全量归档（spec：docs/superpowers/specs/2026-10-13-l1-trace-archive-design.md）——
  // 激活后 10s 归档一次（无定时器）；复用 teacher.url / teacher.enabled；失败静默下次激活补传
  context.subscriptions.push(
    createTraceArchiver({
      globalStorageUri: context.globalStorageUri,
      teacherUrl: identityDeps.teacherUrl,
      isEnabled: () =>
        vscode.workspace
          .getConfiguration("pylearner")
          .get<boolean>(CONFIG_KEYS.teacherEnabled, true),
      log: (msg) => outputChannel.appendLine(msg),
    })
  );
```

4. 命令注册（`openSettings` 注册块之后）加：

```ts
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openDataFolder, () => {
        void vscode.commands.executeCommand("revealInExplorer", context.globalStorageUri);
      })
    );
    log("[pylearner] openDataFolder command registered");
  } catch (err) {
    log("[pylearner] failed to register openDataFolder command:", err);
    throw err;
  }
```

- [ ] **Step 4: 类型检查 + 全量测试 + 构建**

Run: `npx tsc --noEmit` ；`npx vitest run` ；`npm run compile`
Expected: 全部通过，esbuild 构建成功

- [ ] **Step 5: 提交**

```bash
git add src/constants.ts src/extension.ts package.json
git commit -m "feat(archive): 装配 L1 全量归档链路 + 打开数据文件夹命令"
```

---

## 手工验证清单（Task 7 之后，F5 Extension Development Host）

1. 设置学号/姓名 → 写几行 Python、保存、跑一次 → 检查 globalStorage 下出现 `trace/<学号>/edit/...` 与 `.identity.json`
2. 服务器（classroom-assistant）启动后 10s，观察 outputChannel `[archive]` 无报错；服务器 `data/trace/<classId>/<学号>/` 出现归档文件
3. 断开服务器重启扩展 → 位点不推进；恢复后下一轮自动补齐
4. 换学号再写代码 → 新事件落新学号目录，旧学号数据在下一轮被归档到旧学号名下
