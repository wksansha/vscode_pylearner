import type { Surface } from "../constants";

export interface TraceEvent {
  id: string;
  ts: string;
  surface: Surface;
  kind: string;
  payload: Record<string, unknown>;
}

export function makeEvent(
  surface: Surface,
  kind: string,
  payload: Record<string, unknown>,
  idGenerator: () => string,
  timestamp: () => string
): TraceEvent {
  return {
    id: `${surface}:${idGenerator()}`,
    ts: timestamp(),
    surface,
    kind,
    payload,
  };
}