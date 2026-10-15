import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export type ExecFn = (file: string, args: string[], opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
export class GitError extends Error {
  constructor(msg: string, public stdout: string, public stderr: string) { super(msg); }
}
export interface GitClient { run(args: string[]): Promise<string> }

export function createGitClient(cwd: string, exec: ExecFn = execFileAsync as ExecFn): GitClient {
  return {
    async run(args) {
      try {
        const { stdout } = await exec("git", args, { cwd });
        return stdout;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new GitError(e.stderr || e.message || "git failed", e.stdout ?? "", e.stderr ?? "");
      }
    },
  };
}
