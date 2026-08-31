# Remaining Work Checklist

> Last updated: 2026-08-29. Tracks what's left after P1 (update), P2 (memoryGraph), and P3 (dedup/merge).
> **按优先级排序。后续按「Tier 1 → Tier 3 → 小项」的顺序推进。**

## Implemented (context, not a todo)

- **P1 — L1→L2→L3 pipeline**: `src/memory/update.ts` (`updateL2`/`updateL3`), chunker, document parse/serialize, ops, references, guards, meta, paths, store, snapshot adapter/reader, prompts, settings, profile injection.
- **P2 — memoryGraph panel**: `src/memory/graph.ts`, `src/commands/memoryGraph.ts`, `src/chat/profileViewProvider.ts`.
- **P3 — dedup/merge passes**: `src/memory/lineDoc.ts`, `dedup.ts`, `merge.ts`, plus refs-preserved observability on the replace fallback.
- **Wiring**: `pylearner.updateProfile` command, `ProfileRefresher` lazy auto-refresh, profile injection into chat (`messageHandler.ts`); atomic writes via `fs.rename` in `store.ts`; content-only profile injection via `renderBody`.

---

## 推荐执行顺序

> **先评测 → 再 audit → 再 L3 REWRITE**。评测最便宜且能纠偏方向，audit 是正确性兜底，REWRITE 是连贯性/长度优化。

## Tier 1：真正该做

### 1. 非正式评测（§7.2）——最便宜、决定后续方向

管道至今没有回答「L2/L3 到底让 AI 回答变好了多少」。先做一次 A/B 评测，用结果决定 audit/REWRITE 的先后。

- [ ] 准备一份画像（真实 `profile.md` 或合成画像）
- [ ] 用 [scripts/eval-profile.ts](../../scripts/eval-profile.ts) 跑 5-10 个探针问题（带 vs 不带画像）
- [ ] 按 5 维度逐题打分：个性化 / 跳过已掌握 / 针对薄弱点 / 准确性 / 是否被带偏
- [ ] 判定：绿灯 → 继续 audit；红灯 A（没用）→ 查注入是否生效 + 画像质量；红灯 B（有害）→ 防御有洞，最高优先

脚本用法：

```bash
npx esbuild scripts/eval-profile.ts --bundle --platform=node --format=cjs --outfile=out/eval-profile.cjs
node out/eval-profile.cjs --provider openai --api-key sk-xxx --model gpt-4o-mini --profile <path>
```

### 2. audit 模式（P4）——正确性兜底，甚至比 L3 REWRITE 更重要

唯一「回头看」的环节：把存量条目对照原始证据，改掉过度概括/矛盾/失去支撑的 claim。L2 对照 L1 原始轨迹，L3 对照 L2 条目。**没有 audit，整条管线是「只增不核」，错误会累积**；也只有 audit 兜底，「单步 + 不做两步思维链」才成立。

- [ ] Port `audit.py` + `audit_l2.yaml` + `audit_l3.yaml`
- [ ] Audit prompt builders（annotated-chunk 渲染——亮出每条 entry 的完整来源，区别于 dedup 的 sanitized view）
- [ ] `src/memory/audit.ts` runner + `settings.ts` `audit.autoAfter*`
- [ ] Wire into `update.ts`（audit → merge 顺序，镜像 dedup）

Note: `InsertAfterOp` in `lineDoc.ts` 已为 audit 预留（dedup 禁用 insert）。

### 3. L3 REWRITE——连贯性/长度

把 L3 从 append 改为 REWRITE（GBrain Compiled Truth 语义）：L2 = store（append + 原子 Op），L3 = view（重写 + 粗粒度 surface refs）。修「矛盾条目并存 / 不是当前综合 / 长度失控」。

三条护栏（采纳时必须满足）：

1. 保留 surface 级 refs（L3→surface 粗粒度，REWRITE 不丢关键 provenance）
2. 长度安全检查：新画像 < 原长 70% 则拒绝
3. 幂等：相同输入 → 相同输出

## Tier 2：真实缺口，但不急

- [ ] **9.4 Profile portability** — export/import `.zip`（l2/ + l3/ + meta/）。换电脑画像丢，真实用户痛点，但属产品级功能。
- [ ] **9.6 Extra L3 slots** — `updateL3` 已支持 recent/scope，`updateProfile.ts` 只跑了 `profile`。等画像大到需要分槽再说。

## Tier 3：明确 defer，等触发（现在做是过度设计）

- [ ] **两步思维链**（analyze→generate）——等评测证明单步不够
- [ ] **Facts `kind` 字段**——等检索/评测需要；section 已给粗粒度信号
- [ ] **L3 frontmatter + 锁定字段**——随 L3 REWRITE 一起，单独做没必要
- [ ] **9.1 Precise/hybrid retrieval**（vector + BM25 + RRF + graph）——等画像大到塞不下全文
- [ ] **9.3 Facts↔facts 横向关联**（`[[wikilink]]`）——等 AI 回答缺联想能力
- [ ] **`test` surface**——等有测试运行/覆盖率场景

## 小项（顺手能补，不挡路）

- [ ] **§9.5 灾难恢复 spec 是空的**——连方案都没写。store 已原子写、parse 对损坏文件容错，实际风险大半已覆盖，缺的是「定义清楚要防什么」。
- [ ] **onEvent 没接消费者**——update/dedup/merge 都在发事件（含 `refs_preserved`），但 `updateProfile.ts` 的 `makeDeps` 没传 `onEvent`，可观测性目前没落地。要么接个进度/日志消费者，要么就不发。
- [ ] **vitest 抖动**——偶发「17 files failed / no tests」，重跑即绿（环境问题非代码问题）。频繁复发再查 vitest 4.1.11 的 transform 缓存。
