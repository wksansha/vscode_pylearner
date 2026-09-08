import { getConfig } from "../settings/config";
import { VscodeLmBackend } from "./vscodeLm";
import { OllamaBackend } from "./ollama";
import { OpenAIBackend } from "./openai";

export interface LlmMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmBackend {
  name: string;
  chat(
    messages: LlmMessage[],
    onChunk: (text: string) => void,
    signal: AbortSignal
  ): Promise<void>;
}

export class LlmRouter {
  private _config?: ReturnType<typeof getConfig>["llm"];

  private get config() {
    if (!this._config) {
      this._config = getConfig().llm;
    }
    return this._config;
  }

  refreshConfig(): void {
    this._config = undefined;
  }

  resolve(apiKey = ""): LlmBackend {
    switch (this.config.provider) {
      case "ollama":
        return new OllamaBackend(this.config);
      case "openai":
        return new OpenAIBackend({ ...this.config, apiKey });
      case "vscode-lm":
      default:
        return new VscodeLmBackend();
    }
  }

  getModelName(): string {
    return this.config.model;
  }
}
