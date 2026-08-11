export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: string;
  model?: string;
  isStreaming?: boolean;
}

export type WebviewMessage =
  | { type: "chat"; text: string; sessionId: string }
  | { type: "getConfig" }
  | { type: "saveConfig"; config: Partial<LlmConfig> }
  | { type: "abort" };

export type HostMessage =
  | { type: "stream"; chunk: string; sessionId: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string }
  | { type: "config"; config: LlmConfig }
  | { type: "newChat" };
