import { describe, it, expect } from "vitest";
import { callLlmWithRetry } from "../../llm/retry";

const FAST = { maxRetries: 3, timeoutMs: 100, baseDelayMs: 1 };

describe("callLlmWithRetry", () => {
  it("returns the text on first success", async () => {
    const r = await callLlmWithRetry(async () => "ok", FAST);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("ok");
    expect(r.attempts).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const r = await callLlmWithRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    }, FAST);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("recovered");
    expect(r.attempts).toBe(3);
  });

  it("returns failure after exhausting retries", async () => {
    const r = await callLlmWithRetry(
      async () => {
        throw new Error("boom");
      },
      { maxRetries: 2, timeoutMs: 100, baseDelayMs: 1 }
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.timedOut).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("does not retry on timeout", async () => {
    let calls = 0;
    const r = await callLlmWithRetry(async (signal) => {
      calls += 1;
      return new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }, { maxRetries: 3, timeoutMs: 20, baseDelayMs: 1 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.attempts).toBe(1); // no retry after a timeout
    expect(calls).toBe(1);
  });

  it("passes a real AbortSignal to the call", async () => {
    let sawSignal = false;
    await callLlmWithRetry(async (signal) => {
      sawSignal = signal instanceof AbortSignal;
      return "x";
    }, FAST);
    expect(sawSignal).toBe(true);
  });
});
