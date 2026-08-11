import React, { useState, useCallback } from "react";

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}

export const ChatInput: React.FC<Props> = ({ onSend, disabled }) => {
  const [text, setText] = useState("");

  const handleSend = useCallback(() => {
    if (text.trim() && !disabled) {
      onSend(text);
      setText("");
    }
  }, [text, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="border-t border-gray-600 p-2">
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about Python..."
          disabled={disabled}
          rows={2}
          className="flex-1 bg-gray-800 text-gray-100 rounded px-3 py-2 resize-none
                     focus:outline-none focus:ring-1 focus:ring-blue-500
                     disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded
                     disabled:opacity-50 disabled:cursor-not-allowed
                     text-white font-medium self-end"
        >
          Send
        </button>
      </div>
    </div>
  );
};
