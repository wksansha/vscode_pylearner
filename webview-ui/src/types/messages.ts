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

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

// Messages persisted by the host (no React-key `id`, no `isStreaming`).
export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  ts: string;
  model?: string;
}

export interface ProfileSnapshot {
  exists: boolean;
  markdown: string;
  updatedAt: string | null;
}

export type GraphLayer = "L3" | "L2" | "L1";

export interface GraphNode {
  id: string;
  layer: GraphLayer;
  key: string;
  section?: string;
  text: string;
  label?: string;
  refs: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface CitationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type WebviewMessage =
  | { type: "chat"; text: string; sessionId: string }
  | { type: "getConfig" }
  | { type: "saveConfig"; config: Partial<LlmConfig> }
  | { type: "abort" }
  | { type: "loadSessions" }
  | { type: "loadSession"; sessionId: string }
  | { type: "deleteSession"; sessionId: string }
  | { type: "getProfile" }
  | { type: "updateProfile" }
  | { type: "getMemoryGraph" };

export type HostMessage =
  | { type: "stream"; chunk: string; sessionId: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string }
  | { type: "config"; config: LlmConfig }
  | { type: "newChat" }
  | { type: "sessionsList"; sessions: ChatSessionSummary[] }
  | { type: "sessionLoaded"; sessionId: string; messages: StoredMessage[] }
  | { type: "profile"; snapshot: ProfileSnapshot }
  | { type: "memoryGraphData"; graph: CitationGraph };
