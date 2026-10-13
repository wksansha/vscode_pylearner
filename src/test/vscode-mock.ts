import { vi } from "vitest";

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
    joinPath(base: { toString(): string }, ...paths: string[]) {
      const url = new URL(base.toString());
      const joined = [url.pathname, ...paths].join("/").replace(/\/+/g, "/");
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
  workspace: {
    fs: {
      readFile: vi.fn(),
      readDirectory: vi.fn(),
      createDirectory: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
