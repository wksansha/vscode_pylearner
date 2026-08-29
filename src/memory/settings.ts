// Consolidation defaults + per-surface / per-slot focus & sections.
//
// Mirrors DeepTutor's settings.py + _meta.yaml, reduced to what the
// single-pass update flow needs. Defaults are constants (not user-tunable in
// P1) — tuning via configuration is a P1+ item.

import type { Surface } from "../constants";
import type { L3Slot } from "./paths";

export interface ChunkingSettings {
  overlapRatio: number;
  boundary: "paragraph" | "sentence";
  minChunkChars: number;
  maxChunkChars: number;
}

export interface ReferenceSettings {
  enforceRequired: boolean;
  dropInvalidRefs: boolean;
}

export interface MemorySettings {
  update: { l2Budget: number; l3Budget: number };
  chunking: ChunkingSettings;
  reference: ReferenceSettings;
}

export const MEMORY_SETTINGS: MemorySettings = {
  update: { l2Budget: 20, l3Budget: 10 },
  chunking: {
    overlapRatio: 0.1,
    boundary: "paragraph",
    minChunkChars: 1000,
    maxChunkChars: 64000,
  },
  reference: { enforceRequired: true, dropInvalidRefs: true },
};

export interface AutoRefreshSettings {
  /** Min new L1 events (across surfaces) before a background refresh fires. */
  minNewEntities: number;
  /** Min interval (ms) between automatic background refreshes. */
  cooldownMs: number;
}

export const DEFAULT_AUTO_REFRESH: AutoRefreshSettings = {
  minNewEntities: 20,
  cooldownMs: 300_000,
};

/**
 * Pure gate for the lazy background refresh: fire only once there is enough
 * new material AND enough time since the last run. `elapsedMs` is measured
 * since the previous refresh, so a fresh session (never run) has a large
 * value and only the threshold matters.
 */
export function shouldAutoRefresh(
  newCount: number,
  elapsedMs: number,
  cfg: AutoRefreshSettings
): boolean {
  return newCount >= cfg.minNewEntities && elapsedMs >= cfg.cooldownMs;
}

export interface SurfaceFocus {
  focus: string;
  sections: string[];
}

export const SURFACE_FOCUS: Record<Surface, SurfaceFocus> = {
  edit: {
    focus:
      "Recurring code patterns, preferred constructs, and files the user keeps editing. Drop keystroke-level noise.",
    sections: ["Patterns", "Habits", "Topics"],
  },
  run: {
    focus:
      "Error patterns across runs, what the user executes, and success/failure tendencies.",
    sections: ["Error patterns", "Habits", "Topics"],
  },
  chat: {
    focus:
      "Stable misconceptions the user surfaced, concepts they demonstrated mastery of, and durable topics they keep returning to.",
    sections: ["Misconceptions", "Mastery", "Topics"],
  },
  debug: {
    focus: "Debugging habits, breakpoint usage, and recurring session patterns.",
    sections: ["Patterns", "Habits", "Topics"],
  },
  diag: {
    focus: "Recurring diagnostic issues and how the user responds to them.",
    sections: ["Issues", "Habits", "Topics"],
  },
};

export const SLOT_FOCUS: Record<L3Slot, SurfaceFocus> = {
  profile: {
    focus:
      "Durable identity, learning style, and knowledge level. ONLY claims supported by multiple L2 entries across surfaces.",
    sections: ["Identity", "Learning style", "Knowledge level"],
  },
  scope: {
    focus: "Concepts and topics the user has demonstrably engaged with.",
    sections: ["Familiar", "Practicing", "Unsure"],
  },
  recent: {
    focus: "A rolling timeline of recent activity across surfaces.",
    sections: ["This week", "Earlier"],
  },
  preferences: {
    focus: "Explicitly stated preferences (not auto-consolidated in P1).",
    sections: ["Preferences"],
  },
};
