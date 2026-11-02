// 插件自更新（云分发，spec docs 载于 classroom-assistant 仓库 specs/2026-11-02-plugin-auto-update-design.md）：
// 启动后检查服务端版本清单，新版本弹通知一键下载安装。本模块不 import vscode，
// 全依赖注入（fetch/通知/命令执行），可脱离扩展宿主单测；失败一律静默/单次报错，不重试。

export interface UpdateInfo {
  version: string;
  /** 清单下发的文件名（已过白名单校验），临时落盘文件名用它 */
  file: string;
  downloadUrl: string;
  notes: string;
}

// manifest.file 白名单：杜绝 ../ 路径穿越与任意 URL（spec 安全节）
const FILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** 按 `.` 分段数值比较（1.10.0 > 1.9.0）；段数不齐短侧补 0；非数字段按 0 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export interface CheckForUpdateDeps {
  teacherUrl: string;
  currentVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 拉取 {teacherUrl}/api/pylearner/latest 并判断是否有新版本。
 * 任何异常（网络/404/解析/字段非法/版本不高）→ null，调用方静默。
 */
export async function checkForUpdate(deps: CheckForUpdateDeps): Promise<UpdateInfo | null> {
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const timeoutMs = deps.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${deps.teacherUrl}/api/pylearner/latest`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const m = (await res.json().catch(() => null)) as { version?: unknown; file?: unknown; notes?: unknown } | null;
    if (!m || typeof m.version !== "string" || typeof m.file !== "string") return null;
    if (!FILE_NAME_RE.test(m.file)) return null;
    if (compareVersions(deps.currentVersion, m.version) >= 0) return null;
    return {
      version: m.version,
      file: m.file,
      downloadUrl: `${deps.teacherUrl}/downloads/pylearner/${m.file}`,
      notes: typeof m.notes === "string" ? m.notes : "",
    };
  } catch {
    return null;
  }
}

export interface InstallUpdateDeps {
  info: UpdateInfo;
  /** 下载阶段进度展示（VS Code withProgress 返回 Thenable，故用 PromiseLike） */
  showProgress: <T>(title: string, task: () => Promise<T>) => PromiseLike<T>;
  /** 信息通知带单按钮，返回是否点了按钮 */
  showMessage: (message: string, button: string) => PromiseLike<boolean>;
  showError: (message: string) => void;
  executeCommand: (command: string, arg?: unknown) => PromiseLike<unknown>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  tmpDir: string;
  joinPath: (...segments: string[]) => string;
  toUri: (path: string) => unknown;
  fetchImpl?: typeof fetch;
}

/** 下载 vsix → installVSIX → 提示重载。任一步失败：错误通知一次，不再重试。 */
export async function installUpdate(deps: InstallUpdateDeps): Promise<void> {
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const vsixPath = await deps.showProgress("正在下载课堂助手更新…", async () => {
      const res = await fetchImpl(deps.info.downloadUrl);
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const p = deps.joinPath(deps.tmpDir, deps.info.file);
      await deps.writeFile(p, bytes);
      return p;
    });
    await deps.executeCommand("workbench.extensions.action.installVSIX", deps.toUri(vsixPath));
    const reloaded = await deps.showMessage("课堂助手已更新到新版本，重新加载窗口后生效", "重新加载");
    if (reloaded) await deps.executeCommand("workbench.action.reloadWindow");
  } catch (e) {
    deps.showError(`课堂助手更新失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
