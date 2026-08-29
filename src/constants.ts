export const CMD_IDS = {
  openChat: "pylearner.openChat",
  newChat: "pylearner.newChat",
  toggleMonitor: "pylearner.toggleMonitor",
  openSettings: "pylearner.openSettings",
  updateProfile: "pylearner.updateProfile",
  memoryGraph: "pylearner.memoryGraph",
} as const;

export const VIEW_IDS = {
  sidebarContainer: "pylearner-sidebar",
  chatView: "pylearner.chatView",
  profileView: "pylearner.profileView",
} as const;

export const CONFIG_KEYS = {
  llmProvider: "pylearner.llm.provider",
  llmModel: "pylearner.llm.model",
  llmBaseUrl: "pylearner.llm.baseUrl",
  monitorEdit: "pylearner.monitor.editEnabled",
  monitorRun: "pylearner.monitor.runEnabled",
  autoRefreshThreshold: "pylearner.memory.autoRefreshThreshold",
  autoRefreshCooldownMs: "pylearner.memory.autoRefreshCooldownMs",
} as const;

// API key lives in SecretStorage (never in settings.json — Settings Sync
// would copy it to the user's account otherwise).
export const SECRET_KEYS = {
  llmApiKey: "pylearner.llm.apiKey",
} as const;

export const MSG_TYPES = {
  // Webview → Host
  chat: "chat",
  getConfig: "getConfig",
  saveConfig: "saveConfig",
  abort: "abort",
  loadSessions: "loadSessions",
  loadSession: "loadSession",
  deleteSession: "deleteSession",
  // Host → Webview
  stream: "stream",
  done: "done",
  error: "error",
  config: "config",
  monitorStatus: "monitorStatus",
  sessionsList: "sessionsList",
  sessionLoaded: "sessionLoaded",
  // Profile panel (Webview → Host)
  getProfile: "getProfile",
  updateProfile: "updateProfile",
  // Profile panel (Host → Webview)
  profile: "profile",
  // Memory graph (Webview → Host)
  getMemoryGraph: "getMemoryGraph",
  // Memory graph (Host → Webview)
  memoryGraphData: "memoryGraphData",
} as const;

export const EVENT_KINDS = {
  runSuccess: "execution_success",
  runError: "execution_error",
  debugSessionStart: "session_start",
  debugSessionEnd: "session_end",
  breakpointChange: "breakpoint_change",
  fileSave: "file_save",
  diagnosticsChange: "diagnostics_change",
} as const;

export const SURFACES = ["edit", "run", "chat", "debug", "diag"] as const;
export type Surface = (typeof SURFACES)[number];

export const STORAGE_DIRS = {
  trace: "trace", // trace/<surface>/YYYY-MM-DD.jsonl
  chats: "chats", // chats/sessions/<id>.json, chats/index.json
} as const;