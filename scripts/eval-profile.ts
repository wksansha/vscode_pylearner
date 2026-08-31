// One-off A/B eval: tutor answers with vs. without the learner profile.
//
// Reuses the real injection + rendering code so the "with profile" system
// prompt is byte-identical to what the extension sends. Bundles only the pure
// modules (openai/ollama backends, document, profileInjector) — no vscode.
//
// Run from repo root:
//   npx esbuild scripts/eval-profile.ts --bundle --platform=node --format=cjs \
//     --outfile=out/eval-profile.cjs && node out/eval-profile.cjs
//
// Config (CLI `--name=value` wins over env):
//   --provider   openai | ollama   (LLM_PROVIDER, default openai)
//   --base-url   http://...        (LLM_BASE_URL)
//   --api-key    sk-...            (LLM_API_KEY, required for openai)
//   --model      <name>            (LLM_MODEL)
//   --profile    <path>            (PROFILE_PATH; if missing, synthetic profile)
//
// Edit QUESTIONS below to change the probe set.

import { readFileSync, existsSync } from "node:fs";
import { OpenAIBackend } from "../src/llm/openai";
import { OllamaBackend } from "../src/llm/ollama";
import type { LlmBackend, LlmMessage } from "../src/llm/router";
import { parse, renderBody } from "../src/memory/document";
import { injectProfile } from "../src/memory/profileInjector";

const BASE_SYSTEM_PROMPT =
  "You are a helpful Python learning assistant. Provide clear, concise explanations with code examples when relevant.";

// ── Synthetic profile (used when --profile isn't given) ──────────────────
const SYNTHETIC_BODY = `# Python Learner Profile

## Learning Style
- Prefers concrete examples before abstract explanations

## Strengths
- Solid grasp of Python basics (variables, loops, functions)
- Good at reading error messages and debugging

## Areas for Improvement
- Struggles with async/await concepts
- Needs more practice with class inheritance and self parameter

## Progress
- In progress: OOP, decorators
- Not started: async, metaclasses

## Preferences
- Uses f-strings consistently`;

// ── Probe questions: deliberately hit the profile's claims ───────────────
const QUESTIONS = [
  "我最近想学点新的 Python 内容，你建议我练什么？",
  "帮我复习一下列表推导式（list comprehension）。",
  "解释一下装饰器（decorator），尽量详细。",
  "我跑 Python 代码老报错，该怎么办？",
  "我该不该现在去学 metaclass？",
  "给我讲讲 async/await 是干嘛的。",
];

// ── Config ───────────────────────────────────────────────────────────────
function arg(name: string, env: string, def = ""): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag !== undefined) return flag.slice(`--${name}=`.length);
  return process.env[env] ?? def;
}

const provider = arg("provider", "LLM_PROVIDER", "openai");
const baseUrl = arg(
  "base-url",
  "LLM_BASE_URL",
  provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com"
);
const apiKey = arg("api-key", "LLM_API_KEY", "");
const model = arg(
  "model",
  "LLM_MODEL",
  provider === "ollama" ? "codellama" : "gpt-4o-mini"
);
const profilePath = arg("profile", "PROFILE_PATH", "");

function loadProfileBody(): string {
  if (profilePath && existsSync(profilePath)) {
    return renderBody(parse(readFileSync(profilePath, "utf8")));
  }
  return SYNTHETIC_BODY;
}

async function complete(
  backend: LlmBackend,
  system: string,
  user: string
): Promise<string> {
  let out = "";
  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  await backend.chat(
    messages,
    (chunk) => (out += chunk),
    AbortSignal.timeout(180_000)
  );
  return out.trim();
}

async function main(): Promise<void> {
  if (provider === "openai" && !apiKey) {
    console.error("openai 需要 --api-key 或 LLM_API_KEY");
    process.exit(1);
  }

  const config = { provider, baseUrl, apiKey, model };
  const backend: LlmBackend =
    provider === "ollama"
      ? new OllamaBackend(config)
      : new OpenAIBackend(config);

  const profileBody = loadProfileBody();
  const withProfile = injectProfile(BASE_SYSTEM_PROMPT, profileBody);

  console.log(
    `provider=${provider}  model=${model}  profile=${profilePath || "(synthetic)"}\n`
  );

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    console.log(
      `\n━━━ Q${i + 1}/${QUESTIONS.length} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    );
    console.log(q);

    const without = await complete(backend, BASE_SYSTEM_PROMPT, q);
    console.log("\n【不带画像】");
    console.log(without);

    const withAns = await complete(backend, withProfile, q);
    console.log("\n【带画像】");
    console.log(withAns);

    console.log("\n──────────────────────────────────────────────");
  }

  console.log(
    "\n对比维度：个性化 / 跳过已掌握 / 针对薄弱点 / 准确性 / 是否被画像带偏。"
  );
}

main().catch((err) => {
  console.error("eval failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
