import { useState, useCallback } from "react";
import type { ChatMessage } from "../types/messages";

export function useStream() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  const startStream = useCallback(() => {
    setIsStreaming(true);
    setStreamingText("");
  }, []);

  const appendChunk = useCallback((chunk: string) => {
    setStreamingText((prev) => prev + chunk);
  }, []);

  const endStream = useCallback((): ChatMessage => {
    setIsStreaming(false);
    const finalText = streamingText;
    setStreamingText("");
    return {
      id: `msg_${Date.now()}`,
      role: "assistant",
      text: finalText,
      ts: new Date().toISOString(),
    };
  }, [streamingText]);

  return { isStreaming, streamingText, startStream, appendChunk, endStream };
}
