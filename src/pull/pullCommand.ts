/** 本地轻量类型（learner 不依赖 @classroom/shared——F6；字段与 server /api/assignments/published 对齐） */
interface PublishedAssignmentLite {
  id: string; title: string; week: number;
  exercises: { id: string; filename: string; versionHash: string }[];
}

export interface PullDeps {
  teacherUrl: () => string;
  globalState: { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> };
  fetchImpl?: typeof fetch;
  fileExists: (rel: string) => Promise<boolean>;
  writeFile: (rel: string, content: string) => Promise<void>;
}

const PULLED_VERSIONS_KEY = "pylearner.pull.versions";   // A30 更新检测

export async function pullAssignments(deps: PullDeps): Promise<{ pulled: number; updateNotices: string[] }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${deps.teacherUrl()}/api/assignments/published`);
  if (!res.ok) throw new Error(`拉取作业列表失败（${res.status}）`);
  const list = (await res.json()) as PublishedAssignmentLite[];
  const versions = (deps.globalState.get(PULLED_VERSIONS_KEY) ?? {}) as Record<string, string>;
  const result = { pulled: 0, updateNotices: [] as string[] };
  for (const a of list) {
    for (const ex of a.exercises) {
      const rel = `week-${String(a.week).padStart(2, "0")}/${ex.filename}`;
      if (await deps.fileExists(rel)) {
        if (versions[ex.id] && versions[ex.id] !== ex.versionHash) {
          result.updateNotices.push(`${rel} 题目已更新，本地文件未改动，请注意最新要求`);   // A30 仅通知
        }
        versions[ex.id] = ex.versionHash;
        continue;
      }
      const contentRes = await doFetch(`${deps.teacherUrl()}/api/exercises/${ex.id}/content`);
      if (!contentRes.ok) continue;
      await deps.writeFile(rel, await contentRes.text());
      versions[ex.id] = ex.versionHash;
      result.pulled++;
    }
  }
  await deps.globalState.update(PULLED_VERSIONS_KEY, versions);
  return result;
}

/** 命令与激活共用执行体（A26）：通知文案集中在此 */
export function makeRunPull(
  deps: PullDeps,
  vscode: typeof import("vscode"),
  notify: (message: string, isWarning: boolean) => void,
): () => Promise<void> {
  return async () => {
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
      notify("请先打开课堂文件夹（文件 → 打开文件夹），再拉取作业", true);
      return;
    }
    const joined: PullDeps = {
      ...deps,
      fileExists: async (rel) => {
        try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root.uri, rel)); return true; } catch { return false; }
      },
      writeFile: async (rel, content) => {
        const target = vscode.Uri.joinPath(root.uri, rel);
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
      },
    };
    try {
      const r = await pullAssignments(joined);
      if (r.pulled > 0) notify(`已拉取作业：${r.pulled} 个文件（week-XX/ 目录）`, false);
      for (const n of r.updateNotices) notify(n, true);          // A30
    } catch (e) {
      notify(`作业拉取失败，可在命令面板执行“拉取作业”重试（${e instanceof Error ? e.message : String(e)}）`, true);
    }
  };
}
