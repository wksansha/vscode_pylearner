import React, { useEffect, useState } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { ProfileSnapshot } from "../types/messages";

const vscode = acquireVsCodeApi();

// Read-only preview of the synthesized L3 learner profile. The host owns the
// profile.md content; this panel asks for it on mount and re-renders whatever
// snapshot comes back.
export const ProfilePanel: React.FC = () => {
  const [snapshot, setSnapshot] = useState<ProfileSnapshot | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as Record<string, unknown>;
      if (msg.type === "profile") {
        setSnapshot(msg.snapshot as ProfileSnapshot);
        setUpdating(false);
      } else if (msg.type === "error") {
        setError(msg.message as string);
        setUpdating(false);
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "getProfile" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const refresh = () => vscode.postMessage({ type: "getProfile" });
  const update = () => {
    setUpdating(true);
    setError(null);
    vscode.postMessage({ type: "updateProfile" });
  };

  const hasProfile = snapshot?.exists === true;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-600">
        <span className="text-sm font-semibold">🧠 Learner Profile</span>
        <div className="flex items-center gap-2">
          {snapshot?.updatedAt && (
            <span className="text-[10px] text-gray-400">
              {new Date(snapshot.updatedAt).toLocaleString()}
            </span>
          )}
          <button
            onClick={refresh}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
            title="Refresh"
          >
            ↻
          </button>
          <button
            onClick={update}
            disabled={updating}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
            title="Update profile from learning activity"
          >
            {updating ? "…" : "Update"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 px-3 py-2 bg-red-900/50 border border-red-700 rounded text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {!hasProfile ? (
          <div className="text-center text-gray-400 mt-8">
            <p className="text-lg">🧠 No learner profile yet</p>
            <p className="text-sm mt-2">
              Click <b>Update</b> to synthesize a profile from your learning
              activity (edits, runs, debug, chat, diagnostics).
            </p>
          </div>
        ) : (
          <MarkdownRenderer>{snapshot!.markdown}</MarkdownRenderer>
        )}
      </div>
    </div>
  );
};
