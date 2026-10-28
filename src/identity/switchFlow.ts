/**
 * 一键换机编排（纯逻辑，不 import vscode，可被单元测试直接覆盖）。
 *
 * 学生分支直连模型（spec 2026-10-15 §4.6）：服务端 Gitea 学生分支即"每生一个分支"，
 * 本地工作区只是当前学生的检出——切换 = 提交归档(旧身份) → checkout 新分支 → 清理+同步，
 * 四段全部映射为 git 原语（git 命令组装只在 src/git/ 内，学生零 Git 认知）：
 *
 *   beforeSwitch(旧身份) = submitAll（add -A + commit + push；非 ok/nothing → 中止切换）
 *   afterSwitch(新身份)  = ensureStudentBranch → clean -fdX → pull 远端学生分支（不存在则忽略）
 *
 * 时序约束：
 * - 归档必须发生在保存新身份之前（submitAll 按 oldId 断言并推送 student-<oldId> 分支）
 * - 归档失败 → 中止切换：不保存新身份、不动工作区（防未归档代码丢失，语义与旧实现一致）
 * - 分支切换/同步发生在保存新身份之后（按新学号建分支）；失败不回滚（旧代码已推送、身份已切换），仅警告并指引手动补救
 */
import type { GitClient } from "../git/gitClient";
import { submitAll, countLocalChanges, type SubmitResult } from "../git/commitOps";
import { ensureStudentBranch, cleanIgnored, remoteStudentBranchExists, resetToMainBaseline } from "../git/branchOps";
import { pullStudentBranch } from "../git/pullOps";

export type NotifyFn = (msg: string, warn: boolean) => void;

export interface BeforeSwitchDeps {
  git: GitClient;
  /** 旧身份（归档归属者，与保存新身份前的 globalState 一致） */
  studentId: string;
  studentName: string;
  remoteWithBasic: () => string;
  /** submitAll 删除确认透传（VS Code 模态；不传视为确认） */
  confirmDelete?: (n: number) => Promise<boolean>;
  confirm: (info: { oldId: string; newId: string; count: number }) => Promise<boolean>;
  notify: NotifyFn;
}

/** 阶段一（保存新身份前调用）：确认弹窗 + 用旧身份提交归档当前工作区（submitAll）。
 * 返回 false = 中止切换（无变更外任何归档失败/用户取消），调用方不得保存新身份。 */
export async function archiveBeforeSwitch(deps: BeforeSwitchDeps, oldId: string, newId: string): Promise<boolean> {
  const count = await countLocalChanges(deps.git).catch(() => 0);
  if (!(await deps.confirm({ oldId, newId, count }))) return false;
  let result: SubmitResult;
  try {
    result = await submitAll({
      git: deps.git, studentId: deps.studentId, studentName: deps.studentName,
      remoteWithBasic: deps.remoteWithBasic, confirmDelete: deps.confirmDelete,
    });
  } catch (e) {
    deps.notify(`保存失败：${errMsg(e)}，身份未切换，可重试`, true);
    return false;
  }
  switch (result.kind) {
    case "ok":
      deps.notify(`已保存 ${oldId} 的当前作业，服务器已留档`, false);
      return true;
    case "nothing":
      deps.notify("当前作业没有修改，无需保存", false);
      return true;
    case "deleteCancelled":
      return false;   // 用户主动取消删除确认，不再叠加提示
    case "branchMismatch":
      deps.notify(`本地作业目录与学号 ${deps.studentId} 不一致，保存中止，身份未切换（请勿手动切换分支）`, true);
      return false;
    case "rebaseConflict":
      deps.notify("与你在其他电脑保存的作业冲突，保存中止，身份未切换，可重试", true);
      return false;
    case "pushFailed":
      deps.notify("推送失败（可能断网），为防代码丢失已中止切换；联网后先执行「提交作业」再切换", true);
      return false;
  }
}

export interface AfterSwitchDeps {
  git: GitClient;
  newStudentId: string;
  notify: NotifyFn;
}

/** 阶段二（保存新身份后调用）：checkout 新分支 → clean 清缓存 → 同步远端本人分支 → 通知。
 * 2026-10-28 调整：不再自动拉取教师 main 新作业——学生需要时手动点「拉取作业」，换机只同步本人分支。 */
export async function refillAfterSwitch(deps: AfterSwitchDeps): Promise<void> {
  const { git, newStudentId } = deps;
  const branch = `student-${newStudentId}`;
  try {
    await ensureStudentBranch(git, newStudentId);
  } catch (e) {
    deps.notify(`为 ${newStudentId} 准备作业目录失败：${errMsg(e)}，可执行「同步作业」补救`, true);
    return;
  }
  try {
    await cleanIgnored(git);   // 清除前一位学生残留的 ignored 缓存垃圾；其自建文件已随 add -A 进入其分支
  } catch (e) {
    deps.notify(`清理缓存文件失败：${errMsg(e)}，不影响切换，可忽略`, true);
  }
  // 远端分支不存在 = 新学生首用 → 忽略 pull，工作区即刚创建的 main 基线
  if (await remoteStudentBranchExists(git, newStudentId)) {
    try {
      await pullStudentBranch(git, newStudentId);
    } catch (e) {
      deps.notify(`恢复你在服务器上的作业失败：${errMsg(e)}，可执行「同步作业」重试`, true);
      return;
    }
  }
  // 2026-10-28：不自动拉取教师 main 新作业（学生需要时手动点「拉取作业」），换机只同步本人分支
  deps.notify(`已切换到 ${newStudentId} 的作业目录`, false);
}

export interface SemesterResetDeps {
  git: GitClient;
  confirm: (info: { oldId: string; newId: string }) => Promise<boolean>;
  notify: NotifyFn;
}

/** 学期更替切换（spec roster §3 三分叉之一）：旧学号已不在名册 → 不走归档（旧身份无凭证可归档），
 * 确认后清空工作区回 origin/main 基线。返回 false = 中止（用户取消或清空失败），调用方不得保存新身份。 */
export async function semesterResetBeforeSwitch(deps: SemesterResetDeps, oldId: string, newId: string): Promise<boolean> {
  if (!(await deps.confirm({ oldId, newId }))) return false;
  try {
    await resetToMainBaseline(deps.git);
  } catch (e) {
    deps.notify(`重置失败：${errMsg(e)}，身份未切换，可重试`, true);
    return false;
  }
  return true;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
