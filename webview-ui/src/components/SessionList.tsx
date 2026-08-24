import React from "react";
import type { ChatSessionSummary } from "../types/messages";

interface Props {
  sessions: ChatSessionSummary[];
  currentSessionId: string | null;
  onLoad: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onClose: () => void;
}

const formatDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString()
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
};

export const SessionList: React.FC<Props> = ({
  sessions,
  currentSessionId,
  onLoad,
  onDelete,
  onClose,
}) => {
  return (
    <div className="border-b border-gray-600 bg-gray-800/95">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold text-gray-300">Chat History</span>
        <button
          onClick={onClose}
          className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 rounded"
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 && (
          <p className="text-xs text-gray-500 px-1 py-2">
            No saved chats yet.
          </p>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`group flex items-center justify-between rounded px-2 py-1.5 hover:bg-gray-700 cursor-pointer ${
              s.id === currentSessionId ? "bg-gray-700" : ""
            }`}
            onClick={() => onLoad(s.id)}
            title={s.title}
          >
            <div className="min-w-0">
              <div className="text-xs text-gray-200 truncate">{s.title}</div>
              <div className="text-[10px] text-gray-500">
                {formatDate(s.updatedAt)} · {s.messageCount} msgs
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              className="opacity-0 group-hover:opacity-100 text-xs px-1.5 py-0.5 text-gray-400 hover:text-red-300 hover:bg-red-900/40 rounded"
              title="Delete chat"
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
