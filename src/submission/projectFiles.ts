import crypto from "node:crypto";

/** 两仓 wire 契约（F6）：与 server shared SubmissionFile 对齐 */
export interface SubmissionFile { path: string; content: string }

/** 自定义 FileType 形状（避免测试引 vscode） */
export interface FileType { isDirectory: boolean }

/** 忽略清单：server 端集合 + exercise.json（manifest 不入学生提交快照，本地保留供定位） */
const IGNORE_DIRS = new Set(["__pycache__", ".venv", "venv", ".git"]);
const IGNORE_FILES = new Set([".DS_Store", "exercise.json"]);

export function isIgnoredEntry(name: string, isDir: boolean): boolean {
  return isDir ? IGNORE_DIRS.has(name) : IGNORE_FILES.has(name) || name.endsWith(".pyc");
}

/**
 * 提交幂等内容哈希——两仓契约：与 server assignmentFiles.canonicalFilesHash 逐字一致，改动必须双侧同步。
 */
export function canonicalFilesHash(files: SubmissionFile[]): string {
  const sorted = files
    .map((f) => ({ path: f.path, content: f.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export interface ProjectFs {
  readDirectory(fsPath: string): Promise<[string, FileType][] | null>;
  readFile(fsPath: string): Promise<string | null>;
}

/** 递归收集项目目录文件快照；path 为相对目录的 POSIX 路径；目录不可读 → null */
export async function listProjectFiles(fs: ProjectFs, dirFsPath: string): Promise<SubmissionFile[] | null> {
  const entries = await fs.readDirectory(dirFsPath);
  if (entries === null) return null;
  const out: SubmissionFile[] = [];
  for (const [name, type] of entries) {
    if (isIgnoredEntry(name, type.isDirectory)) continue;
    const abs = `${dirFsPath}\\${name}`;
    if (type.isDirectory) {
      const sub = await listProjectFiles(fs, abs);
      if (sub) out.push(...sub.map((f) => ({ path: `${name}/${f.path}`, content: f.content })));
    } else {
      const content = await fs.readFile(abs);
      if (content !== null) out.push({ path: name, content });
    }
  }
  return out;
}
