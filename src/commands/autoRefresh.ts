// Lazy background profile refresh.
//
// The L1→L2→L3 pipeline is expensive (many LLM calls), so it must never block
// the user. This module gates it behind a cheap "is there enough new material?"
// check against the L2 meta seen-id sets, then runs the pipeline fire-and-forget
// with a run-lock so two triggers can't interleave. The manual update path
// (pylearner.updateProfile / Profile panel) bypasses this gate entirely.

import * as vscode from "vscode";
import { CONFIG_KEYS, SURFACES } from "../constants";
import type { LlmRouter } from "../llm/router";
import { loadL2Meta } from "../memory/store";
import { DEFAULT_AUTO_REFRESH, shouldAutoRefresh } from "../memory/settings";
import { readTraceEntities } from "../snapshot/reader";
import { runProfileUpdate } from "./updateProfile";

export class ProfileRefresher {
  private running = false;
  private lastRunAt = 0;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly router: LlmRouter
  ) {}

  /** Fire-and-forget entry point. Never throws; safe to call on every trigger. */
  async maybeRefresh(): Promise<void> {
    if (this.running) return;

    const now = Date.now();
    const cfg = this.config();

    // Cooldown still active — skip without even counting new events.
    if (now - this.lastRunAt < cfg.cooldownMs) return;

    this.running = true;
    try {
      const newCount = await this.countNewEvents();
      if (!shouldAutoRefresh(newCount, now - this.lastRunAt, cfg)) return;

      this.lastRunAt = now;
      try {
        await runProfileUpdate(this.storageUri, this.secrets, this.router);
      } catch (err) {
        // A background refresh must never surface errors to the user.
        console.error("[pylearner] auto profile refresh failed:", err);
      }
    } catch (err) {
      console.error("[pylearner] auto refresh pre-check failed:", err);
    } finally {
      this.running = false;
    }
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration("pylearner");
    return {
      minNewEntities: cfg.get<number>(
        CONFIG_KEYS.autoRefreshThreshold,
        DEFAULT_AUTO_REFRESH.minNewEntities
      ),
      cooldownMs: cfg.get<number>(
        CONFIG_KEYS.autoRefreshCooldownMs,
        DEFAULT_AUTO_REFRESH.cooldownMs
      ),
    };
  }

  /** Count trace events across surfaces not yet seen by L2 consolidation. */
  private async countNewEvents(): Promise<number> {
    let total = 0;
    for (const surface of SURFACES) {
      const meta = await loadL2Meta(this.storageUri, surface);
      const seen = new Set(meta.seen_entity_refs);
      const entities = await readTraceEntities(this.storageUri, surface);
      for (const entity of entities) {
        if (!seen.has(`${surface}:${entity.id}`)) total += 1;
      }
    }
    return total;
  }
}
