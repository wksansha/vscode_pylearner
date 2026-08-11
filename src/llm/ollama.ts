import type { LlmBackend, LlmMessage } from "./router";
import type { LlmConfig } from "../settings/config";

export class OllamaBackend implements LlmBackend {
  name = "ollama";
  private baseUrl: string;
  private model: string;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.model = config.model || "codellama";
  }

  async chat(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const mapped = messages.map((m) => ({
      role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    const resp = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: mapped,
        stream: true,
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(
        `Ollama error (${resp.status}): ${body.slice(0, 500)}`
      );
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body from Ollama");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            onChunk(parsed.message.content);
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.message?.content) {
          onChunk(parsed.message.content);
        }
      } catch {}
    }
  }
}