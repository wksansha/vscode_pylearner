/**
 * OpenAI 兼容 SSE 流解析（openai.ts / teacher.ts 共用）。
 * 逐行解析 "data: {...}" / "data: [DONE]"，把 delta.content 通过 onChunk 吐给调用方。
 */
export async function consumeSseStream(
  resp: Response,
  onChunk: (text: string) => void
): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body from SSE stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {
        // skip malformed SSE lines
      }
    }
  }
}
