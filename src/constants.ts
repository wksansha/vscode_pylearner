export const CMD_IDS = {
  openChat: "pylearner.openChat",
  newChat: "pylearner.newChat",
  toggleMonitor: "pylearner.toggleMonitor",
  openSettings: "pylearner.openSettings",
  updateProfile: "pylearner.updateProfile",
  resetProfile: "pylearner.resetProfile",
  memoryGraph: "pylearner.memoryGraph",
  setStudentIdentity: "pylearner.setStudentIdentity",
  devResetIdentity: "pylearner.dev.resetIdentity",   // 清除本机身份+凭证（模拟学生首启/机房重置）
  submitExercise: "pylearner.submitExercise",
  pullAssignments: "pylearner.pullAssignments",
  syncAssignments: "pylearner.syncAssignments",
  openDataFolder: "pylearner.openDataFolder",
  migrateLegacyTrace: "pylearner.migrateLegacyTrace", // 旧平铺练习记录迁移到学号布局（命令面板低频入口）
} as const;

export const VIEW_IDS = {
  sidebarContainer: "pylearner-sidebar",
  chatView: "pylearner.chatView",
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

// 课堂服务器地址（3.x 本地测试版：localhost 自动适配本机，无需关心热点/网卡实际 IP）。
// ⚠️ 学生机房/外网部署前改回实际服务端地址并重新打包（外网部署版 1.0.2 为 http://120.48.112.26:3002）；
// package.json 里 pylearner.teacher.url 的 default 与此保持一致；
// 特殊网络环境仍可用 settings.json 的 pylearner.teacher.url 覆盖。
export const DEFAULT_TEACHER_URL = "http://localhost:3000";

// API key lives in SecretStorage (never in settings.json — Settings Sync
// would copy it to the user's account otherwise).
export const SECRET_KEYS = {
  llmApiKey: "pylearner.llm.apiKey",
  gitSecret: "pylearner.git.secret",   // 学生 Gitea 密码（gitSecret，身份校验响应下发；git 操作「学号:密码」Basic 认证用）
  studentId: "pylearner.student.id",
  studentName: "pylearner.student.name",
  classId: "pylearner.student.classId",
} as const;

// 学号/姓名是身份不是机密，存 globalState（同步读、不依赖系统钥匙环）。
// 旧版本的 SECRET_KEYS.student* 若有值，激活时迁移到这里。
export const STATE_KEYS = {
  studentId: "pylearner.identity.studentId",
  studentName: "pylearner.identity.studentName",
  gitRepoUrl: "pylearner.identity.gitRepoUrl",   // 服务端身份校验响应下发的课堂仓库地址（学生机零配置）
  onboardingPending: "pylearner.onboarding.pending",   // 新手引导续跑标记：选完作业目录整窗重载后，激活流程消费它补确认+自动拉取
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