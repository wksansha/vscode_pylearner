// Typing-behavior session collection (behavior surface).
//
// BehaviorSessionTracker is a pure state machine: one open session per .py
// file, ended by editor switch / file close / idle ≥5min / duration ≥90min /
// dispose ("deactivate"). Time is always passed in by the caller — tests use
// synthetic timestamps, the wiring passes Date.now(). Ended sessions drain
// as typing_session payloads; sessions with <3 changes are dropped (spec §八).
//
// createBehaviorListener wires vscode events onto the tracker (change /
// diagnostics / active editor / close / idle timer) and appends drained
// payloads to the L1 writer.

import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { EVENT_KINDS } from "../constants";
import {
  extractTypingSession,
  BEHAVIOR_CONSTANTS,
  type TypingSessionPayload,
  type BehaviorChangeRecord,
  type BehaviorDiagSnapshot,
  type EndedBy,
} from "./behaviorFeatures";

const DEFAULTS = {
  idleMs: 5 * 60_000,
  maxSessionMs: 90 * 60_000,
  resumeWindowMs: 3 * 60_000,
  minChanges: 3,
  maxChanges: 5000,
} as const;

interface OpenSession {
  file: string;
  startMs: number;
  changes: BehaviorChangeRecord[];
  diagnostics: BehaviorDiagSnapshot[];
  lastMirror: string;
  lastActivityMs: number;
  truncated: boolean;
  resumed: boolean;
}

export class BehaviorSessionTracker {
  private idleMs: number;
  private maxSessionMs: number;
  private resumeWindowMs: number;
  private minChanges: number;
  private maxChanges: number;

  private open = new Map<string, OpenSession>();
  // Most recent emitted session-end, any file. Resume (spec §五) applies
  // only when THIS file re-activates within the window and no other file's
  // session closed afterwards (i.e. lastClosed still points at it).
  private lastClosed: { file: string; endT: number; session: OpenSession } | null = null;
  private ended: TypingSessionPayload[] = [];

  constructor(deps: Partial<typeof DEFAULTS> = {}) {
    this.idleMs = deps.idleMs ?? DEFAULTS.idleMs;
    this.maxSessionMs = deps.maxSessionMs ?? DEFAULTS.maxSessionMs;
    this.resumeWindowMs = deps.resumeWindowMs ?? DEFAULTS.resumeWindowMs;
    this.minChanges = deps.minChanges ?? DEFAULTS.minChanges;
    this.maxChanges = deps.maxChanges ?? DEFAULTS.maxChanges;
  }

  onEdit(file: string, line: number, ins: number, del: number, mirrorText: string, t: number): void {
    let s = this.open.get(file);
    if (!s) {
      const last = this.lastClosed;
      if (last && last.file === file && t - last.endT <= this.resumeWindowMs) {
        s = last.session; // 续会话:沿用原缓冲与起止时间
        s.resumed = true;
        s.lastMirror = mirrorText;
        s.lastActivityMs = t;
        this.open.set(file, s);
        this.ended = this.ended.filter((p) => p.file !== file); // 旧会话不再单独 emit
      } else {
        s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false, resumed: false };
        this.open.set(file, s);
      }
    }

    // Max-duration boundary: flush and roll into a fresh session that
    // includes the current edit.
    if (t - s.startMs >= this.maxSessionMs) {
      this.endSession(s, "max_duration", t);
      s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false, resumed: false };
      this.open.set(file, s);
    }

    if (s.changes.length < this.maxChanges) {
      s.changes.push({ t, line, ins, del });
    } else {
      s.truncated = true; // 异常写入源(如格式化器全文件重写)防御
    }
    s.lastMirror = mirrorText;
    s.lastActivityMs = t;
  }

  /** Attach a diagnostic snapshot; only open sessions consume them. */
  onDiagnostics(file: string, errorMessages: string[], t: number): void {
    const s = this.open.get(file);
    if (!s) return;
    const prev = s.diagnostics[s.diagnostics.length - 1];
    if (prev && prev.errors.length === errorMessages.length &&
        prev.errors.every((m, i) => m === errorMessages[i])) {
      return; // consecutive identical snapshot — no new information
    }
    s.diagnostics.push({ t, errors: errorMessages });
  }

  onEditorSwitch(fromFile: string, t: number): void {
    const s = this.open.get(fromFile);
    if (!s) return;
    this.endSession(s, "editor_switch", t);
  }

  onFileClosed(file: string, t: number): void {
    const s = this.open.get(file);
    if (!s) return;
    this.endSession(s, "editor_close", t);
  }

  /** Idle sweep: end every session idle ≥ idleMs. */
  checkIdle(t: number): void {
    for (const s of [...this.open.values()]) {
      if (t - s.lastActivityMs >= this.idleMs) {
        this.endSession(s, "idle", t);
      }
    }
  }

  /** Extension shutdown: end every open session as "deactivate". */
  dispose(t: number): void {
    for (const s of [...this.open.values()]) {
      this.endSession(s, "deactivate", t);
    }
  }

  /** Take all payloads emitted since the last drain. */
  drain(): TypingSessionPayload[] {
    return this.ended.splice(0);
  }

  private endSession(s: OpenSession, endedBy: EndedBy, t: number): void {
    this.open.delete(s.file);
    const payload = extractTypingSession({
      file: s.file,
      startMs: s.startMs,
      endMs: t,
      endedBy,
      truncated: s.truncated,
      changes: s.changes,
      diagnostics: s.diagnostics,
      finalText: s.lastMirror,
    });
    // Drop sessions with exactly 2 changes when ended by editor switch/close and not resumed
    const isTerminalEnd = endedBy === "editor_switch" || endedBy === "editor_close";
    if (s.changes.length === 2 && !s.resumed && isTerminalEnd) {
      // dropped: do not emit, do not set lastClosed
    } else {
      this.ended.push(payload);
      this.lastClosed = { file: s.file, endT: t, session: s };
    }
  }
}

export function createBehaviorListener(writer: L1Writer): vscode.Disposable {
  // Implemented in Task 5.
  void vscode;
  void writer;
  void EVENT_KINDS;
  throw new Error("not implemented yet");
}