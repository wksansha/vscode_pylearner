# GBrain 工作原理深度解析（特别是 AI 记忆方面）

> 基于 GBrain 开源项目源码精读：https://github.com/garrytan/gbrain
> 本地代码路径：D:\ruan\gbrain
> 生成日期：2026-08-28

---

## 目录

1. [GBrain 是什么](#一gbrain-是什么)
2. [三层记忆路由（Brain vs Memory vs Session）](#二三层记忆路由brain-vs-memory-vs-session)
3. [Compiled Truth + Timeline 模式](#三compiled-truth--timeline-模式最核心的-ai-记忆机制)
4. [摄入管道（Ingest Pipeline）](#四摄入管道ingest-pipeline)
5. [分块策略](#五分块策略chunking)
6. [搜索管道（四策略混合检索）](#六搜索管道四策略混合检索)
7. [零 LLM 实体链接提取](#七零-llm-实体链接提取)
8. [Facts 围栏——结构化事实存储](#八facts-围栏结构化事实存储)
9. [Brain × Source 二维组织](#九brain--source-二维组织)
10. [Guardrails 安全边界](#十guardrails-安全边界)
11. [与 DeepTutor 的对比](#十一与-deeptutor-的对比)
12. [自测问题](#十二自测问题)

---

## 一、GBrain 是什么

GBrain 是一个**本地优先的个人知识大脑**——用 Markdown 文件作为"唯一真相源"（system of record），用 Postgres/PGLite 数据库作为**派生缓存**（derived cache）来加速搜索。

### 核心契约

**Markdown 是真相，DB 是索引。**

如果数据库挂了，删库重建只需三条命令：

```bash
gbrain reinit-pglite   # 清空嵌入数据库
gbrain sync            # 从 Markdown 仓库重新导入
gbrain extract all     # 重建所有派生表（facts, takes, links, timeline）
```

### 三类表

| 类别 | 说明 | 重建方式 |
|------|------|---------|
| **FS-canonical** | Markdown 是真相源，DB 行是派生索引 | wipe + `gbrain extract` |
| **Derived from FS** | 自动从 Markdown 派生，非用户直接编写 | chunker + embedder 重建 |
| **DB-only by design** | 运行时/基础设施状态，故意不在仓库中 | 不需要重建 |

**FS-canonical 表包括：** takes, facts, links, timeline_entries, tags, emotional_weight, synthesis_evidence

**Derived 表包括：** pages, content_chunks, page_versions

**DB-only 表包括：** raw_data, subagent_messages, oauth_tokens, minion_jobs, dream_verdicts 等

### 灾难恢复不变量

E2E 测试 `test/e2e/system-of-record-invariant.test.ts` 在每次 CI 运行时验证：

```bash
gbrain stats > /tmp/before.txt
# 删除派生表
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
gbrain sync
gbrain extract all
gbrain stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt  # 必须无差异
```

---

## 二、三层记忆路由（Brain vs Memory vs Session）

这是 GBrain 对 AI 记忆最核心的设计——信息必须进入正确的层：

### 路由规则

```
on new_information(info):
    if info.is_about_the_world:
        # GBRAIN: 人物、公司、交易、会议、概念、想法
        # 这是世界知识——关于外部实体的事实
        gbrain put <slug> --content "..."
        # 例：
        #   "Alice 是 Acme 的 CEO"         → gbrain (person 页面)
        #   "Acme 完成 D 轮融资 $12B"      → gbrain (company 页面)
        #   "周二会议讨论了 Q2"             → gbrain (meeting 页面)

    elif info.is_about_operations:
        # AGENT MEMORY: 偏好、决策、工具配置、会话连续性
        # 这是 Agent 的操作方式——不是关于世界的事实
        memory_write(info)
        # 例：
        #   "用户偏好简洁格式"              → agent memory
        #   "先部署 staging 再 prod"        → agent memory
        #   "Crustdata API key 放 .env"    → agent memory

    elif info.is_current_conversation:
        # SESSION CONTEXT: 刚说的话、当前任务、即时状态
        # 自动存在于对话窗口中，无需存储操作
        pass
```

### 查询路由

```
on user_asks(question):
    if question.about_person or question.about_company:
        gbrain search "{entity}"    # → 世界知识
    elif question.about_preference or question.about_how_to_operate:
        memory_search("{topic}")    # → 操作状态
    elif question.about_current_context:
        pass  # 已在会话中
```

### 三层对比表

| 层级 | 存放什么 | 生命周期 | 查询方式 | 存储介质 |
|------|---------|---------|---------|---------|
| **GBrain (Brain)** | 世界知识：人物、公司、会议、概念 | 永久（Git 仓库） | `gbrain search` / `gbrain get` | Markdown + DB |
| **Agent Memory** | 操作状态：偏好、决策、配置 | Agent 重置可能丢失 | `memory_search` | MEMORY.md 等文件 |
| **Session Context** | 当前对话：刚说的话、当前任务 | 对话结束即消失 | 已在上下文窗口 | LLM 上下文 |

### 常见错误及其危害

| 错误 | 危害 | 正确做法 |
|------|------|---------|
| 把人物档案存进 Agent Memory | Agent 重置就丢了所有人物知识 | 存进 GBrain |
| 把用户偏好存进 GBrain | 污染知识页面，搜索结果混入偏好 | 存进 Agent Memory |
| 把操作决策存进 Session | 下次对话又要重新告知 | 存进 Agent Memory |
| 把外部想法综合存进 Agent Memory | 丢掉用户原创思考 | 存进 GBrain (originals/) |

**判断法则：这是关于世界的事实，还是关于如何操作的？** 世界→GBrain，操作→Agent Memory，当前→Session。

---

## 三、Compiled Truth + Timeline 模式（最核心的 AI 记忆机制）

每个 GBrain 页面有两个区域，**写入语义完全不同**：

```
┌─────────────────────────────────┐
│  Compiled Truth（编译真相）       │  → REWRITE（重写）
│  当前综合，随证据变化而重写       │  不是追加！是整个重写！
├─────────────────────────────────┤
│  <!-- timeline -->               │
│  Timeline（时间线）               │  → APPEND（追加）
│  证据轨迹，永不编辑，只追加       │  不可变！错了也是追加修正条目
└─────────────────────────────────┘
```

### 完整示例——Sarah Chen 的人物页面

```markdown
---
type: person
title: Sarah Chen
tags: [engineering, acme-corp]
---

## Executive Summary
One paragraph. How you know them, why they matter.

## State
VP Engineering at Acme Corp. Managing 45-person team. Reports to CEO.

## What They Believe
Strong opinions on test coverage. "Ship it when the tests pass, not before."

## What They're Building
Leading the API migration from REST to GraphQL. Target: Q3 completion.

## Assessment
Sharp technical leader. Under-appreciated internally. Watch for signs of burnout.

## Trajectory
Ascending. Likely CTO track if the migration succeeds.

## Relationship
Met through alice-example. Had coffee 3x. Last: discussed API architecture thesis.

## Contact
sarah@acmecorp.com | @sarahchen | linkedin.com/in/sarahchen

<!-- timeline -->

## Timeline

- **2026-04-07** | Met at team sync. Discussed API migration timeline.
  Seemed energized about GraphQL pivot.
  [Source: Meeting notes, 2026-04-07 2:00 PM PT]
- **2026-04-03** | Mentioned in email re Q2 planning. Taking lead on ops.
  [Source: Gmail, sarah@acmecorp.com, 2026-04-03 10:30 AM PT]
- **2026-03-15** | First meeting. Intro from alice-example. Strong technical background.
  [Source: User, direct conversation, 2026-03-15 3:00 PM PT]
```

### 为什么这是精髓

| 没有 Compiled Truth | 有了 Compiled Truth |
|---------------------|---------------------|
| 200 条时间线条目 | 30 秒看完当前状态 |
| 答案埋在第 147 条 | 综合段直接给出结论 |
| 每次查询要遍历全量 | 搜索权重：综合 > 时间线 |
| 信息矛盾无法自动解决 | 旧评估被重写，永远最新 |

### 更新流程（伪代码）

```python
def update_brain_page(slug, new_info, source):
    page = gbrain_get(slug)

    # 第一步：Timeline 永远 APPEND（永不编辑旧条目）
    gbrain_timeline_add(slug, {
        date: today,
        summary: new_info.summary,
        detail: new_info.detail,
        source: format_source(source)  # [Source: who, channel, date time tz]
    })

    # 第二步：Compiled Truth REWRITE（不是追加！）
    # 读旧的综合 → 整合新信息 → 重写整个综合
    updated_truth = rewrite_compiled_truth(
        page.compiled_truth,
        new_info
    )
    gbrain_put(slug, {
        compiled_truth: updated_truth,
        # timeline 不传——它由 timeline_add 管理
    })
```

### 关键规则

| 区域 | 动作 | 解释 |
|------|------|------|
| Compiled Truth | **REWRITE** | 当前综合。证据变化时重写。 |
| Timeline | **APPEND** | 证据轨迹。永不编辑，只追加。 |

**每条 Compiled Truth 声明必须能追溯到 Timeline 条目。** 如果 Assessment 说"under-appreciated internally"，应该有 Timeline 条目支持这个说法。

### Timeline 哨兵识别

GBrain 在 Compiled Truth 和 Timeline 之间用哨兵（sentinel）分隔，按优先级识别：

1. `<!-- timeline -->` — 首选；明确无歧义，GBrain 自己输出时用这个
2. `--- timeline ---` — 装饰分隔符
3. `---` — **仅当**下一非空行是 `## Timeline` 或 `## History` 时（向后兼容）

一个普通的 `---` 在其他位置是 Markdown 水平线，**不是**分隔符。

### 时间线条目的不可变性

Timeline 条目是**不可变**的。如果信息有误，追加一条**修正条目**：

```markdown
- **2026-04-10** | Correction: Sarah is VP Eng, not CTO. Previous entry was wrong.
  [Source: Verified with HR, 2026-04-10]
```

永远不编辑旧的条目。

---

## 四、摄入管道（Ingest Pipeline）

`src/core/import-file.ts` 是 GBrain 的核心摄入入口，流水线如下：

```
原始 Markdown 文件
  │
  ├─ 1. parseMarkdown()          → 解析 frontmatter + body
  │     └─ validateSlug()        → slug 归一化（小写）
  │
  ├─ 2. content-hash             → 幂等性检查
  │     └─ hash 相同 → 跳过（除非 forceRechunk）
  │
  ├─ 3. guardrails()             → 观察型安全检测
  │     └─ 不阻断！只记录。Fail-open 设计
  │
  ├─ 4. content-sanity()         → 质量门控
  │     └─ 隔离垃圾/超大内容（quarantine + content_flag）
  │
  ├─ 5. chunkText()              → 文本分块
  │     ├─ recursive chunker     → Markdown 文本（5 级分隔符递归）
  │     └─ code chunker          → 代码文件（AST 感知分块）
  │
  ├─ 6. extractFencedChunks()    → 代码围栏块提取
  │     └─ 识别 ```ts / ```py 等标签
  │     └─ 用 code chunker 独立分块
  │     └─ chunk_source='fenced_code'
  │
  ├─ 7. extractEntityRefs()      → 零 LLM 实体链接提取
  │     └─ 三个正则表达式（详见第七节）
  │     └─ addLinksBatch() 批量写入
  │
  ├─ 8. embedBatch()             → 向量嵌入
  │     └─ 每 100 个一批
  │     └─ 支持 OpenAI / Voyage / ZeroEntropy / DashScope / Zhipu
  │     └─ 嵌入签名 stamp: "provider:model:dims"
  │
  ├─ 9. DB transaction           → 原子写入
  │     ├─ putPage()             → pages 表 upsert
  │     ├─ tags                  → tags 表同步
  │     ├─ upsertChunks()        → content_chunks 表
  │     └─ addLinksBatch()       → links 表
  │
  └─ 10. extract cycle           → 派生表重建
        ├─ extract facts         → facts 表（从围栏解析）
        ├─ extract takes         → takes 表
        ├─ extract links         → links 表（完整图提取）
        └─ extract timeline      → timeline_entries 表
```

### importFromContent 函数签名

```typescript
async function importFromContent(
  engine: BrainEngine,
  slug: string,
  content: string,
  opts: {
    noEmbed?: boolean;           // 跳过嵌入
    sourceId?: string;           // 多 source 路由
    filename?: string;           // 文件名（日期推断用）
    sourcePath?: string;         // 仓库相对路径
    forceRechunk?: boolean;      // 强制重新分块+嵌入
    activePack?: SchemaPack;     // v0.39 schema pack
    remote?: boolean;            // 不受信任的调用方 → 剥离 gate-owned markers
    allowEmptyOverwrite?: boolean; // 允许清空页面
  }
): Promise<ImportResult>
```

### ImportResult 返回值

```typescript
interface ImportResult {
  slug: string;
  status: 'imported' | 'skipped' | 'error';
  chunks: number;
  error?: string;
  parsedPage?: ParsedPage;      // 解析后的页面内容
  quarantined?: boolean;        // 被隔离（隐藏于搜索）
  flagged?: boolean;            // 被标记（仍可搜索，Agent 被警告）
  flag_reason?: 'markup_heavy' | 'oversized';
  skip_reason?: 'malformed_path';
  type_warning?: { kind: 'alias_of' | 'undeclared'; type: string };
}
```

### 代码围栏语言映射

```typescript
const FENCE_TAG_TO_PSEUDO_PATH = {
  ts: 'fence.ts', typescript: 'fence.ts',
  tsx: 'fence.tsx',
  js: 'fence.js', javascript: 'fence.js',
  py: 'fence.py', python: 'fence.py',
  go: 'fence.go', golang: 'fence.go',
  rs: 'fence.rs', rust: 'fence.rs',
  java: 'fence.java',
  // ... 共 20+ 语言
};
```

每个识别出的代码围栏会被**独立分块**（使用 code chunker），生成 `chunk_source='fenced_code'` 的额外块。这样查询 "how do we import from engine" 会返回实际的 import 示例代码块，而不是关于 import 的散文段落。

---

## 五、分块策略（Chunking）

### Recursive Chunker（Markdown 文本）

5 级分隔符层次：

```
L0: 段落 (\n\n)
L1: 行 (\n)
L2: 句子 (. ! ? + CJK 。！？)
L3: 子句 (; : , + CJK ；：，、)
L4: 词（空格 + CJK 字符切片 fallback）
```

**配置：**
- 目标：300 词/块
- 重叠：50 词（句子感知）
- 硬上限：6000 字符/块
- Token 上限：DEFAULT_MAX_CHUNK_TOKENS（模型相关）

**无损不变量：** 非重叠部分重新拼装 = 原文。

**CJK 支持：** 专门的 CJK 分隔符集（。！？；：，、）+ 字符级切片 fallback。

**版本号：** `MARKDOWN_CHUNKER_VERSION = 3`（v0.40.3.0 加入 contextual retrieval wrapper）

### Code Chunker（代码文件）

- 基于 AST 感知分块（Tree-sitter）
- 按符号边界切分（函数、类、方法）
- 保留 `language`, `symbol_name`, `symbol_type`, `start_line`, `end_line` 元数据
- 独立版本号 `CHUNKER_VERSION`

### Chunker 版本机制

每个页面记录 `chunker_version` 列。当 chunker 升级时：
1. 新导入的页面用新版本
2. 旧页面通过 `gbrain reindex --markdown` 重新分块
3. `forceRechunk=true` 强制跳过 content-hash 幂等检查

---

## 六、搜索管道（四策略混合检索）

### 四策略概述

| 策略 | 擅长 | 独自失败的原因 |
|------|------|--------------|
| **Vector (HNSW)** | 语义相似 | 看不到关系链，"Alice 投资的公司"返回关于投资的散文而非公司页 |
| **BM25 Keyword** | 精确匹配 | 换个说法就找不到，"搜索排名"匹配不到"检索质量" |
| **RRF 融合** | 无需全局加权 | 只合并排名，不解决跨策略关系 |
| **Knowledge Graph** | 关系链遍历 | 新页面边稀疏，直到反向链接积累 |

### RRF（Reciprocal Rank Fusion）公式

```
RRF_score = Σ (1 / (K + rank_in_list))
```

其中 K = 60（GBrain 默认值）。

**为什么用 RRF 而不是加权平均？** RRF 不需要调权重——每个策略的投票权只取决于排名位置，不取决于原始分数。这样向量搜索和关键词搜索的分数范围差异不会影响融合结果。

### 基准测试（BrainBench, 240 页语料库）

| 策略 | P@5 | R@5 | 说明 |
|------|-----|-----|------|
| 纯 BM25 | ~18 | ~75 | 词汇基线 |
| 纯向量 RAG | ~18 | ~80 | 标准 RAG 实现 |
| 混合+RRF（无图） | ~18 | ~85 | 混合单独 |
| **GBrain 完整四策略** | **49.1** | **97.9** | 图 + 提取质量提升 |

**图遍历贡献了 +31 P@5 分！** 不是边缘特性，是承重墙。

### 完整搜索流水线

```
用户查询
  │
  ├─ 1. query-intent 分类          → 判断查询意图（人名/公司名/概念/时间）
  │
  ├─ 2. 并行三路召回
  │     ├─ Vector 路径: embedQuery → HNSW 向量搜索
  │     ├─ BM25 路径:              → SQL 全文搜索
  │     └─ Graph 路径:             → 关系图 BFS 遍历
  │
  ├─ 3. RRF 融合                   → 合并三路排名
  │
  ├─ 4. 归一化                      → 统一到 [0,1] 区间
  │
  ├─ 5. Compiled Truth 加权         → 低 detail 时 2x 提升
  │
  ├─ 6. 源优先级调整                → originals/ > daily/ > chat/
  │     └─ 硬排除: test/, attachments/, .raw/
  │
  ├─ 7. Cross-encoder 重排序        → 60% top-1 重排
  │     └─ balanced/tokenmax 模式启用
  │     └─ Voyage rerank-2.5 或 ZeroEntropy zerank-2
  │
  ├─ 8. 去重                        → 相同 slug 只保留最佳块
  │
  ├─ 9. Token 预算截断              → enforceTokenBudget
  │
  ├─ 10. 自适应返回                  → applyAdaptiveReturn
  │
  ├─ 11. 证据标记                    → stampEvidence + markKeywordHits
  │
  ├─ 12. 内容标记                    → stampContentFlags + stampUnverifiedExtractions
  │
  └─ 13. 返回 SearchResult[]
```

### Compiled Truth 加权

```typescript
const COMPILED_TRUTH_BOOST = 2.0;

// 只在 detail='low' 时启用
// low = compiled truth only
// medium = default, all with dedup
// high = all chunks
function shouldBoostCompiledTruth(detail: string | null | undefined): boolean {
  return detail === 'low';
}
```

**为什么只在 low 时加权？** 因为 2x 在 RRF 归一化后不是微调，是质的改变——任何在排名前 60 的 compiled_truth 块会超过未加权的排名第 1 块。在 medium/high 时这会导致代码块永远排不到前面。

### 源优先级（Source Boost）

| 路径前缀 | 因子 | 说明 |
|---------|------|------|
| originals/, concepts/, writing/ | > 1.0 | 策展内容，高价值 |
| archive/ | 0.5 | 降级但不隐藏 |
| your-openclaw/chat/, daily/, media/x/ | < 1.0 | 批量内容，低信噪比 |
| test/, attachments/, .raw/ | 硬排除 | 检索时直接过滤 |

### 跨编码器重排序器（Cross-encoder Reranker）

- **作用：** 在 RRF 融合后再做一次 query-document 联合注意力
- **效果：** 60% 的 top-1 结果被重新排列
- **代价：** +150ms p50 延迟，~$0.025-0.05/M tokens
- **原因：** 向量+关键词+图信号都同意的文档可能语义相关但主题错误——cross-encoder 能捕捉这种情况

---

## 七、零 LLM 实体链接提取

`src/core/link-extraction.ts` 用**三个正则表达式**，零 LLM 调用，每次 `put_page` 自动提取实体关系：

### 1. 标准 Markdown 链接

```regex
[Alice Example](wiki/people/alice-example)
```

### 2. Obsidian 双链

```regex
[[wiki/people/alice-example|Alice Example]]
```

### 3. 类型化链接引用块

```markdown
> **Convention:** see [path](path).
```

### EntityRef 接口

```typescript
interface EntityRef {
  slug: string;          // 目标实体 slug
  label: string;        // 显示文本
  linkType?: string;    // 启发式推断的关系类型
  source: 'markdown' | 'wikilink' | 'blockquote';
}
```

### 启发式关系类型推断

从周围句子上下文推断，也是零 LLM：
- `attended` — 出席
- `works_at` — 在...工作
- `invested_in` — 投资
- `founded` — 创立
- `advises` — 顾问

### 性能

在 17K 页的 brain 上，完整图提取在**秒级**完成。写入用一条 SQL：

```sql
INSERT ... SELECT FROM jsonb_to_recordset(($1::jsonb)->'rows')
JOIN pages ON CONFLICT DO NOTHING RETURNING 1
```

---

## 八、Facts 围栏——结构化事实存储

每个实体页面可以有一个 `## Facts` 围栏，用 Markdown 表格存储结构化事实：

### 围栏格式

```markdown
## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded Acme in 2017             | fact       | 1.0  | world   | high   | 2017-01-01 |            | linkedin       |                                    |
| 2 | Prefers async over meetings      | preference | 0.85 | private | medium | 2026-04-29 |            | OH 2026-04-29  |                                    |
| 3 | ~~Will hit $10M ARR by Q4~~      | commitment | 0.55 | world   | medium | 2026-06-01 | 2026-12-31 | bo call        | superseded by #4                   |
| 4 | ~~Used to live in Tokyo~~        | fact       | 0.9  | private | low    | 2018-01-01 | 2026-05-10 | inferred       | forgotten: user asked to remove    |
<!--- gbrain:facts:end -->
```

### 列说明

| 列 | 类型 | 说明 |
|----|------|------|
| `#` | number | 行号，稳定标识符（重编号时保持唯一） |
| `claim` | string | 事实陈述 |
| `kind` | enum | 事实类型：event / preference / commitment / belief / fact |
| `confidence` | float | 置信度 0..1 |
| `visibility` | enum | 可见性：world / private |
| `notability` | enum | 重要度：high / medium / low |
| `valid_from` | date | 事实生效日期 |
| `valid_until` | date | 事实失效日期（空 = 仍有效） |
| `source` | string | 来源（linkedin / OH / inferred / bo call 等） |
| `context` | string | 上下文（superseded by #N / forgotten: reason） |

### 删除线语义

| 格式 | context | 语义 |
|------|---------|------|
| `~~claim~~` | `superseded by #N` | 被第 N 行取代（active=false, supersededBy=N） |
| `~~claim~~` | `forgotten: <reason>` | 用户要求移除（active=false, forgotten=true） |
| `~~claim~~` | 其他 | 标记为 inactive |

**两种情况下行都保留在 Markdown 中**（审计历史）。DB 标记 `active=false`。

`valid_until` 和遗忘的映射：
- `forgotten` → `valid_until = today` → DB 的 `expired_at = valid_until + now()`

### 隐私三层剥离

| 层 | 位置 | 作用 |
|----|------|------|
| **Layer A（chunker）** | `src/core/chunkers/recursive.ts` | private 行不进入 `content_chunks`，不被嵌入，不出现在搜索 |
| **Layer B（get_page）** | API 边界 | 远程调用时（`ctx.remote === true`）剥离 private 行 |
| **Layer C（git）** | 仓库 | 用户自己决定是否 commit 敏感页面；`db_only` 路径自动 gitignore |

### 永久删除

要永久删除一条事实，**直接编辑 Markdown 围栏**删除该行。下次 `extract_facts` cycle 会清除 DB 行。这和 `forget` 不同——forget 保留行（审计），删除不保留。

---

## 九、Brain × Source 二维组织

GBrain 有两个正交轴：

### Brain（数据库轴）

一个 **brain** = 一个数据库（PGLite 文件 / 自建 Postgres / Supabase）。

每个 brain 有：
- 独立的 pages、chunks、embeddings 表
- 独立的 OAuth 接口
- 独立的生命周期、备份、访问控制

路由：`--brain <id>` / `GBRAIN_BRAIN_ID` / `.gbrain-mount` dotfile / 最长路径匹配

### Source（仓库轴）

一个 **source** = brain 内的一个命名内容仓库。每个 `pages` 行有 `source_id`。

Slug 在 source 内唯一，不是全局唯一。同一个 brain 中，slug `topics/ai` 可以在 `source=wiki` 和 `source=gstack` 中分别存在——它们是不同的页面。

路由：`--source <id>` / `GBRAIN_SOURCE` / `.gbrain-source` dotfile / `local_path` 匹配

### 拓扑示例

**最简：** 一个 brain，一个 source
```
┌─────────────────────────────────────┐
│  host brain (~/.gbrain)             │
│  └── source: default               │
│      └── all pages                  │
└─────────────────────────────────────┘
```

**个人多仓库：** 一个 brain，多个 source
```
┌─────────────────────────────────────┐
│  host brain                         │
│  ├── source: wiki (federated=true)  │
│  ├── source: gstack                │
│  └── source: daily                 │
└─────────────────────────────────────┘
```

**团队：** 多个 brain
```
┌─ host brain ──────┐  ┌─ team brain ──────┐
│  source: personal  │  │  source: shared   │
│  source: daily     │  │  source: wiki     │
└────────────────────┘  └────────────────────┘
```

**规则：** 数据所有者变化 → brain 边界；数据所有者不变但主题/仓库变化 → source 边界。

---

## 十、Guardrails 安全边界

GBrain 在内容流经的关键边界提供**观察型**安全检测缝隙（seam）：

### 五个检测点

| Hook 点 | 触发时机 | 传入内容 |
|---------|---------|---------|
| `file_storage.markdown` | Markdown 分块/嵌入/持久化之前 | Markdown body |
| `file_storage.code` | 代码分块/嵌入/持久化之前 | Code body |
| `ai_gateway.chat` | LLM 推理之前的最新用户消息 | Last user message |
| `ai_gateway.expand` | 搜索扩展查询之前 | Expansion query |
| `ai_gateway.tool_input` | 工具执行之前 | Tool input |

### 硬性不变量

1. **Observe-only（只观察）**：`runGuardrails` 返回 `void`，调用方不可基于任何结果分支。Guardrail 不能阻断、重写、丢弃、重试 GBrain 行为。
2. **Fail-open（失败开放）**：配置缺失、provider 异常、超时、网络错误——全部吞掉。损坏的 guardrail 永远不中断摄入/查询/工具调用。
3. **Inline await（内联等待）**：hooks 在精确的 pre-persist / pre-inference 时刻 await provider。
4. **No verdict persistence（不持久化判定）**：GBrain 不把 guardrail 结果写入 DB。Provider 自己管审计。
5. **Content boundaries（内容边界）**：只传入用户/摄入侧载荷，永不传入 system prompt、完整聊天历史、工具输出、LLM 输出、嵌入。

**默认零注册**——OSS 发行版是惰性的。Operator 或 vendor plugin 注册 `GuardrailProvider` 后才激活。

---

## 十一、与 DeepTutor 的对比

### 架构对比

| 维度 | DeepTutor | GBrain |
|------|-----------|--------|
| **记忆分层** | L1(JSONL 事件) → L2(Markdown per-surface) → L3(Markdown cross-surface) | Timeline(追加) + Compiled Truth(重写) |
| **真相源** | Python 代码 + JSONL + Markdown 文件 | Git 仓库中的 Markdown 文件 |
| **派生存储** | meta.json (seen-ID 状态) | Postgres/PGLite DB (可完全重建) |
| **搜索** | 向量搜索为主 | 四策略混合：向量 + BM25 + RRF + 图遍历 |
| **实体链接** | LLM 提取 + footnote 引用 | 零 LLM 正则提取 + Markdown 链接 |
| **事实结构** | L2/L3 中的自然语言 + footnote | 围栏表格：claim/kind/confidence/visibility |
| **隐私** | 无显式隐私层 | 三层剥离：chunker→get_page→git |
| **可审计性** | L3→surface name→L2→footnote→L1 trace ID | Compiled Truth→Timeline 条目→source 标注 |
| **更新语义** | AddOp/EditOp/DeleteOp 原子操作 | Timeline APPEND + Compiled Truth REWRITE |
| **语言** | Python | TypeScript |
| **部署** | 嵌入式库 | CLI + MCP Server + DB |

### 分层映射

```
DeepTutor                    GBrain
─────────                    ──────
L1 (JSONL 原始事件)    ≈    Timeline (追加不可变)
L2 (Markdown per-surface)   ← 无精确对应，GBrain 在单页面内完成
L3 (Markdown cross-surface) ≈    Compiled Truth (重写综合)
```

GBrain 没有 L2 的显式中间层。它的"per-surface 综合"就是 Compiled Truth 本身——每个实体页面就是一个独立的综合单元。DeepTutor 的 L2 是"每个学习面的独立事实提取"，为 L3 跨面综合提供中间素材；GBrain 的实体页面天然按主题组织，不需要这层中间。

### 核心设计共鸣

1. **都把原始事件流视为不可变**
   - DeepTutor L1: JSONL trace，append-only
   - GBrain Timeline: Markdown 时间线，append-only

2. **都对综合结果做重写而非追加**
   - DeepTutor L3: 跨面综合，EditOp 重写
   - GBrain Compiled Truth: rewrite_compiled_truth，整体重写

3. **都维护可审计的引用链**
   - DeepTutor: L3→surface name→L2→footnote→L1 trace ID
   - GBrain: Compiled Truth→Timeline 条目→[Source: who, channel, date]

4. **都用幂等哈希做增量更新**
   - DeepTutor: content_hash / seen-ID set
   - GBrain: pages.content_hash，相同则 skip

5. **都有防御性验证层**
   - DeepTutor: guards.py (banned phrases) + validate_fact_refs
   - GBrain: guardrails.ts (observe-only) + content-sanity + quarantine

### GBrain 对我们项目的参考价值

| 特性 | 参考价值 | 理由 |
|------|---------|------|
| ✅ 四策略混合检索 | **高** | 当前 DeepTutor 主要用向量搜索，BM25+RRF 能显著提升精确匹配 |
| ✅ 零 LLM 实体链接 | **中** | 减少对 LLM 的依赖，正则提取够用的场景不需要调用 LLM |
| ✅ Facts 围栏结构化 | **高** | claim/kind/confidence 比 L2 自然语言更精确，适合做学习画像 |
| ✅ 隐私三层剥离 | **中** | DeepTutor 目前无显式隐私，未来需要 |
| ✅ 灾难恢复契约 | **高** | "Markdown 是真相，DB 是索引"的设计哲学值得借鉴 |
| ⚠️ Brain×Source 组织 | **低** | DeepTutor 是单用户教学系统，不需要多 brain/source |
| ⚠️ Graph 遍历 | **低** | 学习者画像的关系图不如人脉网络密集 |

### GBrain 不适合直接照搬的地方

1. **GBrain 是个人知识管理，不是教学系统**：没有"学习面"、"掌握度"、"练习间隔"等概念
2. **GBrain 的 LLM 调用很少**：实体链接零 LLM，综合靠外部 agent；DeepTutor 的 L2/L3 生成高度依赖 LLM
3. **GBrain 是 CLI 工具**：DeepTutor 是嵌入式库，需要更轻的部署
4. **GBrain 用 Postgres**：DeepTutor 用 JSONL + Markdown 文件，更简单

---

## 十二、自测问题

### Q1: GBrain 的核心契约是什么？如果数据库损坏怎么办？

**答：** Markdown 是唯一真相源，DB 是派生缓存。数据库损坏时：
1. `gbrain reinit-pglite` — 清空嵌入数据库
2. `gbrain sync` — 从 Markdown 仓库重新导入
3. `gbrain extract all` — 重建所有派生表

不需要备份 DB，因为所有用户知识都在 Markdown 文件中。

### Q2: 三层记忆路由——"Alice 喜欢邮件而非 Slack"应该存哪里？

**答：** 存进 **GBrain**（Alice 的人物页面）。虽然看起来像"偏好"，但它是关于 Alice 的事实——是世界知识，不是 Agent 的操作方式。Agent Memory 存的是 Agent 自己怎么运行的偏好。

### Q3: Compiled Truth 和 Timeline 的更新语义有什么区别？为什么不能对 Compiled Truth 做追加？

**答：**
- **Timeline: APPEND** — 证据轨迹，永不编辑，只追加。错了也是追加修正条目。
- **Compiled Truth: REWRITE** — 当前综合，整体重写。

如果对 Compiled Truth 做追加，会导致：
- 新旧矛盾的信息并存（"VP Eng" 和 "CTO" 同时出现）
- 综合越来越长，失去"30 秒看完当前状态"的价值
- 旧评估不再准确但仍然存在，误导查询

### Q4: GBrain 搜索为什么需要四种策略？只用向量搜索会怎样？

**答：** 基准测试数据：纯向量 P@5=18，完整四策略 P@5=49.1。

- 纯向量：语义相似但主题可能错误，"Alice 投资的公司"返回关于投资的散文
- 纯关键词：换个说法就找不到
- 无图：看不到关系链，"Bob 本季度投了什么"无法回答

图遍历贡献了 +31 P@5 分，是承重墙不是装饰。

### Q5: 零 LLM 实体链接提取用了什么技术？为什么不用 LLM？

**答：** 三个正则表达式匹配：Markdown 链接、Obsidian 双链、类型化引用块。加上启发式关系类型推断（从上下文词推断 attended/works_at 等）。

不用 LLM 的理由：
- **成本**：17K 页全图提取秒级完成，零 token 消耗
- **延迟**：正则匹配是 O(n)，LLM 调用是秒级
- **确定性**：相同输入→相同输出，不会幻觉出不存在的关系
- **增量性**：每次 put_page 自动提取，无需额外步骤

### Q6: Facts 围栏中删除线 `~~claim~~` 的两种语义分别是什么？

**答：**
1. `~~claim~~` + `context: superseded by #N` → 被第 N 行取代（新旧事实替代）
2. `~~claim~~` + `context: forgotten: <reason>` → 用户要求移除（遗忘操作）

两种情况行都保留在 Markdown 中（审计历史），DB 标记 `active=false`。

### Q7: privacy 的三层剥离是怎么工作的？

**答：**
- **Layer A（chunker）**：分块时调用 `stripFactsFence({keepVisibility: ['world']})`，private 行不进入 `content_chunks`，不被嵌入，不出现在搜索结果
- **Layer B（get_page）**：远程调用（`ctx.remote === true`）时，响应体中 private 行被剥离
- **Layer C（git）**：用户自己决定是否 commit 敏感页面；`gbrain.yml` 的 `db_only` 路径自动 gitignore

### Q8: GBrain 的 Compiled Truth + Timeline 和 DeepTutor 的 L1→L2→L3 有什么对应关系？GBrain 缺了哪一层？

**答：**
- GBrain Timeline ≈ DeepTutor L1（原始事件流，追加不可变）
- GBrain Compiled Truth ≈ DeepTutor L3（跨面综合，重写更新）
- GBrain **没有 L2 的显式对应**

DeepTutor 的 L2 是"每个学习面的独立事实提取"，为 L3 跨面综合提供中间素材。GBrain 不需要这层，因为每个实体页面天然按主题组织，Compiled Truth 本身就是 per-entity 综合。DeepTutor 需要显式的 L2，因为一个学习者有多个学习面（语法、词汇、听力...），需要先 per-surface 提取再 cross-surface 综合。

### Q9: Guardrails 的五大硬性不变量是什么？

**答：**
1. **Observe-only**：不能阻断、重写、丢弃、重试
2. **Fail-open**：损坏的 guardrail 不中断任何操作
3. **Inline await**：在精确时刻同步等待
4. **No verdict persistence**：GBrain 不存储判定结果
5. **Content boundaries**：只传入用户载荷，不传 system prompt/LLM 输出

### Q10: 对我们 vscode-pylearner 项目，GBrain 的哪些设计最值得借鉴？

**答：**
1. **四策略混合检索**：当前只用向量搜索，BM25+RRF 能提升精确匹配（比如代码标识符、变量名）
2. **Facts 围栏结构化事实**：claim/kind/confidence 比 L2 自然语言更精确，适合做学习者画像的结构化存储
3. **"Markdown 是真相"契约**：vscode-pylearner 的记忆文件也应遵循这个原则
4. **灾难恢复**：任何时刻都能从 Markdown 文件重建索引

---

*本文档基于 GBrain v0.42+ 源码精读生成。关键源文件：*
- `src/core/import-file.ts` — 摄入管道（2189 行）
- `src/core/engine.ts` — 引擎抽象（2550 行）
- `src/core/types.ts` — 核心类型（1955 行）
- `src/core/search/hybrid.ts` — 混合搜索
- `src/core/chunkers/recursive.ts` — 递归分块
- `src/core/link-extraction.ts` — 实体链接提取
- `src/core/facts-fence.ts` — 事实围栏
- `src/core/embedding.ts` — 嵌入服务
- `src/core/guardrails.ts` — 安全边界
- `docs/architecture/system-of-record.md` — 真相源契约
- `docs/guides/compiled-truth.md` — 编译真相模式
- `docs/guides/brain-vs-memory.md` — 三层记忆路由
- `docs/architecture/RETRIEVAL.md` — 检索管道
