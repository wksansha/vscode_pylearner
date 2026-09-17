import React, { useState, useCallback } from "react";
import type { LlmConfig } from "../types/messages";

interface Props {
  config: LlmConfig;
  onSaveConfig: (partial: Partial<LlmConfig>) => void;
  onClose: () => void;
}

export const SettingsPanel: React.FC<Props> = ({
  config,
  onSaveConfig,
  onClose,
}) => {
  const [model, setModel] = useState(config.model);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [teacherUrl, setTeacherUrl] = useState(config.teacherUrl);
  const [teacherEnabled, setTeacherEnabled] = useState(config.teacherEnabled);

  const handleSave = useCallback(() => {
    onSaveConfig({
      model,
      apiKey,
      baseUrl,
      teacherUrl,
      teacherEnabled,
    });
    onClose();
  }, [model, apiKey, baseUrl, teacherUrl, teacherEnabled, onSaveConfig, onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-4 w-[90%] max-w-sm">
        <h3 className="text-sm font-semibold mb-3">LLM Settings</h3>

        <label className="block text-xs text-gray-400 mb-1">Provider</label>
        <select
          value={config.provider}
          onChange={(e) => onSaveConfig({ provider: e.target.value })}
          className="w-full bg-gray-700 rounded px-2 py-1 mb-3 text-sm"
        >
          <option value="vscode-lm">VS Code LM</option>
          <option value="ollama">Ollama</option>
          <option value="openai">OpenAI</option>
        </select>

        <label className="block text-xs text-gray-400 mb-1">Model</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-4o-mini / codellama"
          className="w-full bg-gray-700 rounded px-2 py-1 mb-3 text-sm"
        />

        <label className="block text-xs text-gray-400 mb-1">API Key</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="w-full bg-gray-700 rounded px-2 py-1 mb-3 text-sm"
        />

        <label className="block text-xs text-gray-400 mb-1">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full bg-gray-700 rounded px-2 py-1 mb-4 text-sm"
        />

        <div className="border-t border-gray-700 pt-3 mt-2">
          <h4 className="text-xs font-semibold mb-2">教师端上报</h4>

          <label className="block text-xs text-gray-400 mb-1">教师服务器地址</label>
          <input
            type="text"
            value={teacherUrl}
            onChange={(e) => setTeacherUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full bg-gray-700 rounded px-2 py-1 mb-3 text-sm"
          />

          <label className="flex items-center gap-2 text-xs text-gray-300 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={teacherEnabled}
              onChange={(e) => setTeacherEnabled(e.target.checked)}
              className="accent-blue-500"
            />
            开启教师端上报（将学生 L1 trace 上报到教师服务器）
          </label>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1 text-sm bg-gray-600 hover:bg-gray-500 rounded"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
