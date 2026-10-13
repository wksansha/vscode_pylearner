import * as vscode from "vscode";
import { ulid } from "ulidx";
import type { Surface } from "../constants";
import type { TraceEvent } from "../events/types";
import { makeEvent } from "../events/types";
import { studentDirName, UNKNOWN_DIR } from "../archive/identity";

export interface TeacherReporter {
  report(event: TraceEvent): Promise<void>;
}

/** 学号目录下的身份快照（供归档批次取身份，spec §4.3） */
export interface ArchiveIdentity {
  studentId: string;
  studentName: string;
  classId: string;
}

/** append 时读取的当前身份；classId 缺省由快照层补 default */
export type IdentityProvider = () => { studentId: string | null; studentName: string | null; classId?: string } | undefined;

export class L1Writer {
  private baseUri: vscode.Uri;
  private locks: Map<string, Promise<void>> = new Map();
  private reporter?: TeacherReporter;
  private submissionHandler?: (event: TraceEvent) => void;
  private getIdentity?: IdentityProvider;
  // identity.json 变更检测（内存缓存，避免每事件读盘）
  private lastIdentityJson: string | null = null;

  constructor(storageUri: vscode.Uri) {
    this.baseUri = vscode.Uri.joinPath(storageUri, "trace");
  }

  setTeacherReporter(reporter: TeacherReporter | undefined) {
    this.reporter = reporter;
  }

  setSubmissionHandler(handler?: (event: TraceEvent) => void) {
    this.submissionHandler = handler;
  }

  /** 注入身份读取器：每次 append 时调用，学号变更后下一条事件立即落新目录（spec §4.1） */
  setIdentityProvider(provider?: IdentityProvider) {
    this.getIdentity = provider;
  }

  async append(
    surface: Surface,
    kind: string,
    payload: Record<string, unknown>,
    sessionId?: string
  ): Promise<void> {
    const event = makeEvent(surface, kind, payload, () => ulid(), () =>
      new Date().toISOString(), sessionId
    );
    await this.writeEvent(event);

    // 异步上报到教师端（非阻塞，失败不影响 L1 持久化）
    if (this.reporter && shouldReportToTeacher(surface, kind)) {
      this.reporter.report(event).catch((err: unknown) => {
        console.warn("[L1Writer] 教师端上报失败:", err instanceof Error ? err.message : String(err));
      });
    }

    // 分发给提交通道（仅 run success；失败不影响 L1 持久化）
    if (this.submissionHandler && surface === "run" && kind === "execution_success") {
      try {
        this.submissionHandler(event);
      } catch (err: unknown) {
        console.warn("[L1Writer] 提交通道分发失败:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async writeEvent(event: TraceEvent): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dirName = studentDirName(this.getIdentity?.()?.studentId ?? null);
    const dirUri = vscode.Uri.joinPath(this.baseUri, dirName, event.surface);
    const fileUri = vscode.Uri.joinPath(dirUri, `${today}.jsonl`);
    const line = JSON.stringify(event) + "\n";

    // Serialize writes per surface to avoid interleaving. The stored lock is
    // normalized to never reject — one failed append must not poison the chain
    // (a rejected promise would make every later `.then` skip, silently
    // killing the surface). Callers still see the real error via `await next`.
    const prev = this.locks.get(event.surface) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(dirUri);
      } catch {
        // directory exists
      }
      await this.writeIdentitySnapshot(dirName);
      const encoder = new TextEncoder();
      let existing: Uint8Array;
      try {
        existing = await vscode.workspace.fs.readFile(fileUri);
      } catch {
        existing = new Uint8Array(0);
      }
      const combined = new Uint8Array(existing.length + encoder.encode(line).length);
      combined.set(existing, 0);
      combined.set(encoder.encode(line), existing.length);
      await vscode.workspace.fs.writeFile(fileUri, combined);
    });
    this.locks.set(event.surface, next.catch(() => {}));
    await next;
  }

  /** 学号目录下维护 .identity.json（仅内容变化时覆写；写失败不影响事件落盘） */
  private async writeIdentitySnapshot(dirName: string): Promise<void> {
    const identity = this.getIdentity?.();
    if (!identity?.studentId || !identity.studentName || dirName === UNKNOWN_DIR) return;
    const snapshot: ArchiveIdentity = {
      studentId: identity.studentId,
      studentName: identity.studentName,
      classId: identity.classId || "default",
    };
    const json = JSON.stringify(snapshot);
    if (json === this.lastIdentityJson) return;
    this.lastIdentityJson = json;
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.baseUri, dirName, ".identity.json"),
        new TextEncoder().encode(json + "\n")
      );
    } catch {
      // 快照写失败下一条事件会再试
    }
  }
}

function shouldReportToTeacher(surface: Surface, kind: string): boolean {
  return (
    (surface === "diag" && kind === "diagnostics_change") ||
    (surface === "run" && (kind === "execution_success" || kind === "execution_error"))
  );
}
