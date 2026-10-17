/**
 * 教师端上报器（spec §6.1）
 *
 * 将 L1 TraceEvent 原样平铺上报（全 surface，服务端决定是否解释/进看板）。
 * 由 L1Writer.setTeacherReporter() 注入。10s 超时；失败只打日志不重试
 * （幂等与补传由归档通道承担）。
 */

import type { TraceEvent } from "../events/types";

export interface TeacherReporterDeps {
  teacherUrl: string;
  /** 每次上报时调用（而非激活时固化），学号/姓名修改后下一次上报立即生效 */
  getIdentity: () => { studentId: string | null; studentName: string | null; classId?: string };
}

const FETCH_TIMEOUT_MS = 10_000;

export function createTeacherReporter(deps: TeacherReporterDeps) {
  const { teacherUrl } = deps;

  return {
    async report(event: TraceEvent): Promise<void> {
      const identity = deps.getIdentity();
      // 身份门控（A8）：未设身份不上报，本地 L1 照记
      if (!identity.studentId || !identity.studentName) {
        console.log("[TeacherReporter] 身份未设置，跳过上报（本地 L1 照记）");
        return;
      }
      const body = {
        id: event.id,
        ts: event.ts,
        surface: event.surface,
        kind: event.kind,
        payload: event.payload,
        ...(event.session_id ? { session_id: event.session_id } : {}),
        student_id: identity.studentId,
        student_name: identity.studentName,
        class_id: identity.classId || "default",
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(teacherUrl + "/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(`[TeacherReporter] 上报失败 (${res.status}):`, await res.text().catch(() => ""));
        }
      } catch (err) {
        // 网络不可用/超时只打日志，不影响 L1 写入
        console.warn("[TeacherReporter] 无法连接教师端:", err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
