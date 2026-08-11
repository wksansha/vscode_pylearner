import { useState, useCallback, useRef, useEffect } from "react";
import type { ChatMessage, LlmConfig } from "../types/messages";
import { useStream } from "./useStream";

const vscode = acquireVsCodeApi();

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [config, setConfig] = useState<LlmConfig>({
    provider: "vscode-lm",
    model: "",
    apiKey: "",
    baseUrl: "",
  });
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());
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

        case "newChat":
          setMessages([]);
          sessionIdRef.current = crypto.randomUUID();
          setError(null);
          break;
      }
    };

    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getConfig" });
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
      // Remove failed assistant message
      setMessages((prev) => {
        const idx = prev.findLastIndex((m) => m.role === "assistant");
        if (idx > -1) return prev.slice(0, idx);
        return prev;
      });
      sendMessage(lastUserMsg.text);
    }
  }, [messages, sendMessage]);

  const newChat = useCallback(() => {
    setMessages([]);
    sessionIdRef.current = crypto.randomUUID();
    setError(null);
    vscode.postMessage({ type: "newChat" });
  }, []);

  const saveConfig = useCallback(
    (partial: Partial<LlmConfig>) => {
      vscode.postMessage({ type: "saveConfig", config: partial });
    },
    []
  );

  return {
    messages,
    config,
    error,
    isStreaming,
    streamingText,
    sendMessage,
    retry,
    newChat,
    saveConfig,
  };
}
