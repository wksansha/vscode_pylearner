import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ChatMessage,
  ChatSessionSummary,
  LlmConfig,
  StoredMessage,
} from "../types/messages";
import { useStream } from "./useStream";

const vscode = acquireVsCodeApi();

// React needs a stable key per message; the stored messages don't carry one.
function toChatMessage(m: StoredMessage, index: number): ChatMessage {
  return {
    id: `hist_${m.ts}_${index}`,
    role: m.role,
    text: m.text,
    ts: m.ts,
    model: m.model,
  };
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [config, setConfig] = useState<LlmConfig>({
    provider: "vscode-lm",
    model: "",
    apiKey: "",
    baseUrl: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>(() =>
    crypto.randomUUID()
  );
  const sessionIdRef = useRef<string>(currentSessionId);
  const { isStreaming, streamingText, startStream, appendChunk, endStream } =
    useStream();

  // Use ref for streaming to avoid re-registering event listener
  const streamRef = useRef(streamingText);
  useEffect(() => { streamRef.current = streamingText; }, [streamingText]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;

      switch (msg.type) {
        case "stream":
          appendChunk(msg.chunk as string);
          break;

        case "done": {
          // Capture final text before endStream clears it
          const finalText = streamRef.current;
          setMessages((prev) => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg && lastMsg.isStreaming) {
              lastMsg.isStreaming = false;
              lastMsg.text = finalText;
              lastMsg.ts = new Date().toISOString();
            }
            return updated;
          });
          endStream();
          if (msg.sessionId) {
            sessionIdRef.current = msg.sessionId as string;
            setCurrentSessionId(msg.sessionId as string);
          }
          break;
        }

        case "error":
          setError(msg.message as string);
          endStream();
          // Remove streaming placeholder on error
          setMessages((prev) => prev.filter((m) => !m.isStreaming));
          break;

        case "config":
          setConfig(msg.config as LlmConfig);
          break;

        case "newChat": {
          const id = crypto.randomUUID();
          setMessages([]);
          sessionIdRef.current = id;
          setCurrentSessionId(id);
          setError(null);
          break;
        }

        case "sessionsList":
          setSessions(msg.sessions as ChatSessionSummary[]);
          break;

        case "sessionLoaded": {
          const stored = msg.messages as StoredMessage[];
          setMessages(stored.map(toChatMessage));
          sessionIdRef.current = msg.sessionId as string;
          setCurrentSessionId(msg.sessionId as string);
          setError(null);
          break;
        }
      }
    };

    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getConfig" });
    vscode.postMessage({ type: "loadSessions" });
    return () => window.removeEventListener("message", handler);
  }, [appendChunk, endStream]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || isStreaming) return;
      setError(null);

      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}`,
        role: "user",
        text: text.trim(),
        ts: new Date().toISOString(),
      };

      // Add a placeholder for the streaming assistant response
      const assistantPlaceholder: ChatMessage = {
        id: `msg_${Date.now() + 1}`,
        role: "assistant",
        text: "",
        ts: new Date().toISOString(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantPlaceholder]);
      startStream();

      vscode.postMessage({
        type: "chat",
        text: text.trim(),
        sessionId: sessionIdRef.current,
      });
    },
    [isStreaming, startStream]
  );

  const retry = useCallback(() => {
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMsg) {
      // Remove only the failed turn, never a valid completed assistant
      // answer from an earlier turn.
      setMessages((prev) => {
        // If the streaming placeholder is still present, drop it together
        // with its user message so the re-sent text isn't duplicated.
        const streamIdx = prev.findLastIndex((m) => m.isStreaming);
        if (streamIdx > -1) {
          const start =
            streamIdx > 0 && prev[streamIdx - 1].role === "user"
              ? streamIdx - 1
              : streamIdx;
          return prev.slice(0, start);
        }
        // No placeholder: the error handler already filtered it out, so only
        // the failed turn's user message remains. Remove that (not the last
        // assistant message, which may be a valid earlier answer).
        const lastUserIdx = prev.findLastIndex((m) => m.role === "user");
        if (lastUserIdx > -1) return prev.slice(0, lastUserIdx);
        return prev;
      });
      sendMessage(lastUserMsg.text);
    }
  }, [messages, sendMessage]);

  const newChat = useCallback(() => {
    const id = crypto.randomUUID();
    setMessages([]);
    sessionIdRef.current = id;
    setCurrentSessionId(id);
    setError(null);
  }, []);

  const refreshSessions = useCallback(() => {
    vscode.postMessage({ type: "loadSessions" });
  }, []);

  const loadSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "loadSession", sessionId });
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    vscode.postMessage({ type: "deleteSession", sessionId });
    // If the deleted session is the one on screen, start fresh.
    if (sessionIdRef.current === sessionId) {
      const id = crypto.randomUUID();
      setMessages([]);
      sessionIdRef.current = id;
      setCurrentSessionId(id);
      setError(null);
    }
  }, []);

  const saveConfig = useCallback(
    (partial: Partial<LlmConfig>) => {
      vscode.postMessage({ type: "saveConfig", config: partial });
    },
    []
  );

  return {
    messages,
    sessions,
    currentSessionId,
    config,
    error,
    isStreaming,
    streamingText,
    sendMessage,
    retry,
    newChat,
    loadSession,
    deleteSession,
    refreshSessions,
    saveConfig,
  };
}
