/** 与 classroom-assistant shared 同正则（A5 两仓契约；learner 不依赖 shared——F6） */
export const EXERCISE_ID_REGEX =
  /^#\s*exercise-id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/;

export function scanExerciseId(content: string): string | null {
  for (const line of content.split(/\r?\n/).slice(0, 20)) {
    const m = line.match(EXERCISE_ID_REGEX);
    if (m) return m[1];
  }
  return null;
}

/** 从终端命令提取 .py token（A27）：取第一个以 .py 结尾的参数，剥引号 */
export function extractPyPathFromCommand(commandLine: string): string | null {
  const tokens = commandLine.match(/"[^"]+"|\S+/g) ?? [];
  for (const t of tokens) {
    const token = t.replace(/^"|"$/g, "");
    if (token.toLowerCase().endsWith(".py")) return token;
  }
  return null;
}

const isAbsoluteLike = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

/** 相对路径 join cwd，统一为 Windows 反斜杠（A27：真实 command 如 `& C:\Python314\python.exe c:/x/study.py`） */
export function resolvePyFile(commandLine: string, cwdFsPath: string | undefined): string | null {
  const token = extractPyPathFromCommand(commandLine);
  if (!token) return null;
  const normalized = token.replace(/\//g, "\\");
  if (isAbsoluteLike(token)) return normalized;
  if (!cwdFsPath) return null;
  return cwdFsPath.replace(/\/+$/, "") + "\\" + normalized;
}
