import type { LlmBackend, LlmMessage } from "./router";
import type { LlmConfig } from "../settings/config";
import { consumeSseStream } from "./sse";

export class OpenAIBackend implements LlmBackend {
  name = "openai";
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(config: LlmConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey ?? "";
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

    // Some providers (e.g. Zhipu) put the API version in the base URL
    // (https://open.bigmodel.ai/api/v4); others expect us to append /v1
    // (https://api.openai.com). Don't double up the version segment.
    const base = this.baseUrl.replace(/\/+$/, "");
    const url = /\/v\d+$/.test(base)
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

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

    await consumeSseStream(resp, onChunk);
  }
}