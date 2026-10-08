import { describe, it, expect, vi } from "vitest";
import "../vscode-mock";
import { submitCode, type SubmissionDeps } from "../../submission/submissionReporter";
import type { KeyValueStore } from "../../identity/studentIdentity";

const FIXTURE = `# -*- coding: utf-8 -*-
# ===== classroom-assistant =====
# exercise-id: 3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4
# week: 1
# ===============================
# 题目：两数之和
# ===== 代码区 =====
print(3)
`;

function makeState(): KeyValueStore & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: (k: string) => store.get(k),
    update: async (k: string, v: unknown) => { store.set(k, v); },
  } as never;
}

function makeDeps(over: Partial<SubmissionDeps> = {}): SubmissionDeps {
  return {
    teacherUrl: () => "http://teacher:3000",
    getIdentity: () => ({ studentId: "0001", studentName: "张三" }),
    onIdentityMissing: vi.fn(),
    globalState: makeState(),
    fetchImpl: vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ submission: {} }) })) as unknown as typeof fetch,
    ...over,
  };
}

describe("submitCode 提交链（A3/A7/A8/A27）", () => {
  it("非练习文件 → not-exercise，不发请求", async () => {
    const deps = makeDeps();
    const r = await submitCode(deps, { filePath: "c:/x/plain.py", content: "print(1)", source: "auto" });
    expect(r).toBe("not-exercise");
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
  it("未设身份 → identity-missing + onIdentityMissing", async () => {
    const deps = makeDeps({ getIdentity: () => ({ studentId: null, studentName: null }) });
    const r = await submitCode(deps, { filePath: "c:/x/ex.py", content: FIXTURE, source: "auto" });
    expect(r).toBe("identity-missing");
    expect(deps.onIdentityMissing).toHaveBeenCalled();
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });
  it("dirty 文件先保存（A27）；提交 body 完整；防抖：同代码二次 skipped（A7）", async () => {
    const saveIfDirty = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ submission: {} }) })) as unknown as typeof fetch;
    const deps = makeDeps({ saveIfDirty, fetchImpl });
    const r1 = await submitCode(deps, { filePath: "c:/x/ex.py", content: FIXTURE, source: "auto" });
    expect(r1).toBe("submitted");
    expect(saveIfDirty).toHaveBeenCalledWith("c:/x/ex.py");
    const body = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body).toMatchObject({ exerciseId: "3f2b8c1a-9d4e-4f6a-b7c8-d9e0f1a2b3c4", studentId: "0001", source: "auto" });
    expect(body.code).toContain("print(3)");
    const r2 = await submitCode(deps, { filePath: "c:/x/ex.py", content: FIXTURE, source: "auto" });
    expect(r2).toBe("skipped");
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);   // 未重发
  });
  it("400 学号不在名册 → identity-missing（A8 终校验兜底）；网络错误 → error", async () => {
    const fetch403 = vi.fn(async () => ({
      ok: false, status: 400, json: async () => ({ error: "学号不在名册" }),
    })) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl: fetch403 });
    expect(await submitCode(deps, { filePath: "c:/x/ex.py", content: FIXTURE, source: "manual" })).toBe("identity-missing");
    expect(deps.onIdentityMissing).toHaveBeenCalled();
    const fetchDead = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const deps2 = makeDeps({ fetchImpl: fetchDead, globalState: makeState() });
    expect(await submitCode(deps2, { filePath: "c:/x/ex.py", content: FIXTURE, source: "auto" })).toBe("error");
  });
});
