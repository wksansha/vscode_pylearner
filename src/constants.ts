export const CMD_IDS = {
  openChat: "pylearner.openChat",
  newChat: "pylearner.newChat",
  toggleMonitor: "pylearner.toggleMonitor",
  openSettings: "pylearner.openSettings",
} as const;

export const VIEW_IDS = {
  sidebarContainer: "pylearner-sidebar",
  chatView: "pylearner.chatView",
} as const;

export const CONFIG_KEYS = {
  llmProvider: "pylearner.llm.provider",
  llmModel: "pylearner.llm.model",
  llmApiKey: "pylearner.llm.apiKey",
  llmBaseUrl: "pylearner.llm.baseUrl",
  monitorEdit: "pylearner.monitor.editEnabled",
  monitorRun: "pylearner.monitor.runEnabled",
} as const;

export const MSG_TYPES = {
  // Webview → Host
  chat: "chat",
  getConfig: "getConfig",
  saveConfig: "saveConfig",
  abort: "abort",
  // Host → Webview
  stream: "stream",
  done: "done",
  error: "error",
  config: "config",
  monitorStatus: "monitorStatus",
} as const;

export const SURFACES = ["edit", "run", "chat"] as const;
export type Surface = (typeof SURFACES)[number];

export const STORAGE_DIRS = {
  trace: "trace", // trace/<surface>/YYYY-MM-DD.jsonl
  chats: "chats", // chats/sessions/<id>.json, chats/index.json
} as const;