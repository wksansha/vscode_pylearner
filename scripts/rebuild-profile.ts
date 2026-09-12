// Full L2+L3 rebuild from the on-disk trace: wipe all L2 docs + metas and
// the L3 profile, then re-run updateL2 for every surface, updateL3(profile),
// and the Chinese translation pass — printing the rendered display view.
//
// Why a reset is needed: the L2/L3 meta sidecars already mark every existing
// trace entity / L2 entry as "seen", so a normal Update is a no-op. Only a
// reset makes the fixed pipeline re-process existing data (2026-09-11 spec).
//
// L2 .md files are deleted too: old entries carry the old flattened sections
// (Patterns/Topics); appendFactsToDoc only appends, so re-organizing into
// per-knowledge-point sections requires starting from an empty doc.
//
// Run from repo root:
//   npx esbuild scripts/rebuild-profile.ts --bundle --platform=node --format=cjs \
//     --outfile=out/rebuild-profile.cjs && node out/rebuild-profile.cjs [flags]
//
// Flags (CLI wins over env, same convention as eval-profile.ts):
//   --storage     <dir>  globalStorage root; default
//                        %APPDATA%/Code/User/globalStorage/deeptutor.vscode-pylearner
//   --reset-only         delete L2/L3 docs+metas, then exit (no LLM — smoke test)
//   --provider    openai | ollama
//   --base-url    http://...
//   --api-key     sk-...           (required for openai)
//   --model       <name>
//
// Bundle constraint: NO runtime vscode imports in this closure — store.ts /
// paths.ts / reader.ts are vscode-coupled, so the thin fs layer below is
// reimplemented with node:fs. `import type { L3Slot }` from paths is fine
// (type-only, erased by esbuild).

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { SURFACES, type Surface } from "../src/constants";
import { parse, serialize, renderDisplay, type Document } from "../src/memory/document";
import {
  newL2Meta,
  newL3Meta,
  parseL2Meta,
  parseL3Meta,
  serializeL2Meta,
  serializeL3Meta,
  type L2Meta,
  type L3Meta,
} from "../src/memory/meta";
import type { L3Slot } from "../src/memory/paths"; // type-only — erased, never bundled
import { translateL3Doc } from "../src/memory/translate";
import { synthesizeOverview } from "../src/memory/overview";
import { updateL2, updateL3, type ConsolidatorDeps } from "../src/memory/update";
import { parseTraceLine, traceEventToEntity } from "../src/snapshot/adapter";
import type { Entity } from "../src/snapshot/entity";
import { MEMORY_SETTINGS } from "../src/memory/settings";
import { callLlmWithRetry, DEFAULT_RETRY_CONFIG } from "../src/llm/retry";
import { OpenAIBackend } from "../src/llm/openai";
import { OllamaBackend } from "../src/llm/ollama";
import type { LlmBackend, LlmMessage } from "../src/llm/router";

// ── Config ───────────────────────────────────────────────────────────────

function arg(name: string, env: string, def = ""): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag !== undefined) return flag.slice(`--${name}=`.length);
  return process.env[env] ?? def;
}

const defaultStorage = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Code", "User", "globalStorage", "deeptutor.vscode-pylearner")
  : "";
const storageDir = path.resolve(arg("storage", "PYLEARNER_STORAGE", defaultStorage));
const resetOnly = process.argv.includes("--reset-only");

const provider = arg("provider", "LLM_PROVIDER", "openai");
const baseUrl = arg(
  "base-url",
  "LLM_BASE_URL",
  provider === "ollama" ? "http://localhost:11434" : "https://api.openai.com"
);
const apiKey = arg("api-key", "LLM_API_KEY", "");
const model = arg("model", "LLM_MODEL", provider === "ollama" ? "codellama" : "gpt-4o-mini");
const config = { provider, baseUrl, apiKey, model };

// ── Thin fs layer (store.ts is vscode-coupled — reimplement here) ───────

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, file); // atomic on the same filesystem
}

async function rmIfExists(file: string): Promise<boolean> {
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

// ── Doc + meta I/O ───────────────────────────────────────────────────────

function l2DocFile(surface: string): string {
  return path.join(storageDir, "l2", `${surface}.md`);
}
function l2MetaPath(surface: string): string {
  return path.join(storageDir, "l2", `${surface}.meta.json`);
}
function l3DocPath(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}.md`);
}
function l3MetaPath(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}.meta.json`);
}
function overviewFileFs(slot: L3Slot): string {
  return path.join(storageDir, "l3", `${slot}-overview.md`);
}

async function loadL2DocFs(surface: string): Promise<Document | null> {
  const text = await readText(l2DocFile(surface));
  return text === null ? null : parse(text);
}
async function saveL2DocFs(surface: string, doc: Document): Promise<void> {
  await writeTextAtomic(l2DocFile(surface), serialize(doc));
}
async function loadL3DocFs(slot: L3Slot): Promise<Document | null> {
  const text = await readText(l3DocPath(slot));
  return text === null ? null : parse(text);
}
async function saveL3DocFs(slot: L3Slot, doc: Document): Promise<void> {
  await writeTextAtomic(l3DocPath(slot), serialize(doc));
}

async function loadL2MetaFs(surface: string): Promise<L2Meta> {
  const text = await readText(l2MetaPath(surface));
  if (text === null) return newL2Meta();
  try {
    return parseL2Meta(JSON.parse(text));
  } catch {
    return newL2Meta();
  }
}
async function saveL2MetaFs(surface: string, meta: L2Meta): Promise<void> {
  await writeTextAtomic(l2MetaPath(surface), JSON.stringify(serializeL2Meta(meta), null, 2) + "\n");
}
async function loadL3MetaFs(slot: L3Slot): Promise<L3Meta> {
  const text = await readText(l3MetaPath(slot));
  if (text === null) return newL3Meta();
  try {
    return parseL3Meta(JSON.parse(text));
  } catch {
    return newL3Meta();
  }
}
async function saveL3MetaFs(slot: L3Slot, meta: L3Meta): Promise<void> {
  await writeTextAtomic(l3MetaPath(slot), JSON.stringify(serializeL3Meta(meta), null, 2) + "\n");
}

// ── Trace reader (reader.ts is vscode-coupled — reimplement here) ───────

async function readTraceEntitiesFs(surface: Surface): Promise<Entity[]> {
  const dir = path.join(storageDir, "trace", surface);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  const entities: Entity[] = [];
  for (const name of names) {
    const text = await readText(path.join(dir, name));
    if (text === null) continue;
    for (const line of text.split("\n")) {
      const event = parseTraceLine(line);
      if (event && event.surface === surface) entities.push(traceEventToEntity(event));
    }
  }
  return entities;
}

// ── Consolidator deps ────────────────────────────────────────────────────

function makeDeps(backend: LlmBackend): ConsolidatorDeps {
  return {
    readEntities: (surface) => readTraceEntitiesFs(surface),
    loadAllL2Docs: async () => {
      const docs: Record<string, Document> = {};
      for (const surface of SURFACES) {
        const doc = await loadL2DocFs(surface);
        if (doc) docs[surface] = doc;
      }
      return docs;
    },
    loadL2Meta: loadL2MetaFs,
    saveL2Meta: saveL2MetaFs,
    loadL3Meta: loadL3MetaFs,
    saveL3Meta: saveL3MetaFs,
    loadL2Doc: loadL2DocFs,
    saveL2Doc: saveL2DocFs,
    loadL3Doc: loadL3DocFs,
    saveL3Doc: saveL3DocFs,
    callLlm: async (system, user, context) => {
      const label = context ?? "unknown";
      const start = Date.now();
      const messages: LlmMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      // Same retry posture as the extension's runProfileUpdate: per-attempt
      // timeout + bounded retries, so one slow model call can't kill the run.
      const result = await callLlmWithRetry(
        async (signal) => {
          let out = "";
          await backend.chat(messages, (chunk) => (out += chunk), signal);
          return out;
        },
        { ...DEFAULT_RETRY_CONFIG, timeoutMs: 240_000, baseDelayMs: 2_000 },
        (attempt, elapsedMs, timedOut, errorMsg) => {
          console.log(
            `[llm] ${label} attempt ${attempt} ${timedOut ? "TIMEOUT" : errorMsg ? "FAIL" : "done"} (${elapsedMs}ms)`
          );
        }
      );
      if (!result.ok) {
        throw new Error(
          `${label}: ${result.timedOut ? "timeout" : result.error} after ${result.attempts} attempt(s)`
        );
      }
      console.log(`[llm] ${label} ok (${Date.now() - start}ms)`);
      return result.text ?? "";
    },
  };
}

// ── Reset ────────────────────────────────────────────────────────────────

async function resetStorage(): Promise<void> {
  let removed = 0;
  for (const surface of SURFACES) {
    if (await rmIfExists(l2DocFile(surface))) removed += 1;
    if (await rmIfExists(l2MetaPath(surface))) removed += 1;
  }
  if (await rmIfExists(l3DocPath("profile"))) removed += 1;
  if (await rmIfExists(l3MetaPath("profile"))) removed += 1;
  if (await rmIfExists(overviewFileFs("profile"))) removed += 1;
  console.log(`reset: removed ${removed} file(s) under ${storageDir}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!storageDir || !fs.existsSync(storageDir)) {
    console.error(`storage dir not found: ${storageDir} (pass --storage=<dir>)`);
    process.exit(1);
  }

  const totalStart = Date.now();

  const resetStart = Date.now();
  await resetStorage();
  console.log(`[timing] reset: ${Date.now() - resetStart}ms`);
  if (resetOnly) {
    console.log(`[timing] total: ${Date.now() - totalStart}ms`);
    return;
  }

  if (provider === "openai" && !apiKey) {
    console.error("openai 需要 --api-key 或 LLM_API_KEY");
    process.exit(1);
  }
  const backend: LlmBackend =
    provider === "ollama" ? new OllamaBackend(config) : new OpenAIBackend(config);
  const deps = makeDeps(backend);

  // Same parallel L2 pattern as runProfileUpdate — surfaces write disjoint
  // files, so no lock is needed. Budget = target CHUNK COUNT per surface
  // (chunker: target = ceil(chars / budget)); halving it doubles the chars
  // per LLM call, halving the call count for this one-off rebuild.
  const l2Opts = { budget: Math.max(2, Math.round(MEMORY_SETTINGS.update.l2Budget / 2)) };
  const l2Start = Date.now();
  const l2Results = await Promise.all(SURFACES.map((surface) => updateL2(deps, surface, l2Opts)));
  console.log(`[timing] all_L2: ${Date.now() - l2Start}ms`);
  SURFACES.forEach((surface, i) => {
    const r = l2Results[i];
    console.log(
      `L2 ${surface}: chunks=${r.chunksProcessed} facts=${r.factsAdded} refsDropped=${r.refsDropped}`
    );
  });

  const l3Start = Date.now();
  const l3 = await updateL3(deps, "profile", {
    budget: Math.max(1, Math.round(MEMORY_SETTINGS.update.l3Budget / 2)),
  });
  console.log(`[timing] L3: ${Date.now() - l3Start}ms`);
  console.log(
    `L3 profile: chunks=${l3.chunksProcessed} facts=${l3.factsAdded} refsDropped=${l3.refsDropped}`
  );

  const translateStart = Date.now();
  const tr = await translateL3Doc(deps, "profile");
  console.log(`[timing] translate: ${Date.now() - translateStart}ms`);
  console.log(`translate: ok=${tr.ok} translated=${tr.translated} untouched=${tr.untouched}`);

  const overviewStart = Date.now();
  try {
    await synthesizeOverview(
      { loadL3Doc: loadL3DocFs, callLlm: deps.callLlm, saveOverviewText: (text) => writeTextAtomic(overviewFileFs("profile"), text) },
      "profile"
    );
  } catch (err) {
    console.error(`overview failed: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`[timing] overview: ${Date.now() - overviewStart}ms`);

  const doc = await loadL3DocFs("profile");
  if (!doc) {
    console.error("l3/profile.md missing after rebuild");
    process.exit(1);
  }
  const overviewText = await readText(overviewFileFs("profile"));
  if (overviewText) {
    console.log("\n===== profile-overview.md =====\n");
    console.log(overviewText);
  }
  console.log("\n===== renderDisplay(l3/profile.md) =====\n");
  console.log(renderDisplay(doc));
  console.log(`[timing] total: ${Date.now() - totalStart}ms`);
}

main().catch((err) => {
  console.error("rebuild failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});