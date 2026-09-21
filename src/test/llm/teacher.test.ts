import { describe, it, expect, vi, afterEach } from "vitest";
import { TeacherBackend } from "../../llm/teacher";

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

describe("TeacherBackend（经课堂服务器代理聊天）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST teacherUrl/api/llm/chat/completions，SSE 分块按序吐给 onChunk", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    vi.stubGlobal("fetch", fetchMock);

    const got: string[] = [];
    const backend = new TeacherBackend({
      teacherUrl: "http://10.0.0.5:3000/",
      getStudentId: () => "20240101",
    });
    await backend.chat([{ role: "user", content: "hi" }], (t) => got.push(t), new AbortController().signal);

    expect(got.join("")).toBe("你好");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.0.0.5:3000/api/llm/chat/completions");
    expect((init.headers as Record<string, string>)["X-Student-Id"]).toBe("20240101");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.model).toBeUndefined(); // model 由服务器统一改写
  });

  it("无学号时不带 X-Student-Id 头", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const backend = new TeacherBackend({ teacherUrl: "http://10.0.0.5:3000" });
    await backend.chat([{ role: "user", content: "hi" }], () => {}, new AbortController().signal);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Student-Id"]).toBeUndefined();
  });

  it("上游错误 → 抛出含状态码的错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("server not configured", { status: 503 })
    ));
    const backend = new TeacherBackend({ teacherUrl: "http://10.0.0.5:3000" });
    await expect(
      backend.chat([{ role: "user", content: "hi" }], () => {}, new AbortController().signal)
    ).rejects.toThrow("503");
  });
});
