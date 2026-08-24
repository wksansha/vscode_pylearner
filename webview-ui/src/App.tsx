import React, { useState } from "react";
import { useChat } from "./hooks/useChat";
import { ChatMessages } from "./components/ChatMessages";
import { ChatInput } from "./components/ChatInput";
import { ModelSelector } from "./components/ModelSelector";
import { SettingsPanel } from "./components/SettingsPanel";
import { SessionList } from "./components/SessionList";

const App: React.FC = () => {
  const {
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
  } = useChat();

  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-600">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">🐍 Python Learner</span>
          <ModelSelector config={config} onSaveConfig={saveConfig} />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              refreshSessions();
              setShowHistory((v) => !v);
            }}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
            title="Chat History"
          >
            ☰
          </button>
          <button
            onClick={newChat}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
            title="New Chat"
          >
            + New
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* Session List */}
      {showHistory && (
        <SessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onLoad={(id) => {
            loadSession(id);
            setShowHistory(false);
          }}
          onDelete={deleteSession}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* Messages */}
      <ChatMessages
        messages={messages}
        streamingText={streamingText}
        isStreaming={isStreaming}
      />

      {/* Error Banner */}
      {error && (
        <div className="mx-3 mb-1 px-3 py-2 bg-red-900/50 border border-red-700 rounded text-sm text-red-200 flex justify-between items-center">
          <span className="truncate">{error}</span>
          <button
            onClick={retry}
            className="ml-2 px-2 py-0.5 bg-red-700 hover:bg-red-600 rounded text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Input */}
      <ChatInput onSend={sendMessage} disabled={isStreaming} />

      {/* Settings Modal */}
      {showSettings && (
        <SettingsPanel
          config={config}
          onSaveConfig={saveConfig}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
};

export default App;
