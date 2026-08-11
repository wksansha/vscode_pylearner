import type { LlmBackend, LlmMessage } from "./router";
import type { LlmConfig } from "../settings/config";

export class OpenAIBackend implements LlmBackend {
  name = "openai";
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model || "gpt-4o-mini";
  }

  async chat(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.apiKey) {
      throw new Error(
        "API key not configured. Set pylearner.llm.apiKey in Settings."
      );
    }

    const url = this.baseUrl.endsWith("/v1")
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

    const mapped = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: mapped,
        stream: true,
      }),
      signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI API error (${resp.status}): ${body.slice(0, 500)}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body from OpenAI API");

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
}