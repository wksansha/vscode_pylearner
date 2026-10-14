// ===== 启动日志 - 写入固定目录，确保在崩溃时也能保存 =====
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function setupStartupLogger() {
  try {
    const logDir = process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs");

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFile = path.join(logDir, "extension-startup.log");
    const now = new Date().toISOString();

    fs.appendFileSync(logFile, `\n=== Extension Startup ===\n`);
    fs.appendFileSync(logFile, `[${now}] Process started (PID: ${process.pid})\n`);
    fs.appendFileSync(logFile, `[${now}] Node: ${process.version}, Platform: ${process.platform}\n`);
    fs.appendFileSync(logFile, `[${now}] Working directory: ${process.cwd()}\n`);
    fs.appendFileSync(logFile, `[${now}] Module loading...\n`);
  } catch (e) {
    // 最早阶段若写失败，只能后悔了
  }
}

// 模块级执行日志
setupStartupLogger();

import * as vscode from "vscode";
import { CMD_IDS, CONFIG_KEYS, SECRET_KEYS, VIEW_IDS } from "./constants";
import { L1Writer } from "./storage/l1Writer";
import { ChatStore } from "./storage/chatStore";
import { LlmRouter } from "./llm/router";
import { ChatViewProvider } from "./chat/chatProvider";
import { createEditListener } from "./events/editListener";
import { createRunListener } from "./events/runListener";
import { createDiagnosticsListener } from "./events/diagnosticsListener";
import { createBehaviorListener } from "./events/behaviorListener";
import { registerUpdateProfileCommand, registerResetProfileCommand } from "./commands/updateProfile";
import { ProfileRefresher } from "./commands/autoRefresh";
import { registerMemoryGraphCommand } from "./commands/memoryGraph";
import { createTeacherReporter } from "./teacher/reporter";
import { createTraceArchiver } from "./archive/archiver";
import { loadStudentIdentity, migrateLegacyIdentity } from "./identity/studentIdentity";
import { openIdentityPage, maybeOpenIdentityPage } from "./identity/identityPage";
import { createSessionConfirmGate } from "./identity/sessionConfirm";
import {
  type SubmissionDeps,
} from "./submission/submissionReporter";
import { makeSubmitCommand, type SubmitCommandDeps } from "./submission/submitCommand";
import { collectSubmissionTargets } from "./submission/collectTargets";
import { makeRestoreCommand, restoreSubmissions } from "./commands/restoreSubmissions";
import { makeRunPull, pullAssignments } from "./pull/pullCommand";
import { confirmAndArchive, clearAndRefill } from "./identity/switchFlow";
import { createAssignmentPanel } from "./views/assignmentPanel";
import { makeRunSuccessReviewer } from "./submission/reviewRequester";
import { buildProjectSnapshot as buildProjectSnapshotImpl } from "./submission/projectSnapshot";

// Global error handlers to prevent uncaught exceptions from crashing the extension host
process.on("uncaughtException", (err) => {
  const now = new Date().toISOString();
  const logFile = path.join(
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs"),
    "extension-startup.log"
  );
  const stack = err instanceof Error ? err.stack ?? String(err) : String(err);
  fs.appendFileSync(
    logFile,
    `[${now}] UNCAUGHT EXCEPTION: ${stack}\n`
  );
  console.error("[pylearner] UNCAUGHT EXCEPTION:", stack);
});

process.on("unhandledRejection", (reason) => {
  const now = new Date().toISOString();
  const logFile = path.join(
    process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
      : path.join(os.homedir(), ".python-learner", "logs"),
    "extension-startup.log"
  );
  const detail =
    reason instanceof Error ? reason.stack ?? String(reason) : String(reason);
  fs.appendFileSync(
    logFile,
    `[${now}] UNHANDLED REJECTION: ${detail}\n`
  );
  console.error("[pylearner] UNHANDLED REJECTION:", detail);
});

let chatProvider: ChatViewProvider;
let outputChannel: vscode.OutputChannel;

function log(message: string, ...args: unknown[]): void {
  console.log(message, ...args);
  if (outputChannel) {
    outputChannel.appendLine(message);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log("Python Learner extension activated");

  try {
    outputChannel = vscode.window.createOutputChannel("Python Learner");
    context.subscriptions.push(outputChannel);
    log("[pylearner] output channel created");
  } catch (err) {
    log("[pylearner] failed to create output channel:", err);
    void vscode.window.showErrorMessage(
      `Python Learner activation failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
    return;
  }

  try {
    await activateCore(context);
    log("[pylearner] activation complete, listeners registered");
  } catch (err) {
    log("[pylearner] activation failed:", err);
    void vscode.window.showErrorMessage(
      `Python Learner activation failed: ${
        err instanceof Error ? err.stack ?? err.message : String(err)
      }`
    );
  }
}

async function activateCore(context: vscode.ExtensionContext): Promise<void> {
  // Initialize core services - DEFER router creation until first use
  const l1Writer = new L1Writer(context.globalStorageUri);
  const chatStore = new ChatStore(context.globalStorageUri);
  log("[pylearner] core services initialized");

  // 共享身份读取（A8）：无 machineId/"Unknown" 回退，未设身份时为 null，由消费方（reporter/提交链）门控
  // 身份在每次调用时读取（学号/姓名修改后下一次上报/提交立即生效）
  const getIdentity = () => {
    const id = loadStudentIdentity(context.globalState);
    return { studentId: id.studentId, studentName: id.studentName }; // 可能为 null
  };
  // 归档与分析共用同一身份源（spec §4.1）
  l1Writer.setIdentityProvider(getIdentity);

  // 初始化教师端上报器（如果启用）
  let currentReporter: ReturnType<typeof createTeacherReporter> | undefined;
  async function applyTeacherReporter() {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    const enabled = cfg.get<boolean>(CONFIG_KEYS.teacherEnabled, true);
    if (enabled) {
      const teacherUrl =
        cfg.get<string>(CONFIG_KEYS.teacherUrl, "http://localhost:3000") ||
        "http://localhost:3000";
      currentReporter = createTeacherReporter({ teacherUrl, getIdentity });
      l1Writer.setTeacherReporter(currentReporter);
      log("[pylearner] teacher reporter enabled");
    } else {
      currentReporter = undefined;
      l1Writer.setTeacherReporter(undefined);
      log("[pylearner] teacher reporter disabled");
    }
  }
  applyTeacherReporter();

  // 监听教师端配置变化，动态开关上报
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("pylearner.teacher.enabled") ||
        e.affectsConfiguration("pylearner.teacher.url")
      ) {
        applyTeacherReporter();
      }
    })
  );

  // ── 学生身份：状态栏 + 修改命令 + 首启弹窗 ──────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = "课堂身份";
  statusBar.command = CMD_IDS.setStudentIdentity;
  let sessionGate: ReturnType<typeof createSessionConfirmGate> | undefined;
  const updateStatusBar = () => {
    const id = loadStudentIdentity(context.globalState);
    statusBar.text = id.studentId
      ? (sessionGate?.isConfirmed()
          ? `$(account) ${id.studentId} ${id.studentName ?? ""}`.trim()
          : `$(warning) ${id.studentId} ${id.studentName ?? ""} ?`.trim())
      : "$(account) 设置学号";
    statusBar.tooltip = sessionGate?.isConfirmed()
      ? "课堂助手身份：点击设置学号/姓名"
      : "身份待确认：点击任意作业按钮时确认，或点击此处重新设置";
    statusBar.show();
  };
  context.subscriptions.push(statusBar);

  // 共享电脑防误用（spec §5.5/§5.6）：每窗口会话首次点作业按钮时确认身份
  sessionGate = createSessionConfirmGate({
    vscode,
    getIdentity,
    onSwitchIdentity: () => openIdentityPage(identityDeps, context),
    onConfirmed: () => updateStatusBar(),
  });
  updateStatusBar();

  // —— 作业系统装配（A1/A3/A8/A25/A26/A27）——
  const identityDeps = {
    teacherUrl: () =>
      vscode.workspace
        .getConfiguration("pylearner")
        .get<string>(CONFIG_KEYS.teacherUrl, "http://localhost:3000"),
    onSaved: () => { sessionGate?.reset(); updateStatusBar(); },
    // 一键换机：身份页校验通过且学号变化时触发（编排逻辑见 switchFlow.ts；submissionDeps 在下方声明，调用时已初始化）
    switchFlow: {
      beforeSwitch: (oldId: string, newId: string) =>
        confirmAndArchive(
          {
            // collectTargets 等字段是激活时动态附加的，声明类型未含 → 按 SubmitCommandDeps 断言
            ...(submissionDeps as SubmitCommandDeps),
            rootFsPath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            confirm: async ({ oldId, newId, count }) => {
              const pick = await vscode.window.showInformationMessage(
                `检测到身份切换：${oldId} → ${newId}\n将先归档当前工作区 ${count} 个练习，然后清空作业目录、拉取最新作业并恢复你的历史提交。`,
                { modal: true },
                "继续切换",
                "取消",
              );
              return pick === "继续切换";
            },
            notify: (m: string, warn: boolean) =>
              void (warn ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)),
          },
          oldId,
          newId,
        ),
      afterSwitch: () =>
        clearAndRefill({
          listEntries: async () => {
            const root = vscode.workspace.workspaceFolders?.[0];
            if (!root) return null;
            const entries = await vscode.workspace.fs.readDirectory(root.uri);
            return entries.map(([name, type]) => [name, type === vscode.FileType.Directory] as [string, boolean]);
          },
          deleteDir: async (name: string) => {
            const root = vscode.workspace.workspaceFolders?.[0];
            if (!root) return;
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(root.uri, name), { recursive: true });
          },
          pull: async () => {
            const root = vscode.workspace.workspaceFolders?.[0];
            if (!root) throw new Error("请先打开课堂文件夹");
            return pullAssignments({
              teacherUrl: identityDeps.teacherUrl,
              globalState: context.globalState,
              fileExists: async (rel) => {
                try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, rel)); return true; } catch { return false; }
              },
              writeFile: async (rel, content) => {
                const target = vscode.Uri.joinPath(root.uri, rel);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
                await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
              },
            });
          },
          restore: async () => {
            const root = vscode.workspace.workspaceFolders?.[0];
            if (!root) throw new Error("请先打开课堂文件夹");
            const r = await restoreSubmissions({
              teacherUrl: identityDeps.teacherUrl,
              getStudentId: () => loadStudentIdentity(context.globalState).studentId,
              readFile: async (rel) => {
                try {
                  return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, rel)));
                } catch {
                  return null;
                }
              },
              writeFile: async (rel, content) => {
                const target = vscode.Uri.joinPath(root.uri, rel);
                await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
                await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
              },
            });
            return { restored: r.restored.length };
          },
          notify: (m: string, warn: boolean) =>
            void (warn ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)),
        }),
    },
  };
  // —— L1 全量归档（spec：docs/superpowers/specs/2026-10-13-l1-trace-archive-design.md）——
  // 激活后 10s 归档一次（无定时器）；复用 teacher.url / teacher.enabled；失败静默下次激活补传
  context.subscriptions.push(
    createTraceArchiver({
      globalStorageUri: context.globalStorageUri,
      teacherUrl: identityDeps.teacherUrl,
      isEnabled: () =>
        vscode.workspace
          .getConfiguration("pylearner")
          .get<boolean>(CONFIG_KEYS.teacherEnabled, true),
      log: (msg) => outputChannel.appendLine(msg),
    })
  );
  // 身份命令（A25：InputBox 弹窗删除，统一走身份页；状态栏点击即打开该页）
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.setStudentIdentity, () =>
      openIdentityPage(identityDeps, context)
    )
  );
  log("[pylearner] setStudentIdentity command registered");

  const readFile = async (fsPath: string): Promise<string | null> => {
    try {
      return new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))
      );
    } catch {
      return null;
    }
  };
  const saveIfDirty = async (filePath: string) => {
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === filePath
    );
    if (doc?.isDirty) await doc.save();
  };
  const submissionDeps: SubmissionDeps = {
    teacherUrl: identityDeps.teacherUrl,
    getIdentity,
    onIdentityMissing: () =>
      maybeOpenIdentityPage(identityDeps, context, loadStudentIdentity(context.globalState)),
    globalState: context.globalState,
    saveIfDirty,
  };
  // V2.0：F5 评审链（替代自动提交；提交按钮纯归档）
  const projectFs = {
    readDirectory: async (fsPath: string) => {
      try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(fsPath));
        return entries.map(([name, type]) => [name, { isDirectory: type === vscode.FileType.Directory }] as [string, { isDirectory: boolean }]);
      } catch {
        return null;
      }
    },
    readFile: async (fsPath: string) => {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath)));
      } catch {
        return null;
      }
    },
  };
  const snapshotDeps = {
    locator: {
      rootFsPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
      join: (d: string, r: string) => vscode.Uri.joinPath(vscode.Uri.file(d), r).fsPath,
      readFile,
    },
    projectFs,
  };
  const buildProjectSnapshot = (filePath: string, content: string) =>
    buildProjectSnapshotImpl(snapshotDeps, filePath, content);
  (submissionDeps as SubmissionDeps & { buildProjectSnapshot?: unknown }).buildProjectSnapshot = buildProjectSnapshot;
  // V2.0 提交按钮：一键归档全部练习——复用 projectFs 适配器遍历 week-XX 收集目标（readFile 供回退单文件路径）
  (submissionDeps as SubmissionDeps & { collectTargets?: unknown }).collectTargets =
    (rootFsPath: string) => collectSubmissionTargets(projectFs, rootFsPath);
  (submissionDeps as SubmissionDeps & { readFile?: unknown }).readFile = readFile;
  const reviewer = makeRunSuccessReviewer(
    { teacherUrl: identityDeps.teacherUrl, getIdentity, buildProjectSnapshot,
      notify: (m, w) => void (w ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)) },
    vscode, readFile,
  );
  l1Writer.setSubmissionHandler((ev) => {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    if (!cfg.get<boolean>(CONFIG_KEYS.submissionEnabled, true)) return;
    void reviewer(ev);   // 内部整体 try/catch
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.submitExercise, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      await makeSubmitCommand(submissionDeps, vscode)();
    })
  );

  // 拉取：命令触发（V2.0：激活自动拉取已取消，仅按钮触发）
  const pullDeps = {
    teacherUrl: identityDeps.teacherUrl,
    globalState: context.globalState,
    // PullDeps 类型要求这两个成员；makeRunPull 内部一律用 vscode.workspace.fs 实现覆盖它们
    fileExists: async () => false,
    writeFile: async () => {},
  };
  const runPull = makeRunPull(
    pullDeps,
    vscode,
    (m, warn) =>
      warn ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.pullAssignments, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      void runPull();
    })
  );

  // 恢复我的提交：从服务端拉回本人每个练习的最近一次提交（教师兜底渠道的对称功能）
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CMD_IDS.restoreSubmissions,
      async () => {
        if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
        await makeRestoreCommand(
          { teacherUrl: identityDeps.teacherUrl, globalState: context.globalState },
          vscode
        )();
      }
    )
  );

  // 「运行和调试」侧边栏「课堂作业」三按钮面板（spec §5.5）
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW_IDS.assignmentPanel, createAssignmentPanel())
  );

  // Factory function - creates a fresh router with current config on demand
  const routerFactory = () => new LlmRouter();
  const refresher = new ProfileRefresher(
    context.globalStorageUri,
    context.secrets,
    routerFactory,
    getIdentity
  );
  log("[pylearner] profile refresher created");

  // Register event listeners
  try {
    context.subscriptions.push(createEditListener(l1Writer));
    log("[pylearner] edit listener registered");
  } catch (err) {
    log("[pylearner] failed to register edit listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createRunListener(l1Writer));
    log("[pylearner] run listener registered");
  } catch (err) {
    log("[pylearner] failed to register run listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createDiagnosticsListener(l1Writer));
    log("[pylearner] diagnostics listener registered");
  } catch (err) {
    log("[pylearner] failed to register diagnostics listener:", err);
    throw err;
  }

  try {
    context.subscriptions.push(createBehaviorListener(l1Writer));
    log("[pylearner] behavior listener registered");
  } catch (err) {
    log("[pylearner] failed to register behavior listener:", err);
    throw err;
  }

  // Register Chat Webview Provider - pass factory, not instance
  try {
    chatProvider = new ChatViewProvider(context, routerFactory, l1Writer, chatStore, refresher);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_IDS.chatView,
        chatProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    log("[pylearner] chat view provider registered");
  } catch (err) {
    log("[pylearner] failed to register chat view provider:", err);
    throw err;
  }

  // Register commands
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openChat, () => {
        vscode.commands.executeCommand(`${VIEW_IDS.sidebarContainer}.focus`);
      })
    );
    log("[pylearner] openChat command registered");
  } catch (err) {
    log("[pylearner] failed to register openChat command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.newChat, () => {
        chatProvider.postMessage({ type: "newChat" });
      })
    );
    log("[pylearner] newChat command registered");
  } catch (err) {
    log("[pylearner] failed to register newChat command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.toggleMonitor, () => {
        const cfg = vscode.workspace.getConfiguration("pylearner");
        const current = cfg.get<boolean>("monitor.editEnabled") ?? true;
        const next = !current;
        const target = vscode.ConfigurationTarget.Global;
        void cfg.update("monitor.editEnabled", next, target);
        void cfg.update("monitor.runEnabled", next, target);
        vscode.window.showInformationMessage(
          `Python Learner monitoring: ${next ? "ON" : "OFF"}`
        );
      })
    );
    log("[pylearner] toggleMonitor command registered");
  } catch (err) {
    log("[pylearner] failed to register toggleMonitor command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openSettings, () => {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "pylearner"
        );
      })
    );
    log("[pylearner] openSettings command registered");
  } catch (err) {
    log("[pylearner] failed to register openSettings command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(
      vscode.commands.registerCommand(CMD_IDS.openDataFolder, () => {
        void vscode.commands.executeCommand("revealInExplorer", context.globalStorageUri);
      })
    );
    log("[pylearner] openDataFolder command registered");
  } catch (err) {
    log("[pylearner] failed to register openDataFolder command:", err);
    throw err;
  }

  // Create profile update commands lazily. Instantiating LlmRouter during
  // activation races VS Code's configuration initialization and can crash the
  // extension host when the new window starts.
  try {
    context.subscriptions.push(registerUpdateProfileCommand(context, routerFactory, outputChannel));
    log("[pylearner] update-profile command registered");
  } catch (err) {
    log("[pylearner] failed to register updateProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerResetProfileCommand(context, routerFactory, outputChannel));
    log("[pylearner] reset-profile command registered");
  } catch (err) {
    log("[pylearner] failed to register resetProfile command:", err);
    throw err;
  }

  try {
    context.subscriptions.push(registerMemoryGraphCommand(context));
    log("[pylearner] memory-graph command registered");
  } catch (err) {
    log("[pylearner] failed to register memoryGraph command:", err);
    throw err;
  }

  // 自动刷新画像功能已停用，待后续评估后再开启
  // 这里保留 refresher 的创建，但不再触发定时刷新
  log("[pylearner] auto profile refresh disabled");

  // 首启迁移旧 SecretStorage 身份；无身份 → 打开身份页；有身份 → 静默复核一次（A25）（V2.0：自动拉取已取消，仅按钮触发）
  void (async () => {
    try {
      await migrateLegacyIdentity(context.globalState, context.secrets, {
        studentId: SECRET_KEYS.studentId,
        studentName: SECRET_KEYS.studentName,
      });
      const id = loadStudentIdentity(context.globalState);
      if (!id.studentId) {
        openIdentityPage(identityDeps, context);
      } else {
        try {
          const res = await fetch(`${identityDeps.teacherUrl()}/api/identity/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: id.studentId, studentName: id.studentName }),
          });
          if (!res.ok) {
            statusBar.tooltip = "身份校验失败（名册可能已更新），点击重新设置";
            openIdentityPage(identityDeps, context);
          }
        } catch {
          /* 服务器不可达：静默，下次再复核 */
        }
      }
    } catch (err) {
      log("[pylearner] identity first-run check failed:", err);
    }
  })();
}

export function deactivate() {
  log("Python Learner extension deactivated");
}
