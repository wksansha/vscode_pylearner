import * as vscode from "vscode";
import { CONFIG_KEYS } from "../constants";

export interface LlmConfig {
  provider: string;
  model: string;
  baseUrl: string;
  // Optional here: the real value is resolved from SecretStorage at request
  // time (see messageHandler) and injected into the backend by LlmRouter.
  apiKey?: string;
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