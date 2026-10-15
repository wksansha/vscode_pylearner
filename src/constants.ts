export const CMD_IDS = {
  openChat: "pylearner.openChat",
  newChat: "pylearner.newChat",
  toggleMonitor: "pylearner.toggleMonitor",
  openSettings: "pylearner.openSettings",
  updateProfile: "pylearner.updateProfile",
  resetProfile: "pylearner.resetProfile",
  memoryGraph: "pylearner.memoryGraph",
  setStudentIdentity: "pylearner.setStudentIdentity",
  submitExercise: "pylearner.submitExercise",
  pullAssignments: "pylearner.pullAssignments",
  syncAssignments: "pylearner.syncAssignments",
  openDataFolder: "pylearner.openDataFolder",
} as const;

export const VIEW_IDS = {
  sidebarContainer: "pylearner-sidebar",
  chatView: "pylearner.chatView",
  assignmentPanel: "pylearner.assignmentPanel",
} as const;

export const CONFIG_KEYS = {
  llmProvider: "pylearner.llm.provider",
  llmModel: "pylearner.llm.model",
  llmBaseUrl: "pylearner.llm.baseUrl",
  monitorEdit: "pylearner.monitor.editEnabled",
  monitorRun: "pylearner.monitor.runEnabled",
  autoRefreshThreshold: "pylearner.memory.autoRefreshThreshold",
  autoRefreshCooldownMs: "pylearner.memory.autoRefreshCooldownMs",
  teacherUrl: "pylearner.teacher.url",
  teacherEnabled: "pylearner.teacher.enabled",
  submissionEnabled: "pylearner.submission.enabled",
  gitRepoUrl: "pylearner.gitRepoUrl",
} as const;

// 课堂服务器地址（开发期默认本机 :3000，配合本机运行的 classroom-assistant 调试）。
// ⚠️ 学生机房部署前必须改回内网地址 http://192.168.1.100:3000 并重新打包；
// package.json 里 pylearner.teacher.url 的 default 与此保持一致；
// 特殊网络环境仍可用 settings.json 的 pylearner.teacher.url 覆盖。
export const DEFAULT_TEACHER_URL = "http://localhost:3000";

// API key lives in SecretStorage (never in settings.json — Settings Sync
// would copy it to the user's account otherwise).
export const SECRET_KEYS = {
  llmApiKey: "pylearner.llm.apiKey",
  gitToken: "pylearner.git.token",   // 学生专属 Gitea token（身份校验响应下发，spec 2.2）
  studentId: "pylearner.student.id",
  studentName: "pylearner.student.name",
  classId: "pylearner.student.classId",
} as const;

// 学号/姓名是身份不是机密，存 globalState（同步读、不依赖系统钥匙环）。
// 旧版本的 SECRET_KEYS.student* 若有值，激活时迁移到这里。
export const STATE_KEYS = {
  studentId: "pylearner.identity.studentId",
  studentName: "pylearner.identity.studentName",
} as const;

export const MSG_TYPES = {
  // Webview → Host
  chat: "chat",
  getConfig: "getConfig",
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
  typingSession: "typing_session",
} as const;

export const SURFACES = ["edit", "run", "chat", "debug", "diag", "behavior"] as const;
export type Surface = (typeof SURFACES)[number];

// Surfaces the L2/L3 consolidation pipeline actually processes. Narrowing
// this (instead of SURFACES) keeps L1 trace collection and the shortname-ref
// whitelist intact — edit/run/debug/behavior traces still accumulate on disk
// and can be folded back in by widening this list again.
export const CONSOLIDATION_SURFACES = ["chat", "diag"] as const;

export const STORAGE_DIRS = {
  trace: "trace", // trace/<surface>/YYYY-MM-DD.jsonl
  chats: "chats", // chats/sessions/<id>.json, chats/index.json
} as const;