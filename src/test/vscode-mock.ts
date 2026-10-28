import { vi } from "vitest";

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
    joinPath(base: { toString(): string }, ...paths: string[]) {
      // 与真实 vscode-uri 语义一致：空路径段被忽略（否则空 rel 会产生尾斜杠）
      const url = new URL(base.toString());
      const joined = [url.pathname, ...paths.filter((p) => p.length > 0)].join("/").replace(/\/+/g, "/");
      url.pathname = joined;
      return {
        toString: () => url.toString(),
        path: url.pathname,
      };
    },
    parse(value: string) {
      const url = new URL(value);
      return {
        toString: () => url.toString(),
        path: url.pathname,
      };
    },
  },
  languages: {
    onDidChangeDiagnostics: vi.fn(() => ({ dispose: vi.fn() })),
    getDiagnostics: vi.fn(),
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  workspace: {
    fs: {
      readFile: vi.fn(),
      readDirectory: vi.fn(),
      createDirectory: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
    getConfiguration: vi.fn(() => ({ get: () => true })),
    getWorkspaceFolder: vi.fn(() => undefined),
    asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath.replace(/^\//, "")),
  },
}));
