import type { Surface } from "../constants";

export interface TraceEvent {
  id: string;
  ts: string;
  surface: Surface;
  kind: string;
  payload: Record<string, unknown>;
  // Top-level (not buried in payload) so L2 can group events per session —
  // mirrors DeepTutor's TraceEvent shape (trace.py session_id/turn_id).
  session_id?: string;
}

export function makeEvent(
  surface: Surface,
  kind: string,
  payload: Record<string, unknown>,
  idGenerator: () => string,
  timestamp: () => string,
  sessionId?: string
): TraceEvent {
  const event: TraceEvent = {
    id: `${surface}:${idGenerator()}`,
    ts: timestamp(),
    surface,
    kind,
    payload,
  };
  if (sessionId) event.session_id = sessionId;
  return event;
}