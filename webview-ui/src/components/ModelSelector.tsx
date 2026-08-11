import React from "react";
import type { LlmConfig } from "../types/messages";

interface Props {
  config: LlmConfig;
  onSaveConfig: (partial: Partial<LlmConfig>) => void;
}

const PROVIDERS = [
  { value: "vscode-lm", label: "VS Code LM" },
  { value: "ollama", label: "Ollama" },
  { value: "openai", label: "OpenAI" },
];

export const ModelSelector: React.FC<Props> = ({ config, onSaveConfig }) => {
  return (
    <select
      value={config.provider}
      onChange={(e) => onSaveConfig({ provider: e.target.value })}
      className="bg-gray-700 text-gray-100 text-xs rounded px-2 py-1
                 border border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {PROVIDERS.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );
};
