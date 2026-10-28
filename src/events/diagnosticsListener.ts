import * as vscode from "vscode";
import type { L1Writer } from "../storage/l1Writer";
import { CONFIG_KEYS, EVENT_KINDS } from "../constants";

/**
 * 诊断事件监听（2026-10-28 事件降噪方案 §一：错误存活窗口）
 *
 * 瞬态打字中间态（如敲下 `def` 尚未写函数名时的语法错误）存活仅数秒，
 * 旧实现去抖 1.5s 不足以过滤；本实现改为「错误存活窗口」：
 *   - 每个错误指纹（消息+起始位置）记录首次出现时刻
 *   - 存活 ≥ PERSIST_MS 仍未消失 → 上报一次（同一指纹不重复报）
 *   - 窗口内消失 → 视为打字噪音，永不进日志（消失后再现视为新错误重新计时）
 * 不上报「错误清零」事件：状态机中 diag success 仅为活动信号，无清零语义
 * （评审通过才清零，见 stateManager.apply）。
 * 详见 docs/superpowers/plans/2026-10-28-diag-persistence-window-and-event-trim.md。
 */

/** 错误存活窗口：瞬态打字中间态（存活 < 窗口）不报，持续存在的真错误才上报 */
const PERSIST_MS = 30_000;
/** 诊断变化后的收敛去抖：等语言服务稳定再取快照 */
const SETTLE_MS = 500;

/** 错误指纹：起始位置 + 消息（同一错误在不同打字阶段措辞可能变化，指纹变化视为新错误重新计时） */
const fingerprint = (d: vscode.Diagnostic): string =>
  `${d.range.start.line}:${d.range.start.character}:${d.message}`;

interface FileSnap {
  uri: vscode.Uri;
  file: string;
  errors: number;
  warnings: number;
  samples: string[];
  fps: string[];
}

export function createDiagnosticsListener(writer: L1Writer): vscode.Disposable {
  const snaps = new Map<string, FileSnap>();                 // fileKey -> 最新诊断快照
  const firstSeen = new Map<string, Map<string, number>>();  // fileKey -> 指纹 -> 首见时刻
  const reported = new Map<string, Set<string>>();           // fileKey -> 已上报指纹
  const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const isPythonFile = (uri: vscode.Uri) => uri.scheme === "file" && uri.fsPath.endsWith(".py");

  /** 诊断开关：沿用 monitorEdit（与历史行为一致） */
  const isEnabled = () =>
    vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEYS.monitorEdit, true);

  /** 有未报满存活窗口的指纹时排程对账；对账时点 = 最早首见 + PERSIST_MS */
  function scheduleCheck(key: string) {
    if (checkTimers.has(key)) return;
    const seen = firstSeen.get(key);
    if (!seen) return;
    const rep = reported.get(key);
    const now = Date.now();
    let earliest = Infinity;
    for (const [fp, t0] of seen) {
      if (rep?.has(fp)) continue;
      earliest = Math.min(earliest, t0);
    }
    if (earliest === Infinity) return;   // 无待上报指纹
    const wait = Math.max(250, earliest + PERSIST_MS - now);
    checkTimers.set(key, setTimeout(() => {
      checkTimers.delete(key);
      reconcile(key);
    }, wait));
  }

  /** 对账：当前快照中存活已满窗口且未报过的指纹 → 上报一次 */
  function reconcile(key: string) {
    const snap = snaps.get(key);
    const seen = firstSeen.get(key);
    if (!snap || !seen) return;
    const rep = reported.get(key) ?? new Set<string>();
    const now = Date.now();
    let newly = 0;
    for (const fp of snap.fps) {
      const t0 = seen.get(fp);
      if (t0 === undefined || rep.has(fp)) continue;
      if (now - t0 >= PERSIST_MS) {
        rep.add(fp);
        newly++;
      }
    }
    if (rep.size > 0) reported.set(key, rep);
    if (newly > 0) {
      writer.append("diag", EVENT_KINDS.diagnosticsChange, {
        file: snap.file,
        errors: snap.errors,
        warnings: snap.warnings,
        samples: snap.samples.length > 0 ? snap.samples : undefined,
      });
    }
    scheduleCheck(key);   // 仍有未满窗口的指纹则继续排程
  }

  /** 取当前诊断快照 + 维护指纹生命周期（消失的错误清除首见/已报标记） */
  function updateSnapshot(uri: vscode.Uri) {
    const key = uri.toString();
    const diagnostics = vscode.languages.getDiagnostics(uri);
    let errors = 0;
    let warnings = 0;
    const errDiags: vscode.Diagnostic[] = [];
    for (const d of diagnostics) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors++;
        errDiags.push(d);
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnings++;
      }
    }
    const fps = errDiags.map(fingerprint);
    const samples = errDiags.slice(0, 5).map((d) => d.message.slice(0, 200));
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(uri);
    const file = workspaceRoot
      ? vscode.workspace.asRelativePath(uri, false)
      : uri.fsPath;
    snaps.set(key, { uri, file, errors, warnings, samples, fps });

    const seen = firstSeen.get(key) ?? new Map<string, number>();
    firstSeen.set(key, seen);
    for (const fp of [...seen.keys()]) {
      if (!fps.includes(fp)) {
        seen.delete(fp);
        reported.get(key)?.delete(fp);
      }
    }
    const now = Date.now();
    for (const fp of fps) if (!seen.has(fp)) seen.set(fp, now);
    scheduleCheck(key);
  }

  const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
    if (!isEnabled()) return;
    for (const uri of e.uris) {
      if (!isPythonFile(uri)) continue;
      const key = uri.toString();
      const existing = settleTimers.get(key);
      if (existing) clearTimeout(existing);
      settleTimers.set(key, setTimeout(() => {
        settleTimers.delete(key);
        updateSnapshot(uri);
      }, SETTLE_MS));
    }
  });

  return {
    dispose() {
      for (const t of [...checkTimers.values(), ...settleTimers.values()]) clearTimeout(t);
      checkTimers.clear();
      settleTimers.clear();
      snaps.clear();
      firstSeen.clear();
      reported.clear();
      disposable.dispose();
    },
  };
}
