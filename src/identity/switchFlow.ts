/**
 * 一键换机编排（纯逻辑，不 import vscode，可被单元测试直接覆盖）。
 *
 * 场景：共享电脑上 001 用完，002 在同一台机器切换身份继续上课。
 * 服务端 Gitea 学生分支即"每生一个分支"，本地工作区只是当前学生的检出——
 * 切换 = 归档(旧身份) → 清空 week-* → 拉取最新发布作业 → 恢复(新身份)，
 * 等价于 Git 的 commit → checkout，只是全部经 HTTP 由服务端代管（学生机无 Git）。
 *
 * 时序约束：
 * - 归档必须发生在保存新身份之前（submitCode 按 globalState 当前身份归属提交）
 * - 恢复必须发生在保存新身份之后（restore 按 globalState 当前身份拉取本人提交）
 * - 用户取消或归档未完成 → 中止：不保存新身份、不删除任何文件（防未归档代码丢失）
 * - 清空/拉取/恢复阶段失败不回滚（身份已切换、旧代码已在服务端），仅警告并指引手动补救
 */
import type { SubmissionTarget } from "../submission/collectTargets";
import { archiveWorkspaceTargets } from "../submission/submitCommand";
import type { SubmissionDeps } from "../submission/submissionReporter";

/** week-* 目录识别（与 collectTargets 周段宽容规则一致：week-5 / week-05 均可） */
export const WEEK_DIR_RE = /^week-\d+$/;

/** 一级条目中可清空的 week-* 目录名（纯函数；其他文件/目录一律保留） */
export function weekDirsToRemove(entries: [string, boolean][]): string[] {
  return entries.filter(([name, isDir]) => isDir && WEEK_DIR_RE.test(name)).map(([name]) => name);
}

export interface SwitchArchiveDeps extends SubmissionDeps {
  rootFsPath: () => string | undefined;
  collectTargets: (rootFsPath: string) => Promise<SubmissionTarget[]>;
  confirm: (info: { oldId: string; newId: string; count: number }) => Promise<boolean>;
  notify: (msg: string, warn: boolean) => void;
}

/** 阶段一（保存新身份前调用）：确认弹窗 + 用旧身份归档当前工作区全部练习。
 * 返回 false = 中止切换（无工作区/用户取消/归档未完成），调用方不得保存新身份。 */
export async function confirmAndArchive(deps: SwitchArchiveDeps, oldId: string, newId: string): Promise<boolean> {
  const root = deps.rootFsPath();
  if (!root) { deps.notify("请先打开课堂文件夹（文件 → 打开文件夹），再切换身份", true); return false; }
  const targets = await deps.collectTargets(root);
  if (!(await deps.confirm({ oldId, newId, count: targets.length }))) return false;
  const s = await archiveWorkspaceTargets(deps, targets);
  if (s.identityMissing) { deps.notify("身份信息缺失，归档中止，身份未切换", true); return false; }
  if (s.failed > 0) {
    deps.notify(`归档未完成（${s.failed} 个失败：${s.failedLabels.join("、")}），已保留工作区，身份未切换，可重试`, true);
    return false;
  }
  deps.notify(`已用 ${oldId} 归档 ${s.submitted} 个练习${s.skipped > 0 ? `（${s.skipped} 个已是最新）` : ""}`, false);
  return true;
}

export interface PostSwitchDeps {
  /** 工作区一级条目 [名称, 是否目录]；null = 无工作区 */
  listEntries: () => Promise<[string, boolean][] | null>;
  deleteDir: (name: string) => Promise<void>;
  pull: () => Promise<{ pulled: number }>;
  restore: () => Promise<{ restored: number }>;
  notify: (msg: string, warn: boolean) => void;
}

/** 阶段二（保存新身份后调用）：清空 week-* → 拉取最新发布作业 → 恢复本人历史提交 → 汇总通知 */
export async function clearAndRefill(deps: PostSwitchDeps): Promise<void> {
  let cleared = 0;
  try {
    const entries = await deps.listEntries();
    const dirs = entries ? weekDirsToRemove(entries) : [];
    for (const d of dirs) await deps.deleteDir(d);
    cleared = dirs.length;
  } catch (e) {
    deps.notify(`清空旧作业目录失败：${errMsg(e)}，可手动删除 week-XX 后执行「拉取作业」与「恢复我的提交」`, true);
    return;
  }
  let pulled = 0;
  try {
    pulled = (await deps.pull()).pulled;
  } catch (e) {
    deps.notify(`拉取作业失败：${errMsg(e)}，可在命令面板执行「拉取作业」重试`, true);
    return;
  }
  let restored = 0;
  try {
    restored = (await deps.restore()).restored;
  } catch (e) {
    deps.notify(`恢复历史提交失败：${errMsg(e)}，可稍后执行「恢复我的提交」`, true);
  }
  deps.notify(`已切换工作区：清空 ${cleared} 个周目录 · 拉取 ${pulled} 个文件 · 恢复 ${restored} 个提交`, false);
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
