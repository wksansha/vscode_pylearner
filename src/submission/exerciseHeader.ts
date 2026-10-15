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
