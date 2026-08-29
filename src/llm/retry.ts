// Resilient LLM invocation for the consolidation pipeline.
//
// Wraps a single streaming backend call with a per-attempt timeout and
// bounded retries with exponential backoff. A timeout aborts the in-flight
// request and fails immediately — a hanging model won't recover by being
// asked again — while transient errors (network, 5xx) retry. Pure module, no
// `vscode` import, so it unit-tests in isolation.

export interface RetryConfig {
  /** Total attempts, not additional retries. */
  maxRetries: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs: number;
  /** Backoff base; attempt n sleeps `baseDelayMs * 2^(n-1)` before retrying. */
  baseDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  timeoutMs: 30_000,
  baseDelayMs: 1_000,
};

export interface RetryResult {
  ok: boolean;
  text: string;
  /** Attempts actually made (1 on timeout, up to maxRetries on exhaustion). */
  attempts: number;
  timedOut: boolean;
  error: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callLlmWithRetry(
  doCall: (signal: AbortSignal) => Promise<string>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<RetryResult> {
  let lastError = "";
  let timedOut = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    attempts = attempt;
    const controller = new AbortController();
    let didTimeout = false;

    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, config.timeoutMs);

    try {
      const text = await doCall(controller.signal);
      return { ok: true, text, attempts: attempt, timedOut: false, error: "" };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (didTimeout) {
        timedOut = true;
        break; // a timeout is not retried
      }
      if (attempt < config.maxRetries) {
        await sleep(config.baseDelayMs * 2 ** (attempt - 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, text: "", attempts, timedOut, error: lastError };
}
