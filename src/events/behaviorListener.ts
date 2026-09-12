// Typing-behavior session collection (behavior surface).
//
// BehaviorSessionTracker is a pure state machine: one open session per .py
// file, ended by editor switch / file close / idle ≥5min / duration ≥90min /
// dispose ("deactivate"). Time is always passed in by the caller — tests use
// synthetic timestamps, the wiring passes Date.now().
//
// Emission is deferred (park + materialize): an ended session waits in the
// single `closed` slot for the 3min resume window (spec §五 — a same-file
// re-activation within the window continues that session, reusing its
// buffer and start time). The payload is extracted only when the window
// expires (drain), when another session needs the slot (endSession), or on
// dispose — so a resumed stretch appears in the trace as ONE typing_session
// event, never as two overlapping ones. Sessions with <3 changes are
// dropped outright at endSession (spec §八) and are not resumable.
//
// createBehaviorListener wires vscode events onto the tracker (change /
// diagnostics / active editor / close / idle timer) and appends drained
// payloads to the L1 writer.

import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { EVENT_KINDS } from "../constants";
import {
  extractTypingSession,
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
}

// A session that has ended but is held for the 3min resume window. Only the
// most recent closed session is resumable (spec §五: no other file's session
// may have intervened).
interface ClosedSession {
  file: string;
  endT: number;
  endedBy: EndedBy;
  session: OpenSession;
}

export class BehaviorSessionTracker {
  private idleMs: number;
  private maxSessionMs: number;
  private resumeWindowMs: number;
  private minChanges: number;
  private maxChanges: number;

  private open = new Map<string, OpenSession>();
  private closed: ClosedSession | null = null;
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
      const c = this.closed;
      if (c && c.file === file && t - c.endT <= this.resumeWindowMs) {
        s = c.session; // 续会话:沿用原缓冲与起止时间(spec §五)
        this.closed = null;
        s.lastMirror = mirrorText;
        s.lastActivityMs = t;
        this.open.set(file, s);
      } else {
        s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false };
        this.open.set(file, s);
      }
    }

    // Max-duration boundary: flush and roll into a fresh session that
    // includes the current edit.
    if (t - s.startMs >= this.maxSessionMs) {
      this.endSession(s, "max_duration", t);
      s = { file, startMs: t, changes: [], diagnostics: [], lastMirror: mirrorText, lastActivityMs: t, truncated: false };
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

  /** Extension shutdown: end every open session as "deactivate" and flush
   *  everything (open sessions AND any session parked for its resume window)
   *  so nothing is lost on shutdown. */
  dispose(t: number): void {
    for (const s of [...this.open.values()]) {
      this.endSession(s, "deactivate", t);
    }
    this.materializeClosed();
  }

  /**
   * Take all payloads whose resume window has expired as of `t`, plus any
   * emitted since the last drain. The wiring calls this with Date.now()
   * after every event batch, so a parked payload lands in the trace at the
   * first event/drain after its window expires.
   */
  drain(t: number): TypingSessionPayload[] {
    this.materializeExpired(t);
    return this.ended.splice(0);
  }

  // An ended session waits in `closed` for the resume window; the payload
  // is extracted (materialized) when the window expires, when another
  // session needs the slot, or at dispose. A resumed session never
  // materializes its pre-resume state — the merged session emits once.
  private materializeExpired(t: number): void {
    if (this.closed && t - this.closed.endT > this.resumeWindowMs) {
      this.materializeClosed();
    }
  }

  private materializeClosed(): void {
    const c = this.closed;
    if (!c) return;
    this.closed = null;
    this.ended.push(extractTypingSession({
      file: c.file,
      startMs: c.session.startMs,
      endMs: c.endT,
      endedBy: c.endedBy,
      truncated: c.session.truncated,
      changes: c.session.changes,
      diagnostics: c.session.diagnostics,
      finalText: c.session.lastMirror,
    }));
  }

  private endSession(s: OpenSession, endedBy: EndedBy, t: number): void {
    this.open.delete(s.file);
    this.materializeClosed(); // 单槽位让位:上一个挂起会话此时落定为最终 payload
    // 空会话(<3 次变更)不写事件也不可续(spec §八)。
    if (s.changes.length < this.minChanges) return;
    this.closed = { file: s.file, endT: t, endedBy, session: s };
  }
}

export function createBehaviorListener(writer: L1Writer): vscode.Disposable {
  // Implemented in Task 5.
  void vscode;
  void writer;
  throw new Error("not implemented yet");
}
