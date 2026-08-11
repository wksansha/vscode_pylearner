import * as vscode from "vscode";
import { CONFIG_KEYS } from "../constants";

export interface LlmConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export interface MonitorConfig {
  editEnabled: boolean;
  runEnabled: boolean;
}

export interface PylearnerConfig {
  llm: LlmConfig;
  monitor: MonitorConfig;
}

function readLlmConfig(): LlmConfig {
  const cfg = vscode.workspace.getConfiguration();
  return {
    provider: cfg.get<string>(CONFIG_KEYS.llmProvider, "vscode-lm"),
    model: cfg.get<string>(CONFIG_KEYS.llmModel, ""),
    apiKey: cfg.get<string>(CONFIG_KEYS.llmApiKey, ""),
    baseUrl: cfg.get<string>(CONFIG_KEYS.llmBaseUrl, "http://localhost:11434"),
  };
}

function readMonitorConfig(): MonitorConfig {
  const cfg = vscode.workspace.getConfiguration();
  return {
    editEnabled: cfg.get<boolean>(CONFIG_KEYS.monitorEdit, true),
    runEnabled: cfg.get<boolean>(CONFIG_KEYS.monitorRun, true),
  };
}

export function getConfig(): PylearnerConfig {
  return {
    llm: readLlmConfig(),
    monitor: readMonitorConfig(),
  };
}

export function onConfigChange(
  callback: (config: PylearnerConfig) => void
): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("pylearner")) {
      callback(getConfig());
    }
  });
}