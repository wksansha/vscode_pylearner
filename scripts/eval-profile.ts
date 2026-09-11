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

// ── Probe questions: deliberately hit the profile's weak points ───────────────
const QUESTIONS = [
  "我在函数 show_all() 里面想用 students 这个变量，但程序说 students 未定义，我该怎么办？",
  "我写 def cal_average(scores) 的时候总是忘记加冒号，下一行就缩进报错，我该怎么记住这个规则？",
  "我用 input 输入成绩，然后想算平均分，但是报类型错误，我该怎么改？",
  "if choice = 1 和 if choice == 1 有什么区别？",
  "我写 import sy as asy 为什么报错？应该怎么写？",
  "我写 while Ture 为什么报错？怎么避免这种拼写错误？",
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
