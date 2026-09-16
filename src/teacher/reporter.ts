/**
 * 教师端上报器
 *
 * 将学生端的 diag/run L1 事件上报到教师端服务器。
 * 由 L1Writer.setTeacherReporter() 注入。
 */

import type { TraceEvent } from "../events/types";
import * as vscode from "vscode";

export interface TeacherReporterDeps {
  teacherUrl: string;
  studentId: string;
  studentName: string;
  classId?: string;
}

export function createTeacherReporter(deps: TeacherReporterDeps) {
  const { teacherUrl, studentId, studentName, classId } = deps;

  return {
    async report(event: TraceEvent): Promise<void> {
      const payload = buildPayload(event);
      if (!payload) return;

      try {
        const res = await fetch(teacherUrl + "/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          console.warn(
            `[TeacherReporter] 上报失败 (${res.status}):`,
            await res.text().catch(() => "")
          );
        }
      } catch (err) {
        // 网络不可用时只打日志，不影响 L1 写入
        console.warn("[TeacherReporter] 无法连接教师端:", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function buildPayload(event: TraceEvent) {
  const base = {
    student_id: studentId,
    student_name: studentName,
    class_id: classId || "default",
    timestamp: event.ts,
    event_type: event.surface, // "diag" | "run"
  };

  // diag 事件
  if (event.surface === "diag") {
    const p = event.payload as {
      file?: string;
      errors?: number;
      warnings?: number;
      samples?: string[];
    };

    if (!p.samples || p.samples.length === 0) return null;

    // 如果没有错误（或警告数为0且错误数为0），不上报
    if ((p.errors || 0) === 0 && (p.warnings || 0) === 0) return null;

    return {
      ...base,
      raw_message: p.samples[0] || "",
      samples: p.samples,
      error_type: "DiagnosticError",
      error_message: p.samples.join("; "),
      file_path: p.file,
    };
  }

  // run 事件（只上报错误）
  if (event.surface === "run" && event.kind === "execution_error") {
    const p = event.payload as {
      error_type?: string;
      error_message?: string;
      command?: string;
      exit_code?: number;
      file?: string;
      line?: number;
      source?: string;
    };

    if (!p.error_type || !p.error_message) return null;

    return {
      ...base,
      raw_message: p.error_message,
      error_type: p.error_type,
      error_message: p.error_message,
      command: p.command,
      exit_code: p.exit_code,
      file_path: p.file,
      line_no: p.line,
      source: p.source,
    };
  }

  return null;
}
