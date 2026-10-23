/**
 * LlmRouter teacher 分支接线（spec 2026-10-23）：
 * 服务端 LLM 代理按名册校验 X-Student-Id —— 依赖 router 把 getStudentId 透传给 TeacherBackend。
 * 此前 router 漏传导致请求头从未发出（服务端校验会拦下全班），此用例防回归。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { LlmRouter } from "../../llm/router";

vi.mock("../../settings/config", () => ({
  getConfig: () => ({
    llm: {
      provider: "teacher", model: "", baseUrl: "http://localhost:11434",
      teacherUrl: "http://10.0.0.5:3000", teacherEnabled: true,
    },
    monitor: { editEnabled: true, runEnabled: true },
  }),
}));

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("LlmRouter teacher 分支透传 getStudentId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("构造时传入 getStudentId → resolve 出的 backend 请求带 X-Student-Id 头", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: {"choices":[{"delta":{"content":"你"}}]}\n\n', "data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const router = new LlmRouter({ getStudentId: () => "2025001" });
    const got: string[] = [];
    await router.resolve().chat([{ role: "user", content: "hi" }], (t) => got.push(t), new AbortController().signal);

    expect(got.join("")).toBe("你");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Student-Id"]).toBe("2025001");
  });

  it("未传 getStudentId → 不带头（向后兼容）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const router = new LlmRouter();
    await router.resolve().chat([{ role: "user", content: "hi" }], () => {}, new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Student-Id"]).toBeUndefined();
  });

  it("getStudentId 返回 null/空 → 不带头（未设身份时）", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const router = new LlmRouter({ getStudentId: () => (null as unknown as string) || undefined });
    await router.resolve().chat([{ role: "user", content: "hi" }], () => {}, new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Student-Id"]).toBeUndefined();
  });
});
