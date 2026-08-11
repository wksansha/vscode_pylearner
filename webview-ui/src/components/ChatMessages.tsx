import React, { useRef, useEffect } from "react";
import type { ChatMessage } from "../types/messages";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Props {
  messages: ChatMessage[];
  streamingText: string;
  isStreaming: boolean;
}

export const ChatMessages: React.FC<Props> = ({
  messages,
  streamingText,
  isStreaming,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[85%] rounded-lg px-3 py-2 ${
              msg.role === "user"
                ? "bg-blue-600 text-white"
                : "bg-gray-700 text-gray-100"
            }`}
          >
            {msg.isStreaming ? (
              <MarkdownRenderer>
                {streamingText || "..."}
              </MarkdownRenderer>
            ) : (
              <MarkdownRenderer>{msg.text}</MarkdownRenderer>
            )}
            <div
              className={`text-xs mt-1 ${
                msg.role === "user" ? "text-blue-200" : "text-gray-400"
              }`}
            >
              {new Date(msg.ts).toLocaleTimeString()}
              {msg.model && ` · ${msg.model}`}
            </div>
          </div>
        </div>
      ))}
      {messages.length === 0 && !isStreaming && (
        <div className="text-center text-gray-400 mt-8">
          <p className="text-lg">🐍 Python Learner</p>
          <p className="text-sm mt-2">
            Ask me anything about Python — I learn from how you code.
          </p>
        </div>
      )}
    </div>
  );
};
