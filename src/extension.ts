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
import { CMD_IDS, CONFIG_KEYS, DEFAULT_TEACHER_URL, SECRET_KEYS, STATE_KEYS, VIEW_IDS } from "./constants";
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
import { loadStudentIdentity, migrateLegacyIdentity, clearStudentIdentity } from "./identity/studentIdentity";
import { openIdentityPage } from "./identity/identityPage";
import { createSessionConfirmGate } from "./identity/sessionConfirm";
import { archiveBeforeSwitch, refillAfterSwitch, semesterResetBeforeSwitch } from "./identity/switchFlow";
import { createGitClient, type GitClient } from "./git/gitClient";
import { submitAll } from "./git/commitOps";
import { pullNewOnly } from "./git/pullOps";
import { hasLocalChanges, syncToRemoteState } from "./git/syncOps";
import { remoteWithBasic, probeGit, isGitWorkTree, bootstrapClone, updateOriginUrl, configureCommitter } from "./git/gitEnv";
import { ensureStudentBranch, remoteStudentBranchExists } from "./git/branchOps";
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
        cfg.get<string>(CONFIG_KEYS.teacherUrl, DEFAULT_TEACHER_URL) ||
        DEFAULT_TEACHER_URL;
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

  // —— 学生分支直连模型（spec 2026-10-15 §4）：git 运行环境解析 ——
  // 工作区 + 身份 + token + 仓库就绪缺一不可；任一缺失提示后返回 null，命令静默中止
  // 仓库地址优先级：settings pylearner.gitRepoUrl（教师本机调试覆盖）> 服务端校验响应下发的缓存（学生机零配置）
  const gitRepoUrl = () =>
    vscode.workspace.getConfiguration("pylearner").get<string>(CONFIG_KEYS.gitRepoUrl, "") ||
    (context.globalState.get<string>(STATE_KEYS.gitRepoUrl) ?? "");
  async function resolveGitEnv(): Promise<{ git: GitClient; remote: () => string; freshBootstrap: boolean } | null> {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      void vscode.window.showWarningMessage("请先打开课堂文件夹（文件 → 打开文件夹）");
      return null;
    }
    const id = loadStudentIdentity(context.globalState);
    if (!id.studentId) {
      void vscode.window.showWarningMessage("请先在身份页设置学号与姓名");
      return null;
    }
    const studentId = id.studentId;   // 闭包内不继承属性收窄，先捕获
    const gitSecret = await context.secrets.get(SECRET_KEYS.gitSecret);
    if (!gitSecret) {
      void vscode.window.showWarningMessage("请在右下角重新设置身份以领取 Git 凭证");
      return null;
    }
    const repoUrl = gitRepoUrl();
    if (!repoUrl) {
      void vscode.window.showWarningMessage("未获取到课堂仓库地址：服务端未下发且未配置 pylearner.gitRepoUrl，请联系教师");
      return null;
    }
    const remote = () => remoteWithBasic(repoUrl, studentId, gitSecret);
    let bootstrapped = false;
    if (!(await isGitWorkTree(root.uri.fsPath))) {
      // clone 要求空目录：仅含 .vscode（VS Code 自动生成）视为可初始化，其余提示学生换空文件夹
      const entries = await vscode.workspace.fs.readDirectory(root.uri).then(
        (e) => e,
        () => [] as [string, vscode.FileType][],
      );
      if (!entries.every(([name]) => name === ".vscode")) {
        void vscode.window.showWarningMessage(
          "工作区尚未初始化课堂仓库，且当前文件夹不是空的：请在一个空文件夹中打开 VS Code 再试"
        );
        return null;
      }
      const pick = await vscode.window.showInformationMessage(
        "工作区尚未初始化课堂仓库，立即初始化（将拉取全部作业历史）？",
        { modal: true },
        "立即初始化"
      );
      if (pick !== "立即初始化") return null;
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "正在初始化课堂仓库…" },
          () => bootstrapClone(root.uri.fsPath, remote())
        );
        bootstrapped = true;
      } catch (e) {
        void vscode.window.showErrorMessage(
          `课堂仓库初始化失败：${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }
    }
    const git = createGitClient(root.uri.fsPath);
    // origin 刷新为当前学生凭证：换机/换人后 fetch/pull 读取凭证跟随本人（push 用显式 URL，不依赖 origin）
    await updateOriginUrl(git, remote()).catch(() => {});
    // F2：committer 身份写仓库 local config，跟随当前身份（机房 git 常无全局 user.name/email，
    // 换学号后在此同步刷新；失败不阻断命令流，commit 阶段有明确报错兜底）
    await configureCommitter(git, id.studentId).catch(() => {});
    // F1：bootstrap 停在 main → 立即幂等保障学生分支（失败静默，命令体内的 ensure 再兜底）
    if (bootstrapped) await ensureStudentBranch(git, id.studentId).catch(() => {});
    // 新学生首用（刚 bootstrap 且远端学生分支不存在）：工作区已停在 origin/main 基线，
    // 后续增量拉取必为空转，调用方可据此跳过（老学生换机时远端分支存在，不置 true，增量拉取照常）
    const freshBootstrap = bootstrapped && !(await remoteStudentBranchExists(git, id.studentId).catch(() => false));
    return { git, remote, freshBootstrap };
  }
  // 提交删除确认（spec 4.4 第 2 步）：提交按钮与一键换机归档共用
  const confirmDeleteModal = async (n: number): Promise<boolean> => {
    const pick = await vscode.window.showWarningMessage(
      `本次提交将删除 ${n} 个文件，确定？`,
      { modal: true },
      "确定删除并提交"   // 隐式取消由 VS Code 模态框自动追加
    );
    return pick === "确定删除并提交";
  };
  const switchNotify = (m: string, warn: boolean) =>
    void (warn ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m));

  // 选完立即校验空目录（仅容忍 .vscode，与 resolveGitEnv 初始化规则一致），非空提示重选，避免拖到拉取阶段才报错
  const pickEmptyWorkspaceFolder = async (): Promise<vscode.Uri | undefined> => {
    for (;;) {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "用作作业目录",
        title: "选择作业目录（建议新建空文件夹）",
      });
      if (!uris?.length) return undefined;
      const entries = await vscode.workspace.fs.readDirectory(uris[0]).then(
        (e) => e,
        () => [] as [string, vscode.FileType][],
      );
      if (entries.every(([name]) => name === ".vscode")) return uris[0];
      const retry = await vscode.window.showWarningMessage(
        "所选文件夹不是空的：作业目录需要是一个空文件夹（请新建一个空文件夹后重试）",
        { modal: true },
        "重新选择"
      );
      if (retry !== "重新选择") return undefined;
    }
  };

  // 新手引导（spec §6）：身份保存成功后自动拉取一次作业；无工作区时先引导选作业目录。
  // 平台行为：空窗口加入首个工作区文件夹会重启扩展宿主（updateWorkspaceFolders 也不例外），
  // 内存中的会话确认态与进行中的拉取全部丢失——因此选完目录用 openFolder 整窗重载（确定性路径），
  // 先落 onboardingPending 标记，重载后由激活流程续跑（补会话确认 + 自动拉取），见下方首启检查。
  const autoPullAfterSave = async (): Promise<void> => {
    if (!vscode.workspace.workspaceFolders?.length) {
      const pick = await vscode.window.showInformationMessage(
        "身份设置成功！最后一步：选择一个空文件夹作为你的作业目录，作业代码将存放在这里",
        { modal: true },
        "选择文件夹"
      );
      if (pick !== "选择文件夹") return;
      const folder = await pickEmptyWorkspaceFolder();
      if (!folder) return;
      await context.globalState.update(STATE_KEYS.onboardingPending, true);
      await vscode.commands.executeCommand("vscode.openFolder", folder, { forceNewWindow: false });
      return;   // 整窗重载后从激活流程续跑，本实例后续代码不再执行
    }
    void vscode.commands.executeCommand(CMD_IDS.pullAssignments);
  };

  // —— 作业系统装配（A25：身份页 + 一键换机）——
  const identityDeps = {
    teacherUrl: () =>
      vscode.workspace
        .getConfiguration("pylearner")
        .get<string>(CONFIG_KEYS.teacherUrl, DEFAULT_TEACHER_URL),
    onSaved: (identity: { studentId: string; studentName: string }) => {
      sessionGate?.markConfirmed();   // 保存成功 = 本人声明身份，会话内免再确认
      // 有 Git 凭证才自动拉取（离线兜底/未开通 Git 账户时跳过，避免刚提示「离线保存」又弹告警）
      void context.secrets.get(SECRET_KEYS.gitSecret).then((secret) => {
        if (secret) void autoPullAfterSave();
      });
    },
    // 一键换机（spec §4.6）：身份页校验通过且学号变化时触发，四段编排见 switchFlow.ts（全 git 原语）
    switchFlow: {
      beforeSwitch: async (oldId: string, newId: string) => {
        const env = await resolveGitEnv();
        if (!env) return false;
        const old = loadStudentIdentity(context.globalState);
        return archiveBeforeSwitch(
          {
            git: env.git,
            studentId: oldId,
            studentName: old.studentName ?? oldId,
            remoteWithBasic: env.remote,
            confirmDelete: confirmDeleteModal,
            confirm: async ({ oldId: o, newId: n, count }) => {
              const pick = await vscode.window.showInformationMessage(
                `检测到更换学号：${o} → ${n}\n将先保存当前作业${count > 0 ? `的 ${count} 处修改` : ""}到 ${o} 名下（服务器保留，可随时找回），然后把作业目录换成 ${n} 的内容。`,
                { modal: true },
                "继续切换"   // 隐式取消由 VS Code 模态框自动追加
              );
              return pick === "继续切换";
            },
            notify: switchNotify,
          },
          oldId,
          newId,
        );
      },
      afterSwitch: async (newId: string) => {
        const env = await resolveGitEnv();
        if (!env) return;
        await refillAfterSwitch({ git: env.git, newStudentId: newId, notify: switchNotify });
      },
      // 学期更替（spec roster §3）：旧学号已不在名册 → 确认后清空工作区（不归档，修复无凭证死锁）
      semesterReset: async (oldId: string, newId: string) => {
        const env = await resolveGitEnv();
        if (!env) return false;
        return semesterResetBeforeSwitch(
          {
            git: env.git,
            confirm: async ({ oldId: o, newId: n }) => {
              const pick = await vscode.window.showWarningMessage(
                `检测到学期更替：${o} 已不在当前学期花名册中。\n` +
                `切换身份将把本地作业目录清空并为 ${n} 初始化新学期环境：已推送的旧代码仍保留在服务器上原学号分支中，可随时找回；未提交的修改和未推送的提交将被清空且无法恢复。`,
                { modal: true },
                "确认清空并切换"   // 隐式取消由 VS Code 模态框自动追加，不得显式再加取消按钮
              );
              return pick === "确认清空并切换";
            },
            notify: switchNotify,
          },
          oldId,
          newId,
        );
      },
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

  // 开发/验收工具：清除本机身份与 Git 凭证，模拟学生首次打开 VS Code（模态确认防误触，确认后自动重载窗口）
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.devResetIdentity, async () => {
      const pick = await vscode.window.showWarningMessage(
        "将清除本机保存的课堂身份与 Git 凭证（用于模拟学生首次打开），清除后窗口自动重载。继续？",
        { modal: true },
        "清除并重载"   // 隐式取消由 VS Code 模态框自动追加
      );
      if (pick !== "清除并重载") return;
      await clearStudentIdentity(context.globalState);
      await context.globalState.update(STATE_KEYS.gitRepoUrl, undefined);
      await context.secrets.delete(SECRET_KEYS.gitSecret);
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    })
  );

  const readFile = async (fsPath: string): Promise<string | null> => {
    try {
      return new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))
      );
    } catch {
      return null;
    }
  };
  // V2.0：F5 评审链（run 成功触发，请求自带代码文本；与学生分支提交互不干扰）
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
  // F5 评审（spec 2.1）：filePath + commitHash 直连服务端；git rev-parse HEAD，非 git 仓库/失败 → ""
  const reviewRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const reviewGit = reviewRoot ? createGitClient(reviewRoot) : null;
  const getCommitHash = async (): Promise<string> => reviewGit ? (await reviewGit.run(["rev-parse", "HEAD"])).trim() : "";
  const reviewer = makeRunSuccessReviewer(
    { teacherUrl: identityDeps.teacherUrl, getIdentity, buildProjectSnapshot,
      workspaceRoot: () => reviewRoot, getCommitHash,
      notify: (m, w) => void (w ? vscode.window.showWarningMessage(m) : vscode.window.showInformationMessage(m)) },
    vscode, readFile,
  );
  l1Writer.setSubmissionHandler((ev) => {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    if (!cfg.get<boolean>(CONFIG_KEYS.submissionEnabled, true)) return;
    void reviewer(ev);   // 内部整体 try/catch
  });

  // 提交作业（spec 4.4）：add -A → commit → fetch+rebase → push 学生分支（提交事实以 git 历史为准，无服务端上报）
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.submitExercise, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      const env = await resolveGitEnv();
      if (!env) return;
      const id = loadStudentIdentity(context.globalState);
      if (!id.studentId) return;   // sessionGate 已保证，类型收窄兜底
      try {
        // F1：命令体入口幂等分支保障（新学生首用建分支 / 手动切走后拉回，防 branchMismatch 死路）
        await ensureStudentBranch(env.git, id.studentId!);
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "正在提交作业…" },
          () => submitAll({
            git: env.git,
            studentId: id.studentId!,
            studentName: id.studentName ?? id.studentId!,
            remoteWithBasic: env.remote,
            confirmDelete: confirmDeleteModal,
          }),
        );
        switch (r.kind) {
          case "ok":
            void vscode.window.showInformationMessage("✅ 提交成功：工作区已推送到你的分支");
            break;
          case "nothing":
            void vscode.window.showInformationMessage("工作区无变更，无需提交");
            break;
          case "deleteCancelled":
            void vscode.window.showInformationMessage("已取消提交");
            break;
          case "branchMismatch":
            void vscode.window.showWarningMessage(
              `当前分支不是 student-${id.studentId}，提交已取消（请勿手动切换分支，可用「同步作业」恢复）`);
            break;
          case "rebaseConflict":
            void vscode.window.showWarningMessage(
              "与你在其他电脑的提交冲突：本地提交已保留，请联系教师协助选择保留版本");
            break;
          case "pushFailed":
            void vscode.window.showWarningMessage("已本地保存，联网后重新提交即可补推");
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`提交失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // 拉取作业（spec 4.3）：先收敛自己分支，再只新增 main 的新题（不改已有文件）
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.pullAssignments, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      const env = await resolveGitEnv();
      if (!env) return;
      const id = loadStudentIdentity(context.globalState);
      if (!id.studentId) return;
      // 新学生首用（freshBootstrap）：bootstrap 已 checkout origin/main 基线并建好学生分支，
      // 增量拉取（ensure + fetch + diff）必为空转，直接提示就绪；换机（远端分支存在）照常走增量拉取
      if (env.freshBootstrap) {
        void vscode.window.showInformationMessage(`课堂仓库已初始化，作业已就绪（分支 student-${id.studentId}）`);
        return;
      }
      // 脏工作区守卫：rebase 前置条件是工作区干净，未提交的已跟踪修改会让拉取被 git 直接拒绝。
      // 只算已跟踪修改（?? 开头的未跟踪新文件不阻塞 rebase，不误伤题库 main 无 .gitignore 时引导写入的新文件）
      const status = await env.git.run(["status", "--porcelain"]);
      if (status.split("\n").some((l) => l.trim() && !l.startsWith("??"))) {
        void vscode.window.showWarningMessage("你有未保存的作业修改，请先点击「提交作业」保存，再重新拉取");
        return;
      }
      try {
        // F1：命令体入口幂等分支保障（先在自己分支上，再做只新增拉取）
        await ensureStudentBranch(env.git, id.studentId!);
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "正在拉取作业…" },
          () => pullNewOnly(env.git, id.studentId!),
        );
        if (r.pulled.length > 0) {
          void vscode.window.showInformationMessage(`已拉取新作业：${r.pulled.length} 个文件（来自教师 main 分支）`);
        } else {
          void vscode.window.showInformationMessage("暂无新作业");
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`拉取作业失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // 同步作业（spec 4.5，旧「恢复我的提交」）：工作区强制还原为远端自己分支的最新已提交状态
  context.subscriptions.push(
    vscode.commands.registerCommand(CMD_IDS.syncAssignments, async () => {
      if (!sessionGate || !(await sessionGate.ensureConfirmed())) return;
      const env = await resolveGitEnv();
      if (!env) return;
      const id = loadStudentIdentity(context.globalState);
      if (!id.studentId) return;
      try {
        // F1：命令体入口幂等分支保障（防旧版引导残留 main / 手动切走——分支断言前先回到自己分支）
        await ensureStudentBranch(env.git, id.studentId!);
        if (await hasLocalChanges(env.git)) {
          const pick = await vscode.window.showWarningMessage(
            "未提交的修改已自动备份并将在工作区移除，继续？",
            { modal: true },
            "继续同步"
          );
          if (pick !== "继续同步") return;
        }
        const r = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "正在同步作业…" },
          () => syncToRemoteState(env.git, id.studentId!),
        );
        if (r.kind === "rebaseConflict") {
          void vscode.window.showWarningMessage("与你在其他电脑的提交冲突，同步已中止，可重试或联系教师");
          return;
        }
        void vscode.window.showInformationMessage(
          `✅ 同步完成：工作区已还原为你分支的最新提交${r.stashed ? "（原修改已备份，可找教师从 stash 找回）" : ""}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`同步失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // 课堂作业三入口已移至编辑器标题栏（editor/title，F5 旁；package.json menus），
  // 侧边栏不再保留 tree 视图，Chat 独占整个 Python Learner 面板

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
      vscode.commands.registerCommand(CMD_IDS.openDataFolder, async () => {
        try {
          // 目录不存在时 revealInExplorer 会静默无反应——先确保目录已创建（幂等）
          await vscode.workspace.fs.createDirectory(context.globalStorageUri);
          await vscode.commands.executeCommand("revealInExplorer", context.globalStorageUri);
        } catch (err) {
          // 兜底：用系统文件管理器打开（Windows 资源管理器 / Linux xdg-open）
          try {
            await vscode.env.openExternal(context.globalStorageUri);
          } catch {
            const msg = `无法打开数据文件夹：${err instanceof Error ? err.message : String(err)}`;
            vscode.window.showErrorMessage(msg);
            log(`[pylearner] ${msg}`);
          }
        }
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

  // git 探测（spec §8）：机房机器缺 Git → 安装引导（不阻断其他功能）
  void probeGit().then((ok) => {
    if (!ok) void vscode.window.showWarningMessage("未检测到 Git，请安装后重启 VS Code");
  });

  // 首启迁移旧 SecretStorage 身份；无身份 → 打开身份页；有身份 → 静默复核一次（A25）（V2.0：自动拉取已取消，仅按钮触发）
  void (async () => {
    try {
      await migrateLegacyIdentity(context.globalState, context.secrets, {
        studentId: SECRET_KEYS.studentId,
        studentName: SECRET_KEYS.studentName,
      });
      // 新手引导续跑：身份保存后选作业目录触发整窗重载，重启后在此恢复——
      // 补会话确认（消除问号）+ 自动拉取。标记一次性消费，正常重启不带此标记，不影响共享电脑防误用确认。
      if (context.globalState.get(STATE_KEYS.onboardingPending) === true) {
        await context.globalState.update(STATE_KEYS.onboardingPending, undefined);
        const pendingId = loadStudentIdentity(context.globalState);
        if (pendingId.studentId) {
          sessionGate?.markConfirmed();
          if (vscode.workspace.workspaceFolders?.length) {
            void vscode.commands.executeCommand(CMD_IDS.pullAssignments);
          } else {
            void autoPullAfterSave();   // 极少数：文件夹未随重载持久化，重新引导选择
          }
          return;
        }
      }
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
          } else {
            // 静默补领 gitSecret：学生换机/重建秘钥环后免手动重存身份
            const body = await res.json().catch(() => ({})) as { gitSecret?: string | null };
            if (body.gitSecret) await context.secrets.store(SECRET_KEYS.gitSecret, body.gitSecret);
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
