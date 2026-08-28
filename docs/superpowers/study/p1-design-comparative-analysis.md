# vscode-pylearner P1 设计思路——三系统对比分析与推荐

> 综合 DeepTutor / GBrain / LLM Wiki 三份深度解析文档，为 vscode-pylearner P1 阶段提出最合适的设计思路
> 生成日期：2026-08-28

---

## 目录

1. [三系统定位与核心范式](#一三系统定位与核心范式)
2. [vscode-pylearner 的独特约束](#二vscode-pylearner-的独特约束)
3. [逐维度对比分析与取舍](#三逐维度对比分析与取舍)
4. [推荐架构](#四推荐架构)
5. [分阶段策略](#五分阶段策略)
6. [不建议采用的设计](#六不建议采用的设计)
7. [风险与缓解](#七风险与缓解)

---

## 一、三系统定位与核心范式

| 系统 | 定位 | 记忆主体 | 核心范式 |
|------|------|---------|---------|
| **DeepTutor** | 教学系统 | **学习者** | L1→L2→L3 编译管道——事件→面级事实→跨面画像 |
| **GBrain** | 个人知识大脑 | **实体**（人物/公司） | Timeline APPEND + Compiled Truth REWRITE——证据追加+综合重写 |
| **LLM Wiki** | 个人知识库 | **知识主题** | 两步思维链摄入——LLM 先分析再生成，增量编译 Wiki |

**vscode-pylearner 的定位**：VS Code 扩展中的**Python 学习助手**，记忆主体是**学习者**。这与 DeepTutor 完全一致，与 GBrain/LLM Wiki 有本质区别——我们存储的不是"关于世界的知识"，而是"关于某个学习者的知识"。

---

## 二、vscode-pylearner 的独特约束

这些约束决定了我们不能照搬任何一个系统，需要选择性融合：

### 2.1 运行环境约束

| 约束 | 影响 |
|------|------|
| **VS Code Extension Host 进程** | 不能运行 Postgres/PGLite；不能用独立 HTTP 服务器；内存受限 |
| **单用户本地优先** | 不需要 GBrain 的 Brain×Source 多租户；不需要 LLM Wiki 的多项目 |
| **globalStorageUri 存储** | 只能用文件系统（JSONL + Markdown + JSON sidecar） |
| **P0 已实现 L1 JSONL 写入** | L1 层已有，P1 从 L2 开始 |
| **TypeScript 实现** | DeepTutor 是 Python，需要移植纯函数 + 适配 I/O |

### 2.2 使用场景约束

| 约束 | 影响 |
|------|------|
| **学习者画像用于注入聊天上下文** | 需要快速读取 L3 内容，拼入 system prompt |
| **画像更新由用户手动触发** | 不是每次事件都更新，而是用户点"更新画像"按钮 |
| **画像质量直接影响教学效果** | 错误画像比没有画像更糟——需要强防御 |
| **5 个 Surface：edit, run, chat, debug, diag** | P0 代码已实现 5 个 surface；顶层设计还预留了 test |

### 2.3 P0 已有基础设施

```
已有：
  ✅ L1 JSONL 写入（edit/run/chat 三个 surface）
  ✅ LLM Router（vscode-lm / openai / ollama 三后端）
  ✅ Chat Webview（流式 Markdown 渲染）
  ✅ globalStorageUri 存储路径

需要新建：
  ❌ L2 Markdown 文档模型（parse/serialize）
  ❌ L3 Markdown 文档模型
  ❌ Consolidator（增量更新逻辑）
  ❌ Snapshot/Diff（实体快照和差分）
  ❌ 五层防御（参考池/验证/banned/Op验证/预算）
  ❌ diag 事件监听（linter/diagnostics 事件）
  ❌ 画像注入（L3→聊天 system prompt）
```

### 2.4 Surface 划分

> ⚠️ 基于实际代码更新：P0 已实现 5 个 surface，debug 是独立的。

| Surface | 事件来源 | 学习信号 | P0 状态 |
|---------|---------|---------|---------|
| **edit** | `onDidChangeTextDocument`（.py，防抖） | 编辑模式、代码风格、习惯 | ✅ 已有 |
| **run** | Task + Terminal（Python 执行） | 运行结果、错误输出、错误类型解析 | ✅ 已有 |
| **debug** | `debug.*`（断点/单步/变量/调试会话） | 调试策略、断点位置、变量检查模式 | ⚠️ 常量已定义，监听待完善 |
| **chat** | AI 聊天交互 | 提问模式、困惑点、学习偏好 | ✅ 已有 |
| **diag** | `onDidChangeDiagnostics`（linter/type） | **重复错误模式**、linter/type 违规、代码质量趋势 | ✅ 已有 |

**顶层设计还预留了 `test` surface**（测试运行/结果/覆盖率），当前代码未实现，可作为 P1+ 扩展。

**5 个 surface 的理由：**
- `diag` 独立：linter 信号和编辑信号是不同维度——一个人可以写很多代码但 linter 零错误，也可以写很少代码但全是错误
- `debug` 独立：调试是主动的探索行为（设断点、单步、查变量），与被动的运行结果（run）是不同的学习信号维度
- 调试策略揭示**元认知能力**——系统性调试 vs 随意 print，这是画像的重要维度

---

## 三、逐维度对比分析与取舍

### 3.1 记忆模型

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 分层 | L1→L2→L3 | Timeline+CompiledTruth | Raw→Wiki→Schema | **采用 DeepTutor 的三层**——因为我们是多 surface 系统，L2 中间层必需 |
| L2 必要性 | 必需（7 surface） | 不需要 | 不需要 | **必需**——虽然只有 2-3 个 surface，但 edit 和 chat 的学习信号形态完全不同 |
| L3 槽位 | 4个(recent/profile/scope/preferences) | 无(单页面) | 无(每页自含) | **MVP 先做 profile，其余渐进**——顶层设计定义了 4 个，P1 先跑通 profile.md，其余可后续 |
| 真相源 | JSONL+Markdown | Git 中的 Markdown | 文件系统中的 Markdown | **文件系统 Markdown**——与 P0 的 globalStorageUri 一致 |

**结论：采用 DeepTutor 的 L1→L2→L3 三层，但简化 L3 为单槽位 profile.md，surface 为 4 个（edit/run/chat/diag）。**

### 3.2 知识构建方式

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 构建驱动 | 管道自动（9步） | Agent 显式写入 | LLM 两步摄入 | **管道自动**——用户点"更新画像"触发管道，不需要 Agent 介入 |
| LLM 调用模式 | Agentic loop（每步一action） | 外部 Agent 调用 | 两步思维链 | **两步思维链**（借鉴 LLM Wiki）——先分析新事件再生成事实，比单步质量高 |
| 人工参与 | 无（全自动） | 显式写入 | 异步审核 | **全自动+可选审核**——MVP 全自动，后续可加审核队列 |

**结论：管道自动 + 两步思维链摄入。不是 DeepTutor 的 agentic loop（太重），不是 GBrain 的 Agent 驱动（太慢），借鉴 LLM Wiki 的两步思路提升质量。**

### 3.3 更新语义

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| L2 更新 | AddOp/EditOp/DeleteOp 原子 | N/A | LLM 合并 | **原子 Op 批次**——与 DeepTutor 一致，防止 LLM 自相矛盾 |
| L3 更新 | AddOp/EditOp/DeleteOp 原子 | Compiled Truth REWRITE | LLM 合并 | **借鉴 GBrain 的 REWRITE 语义**——学习者画像应该是"当前综合"，不是追加 |
| 合并保护 | 5层防御 | 3层剥离 | 3层保护 | **DeepTutor 的5层防御**——学习者画像错误比知识库错误危害更大 |

**关键洞察：L2 和 L3 的更新语义应该不同！**

- **L2：原子 Op**（Add/Edit/Delete）——L2 是结构化事实存储，精确操作是合适的
- **L3：REWRITE**——L3 是学习者综合画像，新信息应该触发整个画像重写，而不是追加条目

这比 DeepTutor 原设计更优：DeepTutor 对 L2 和 L3 都用 Op，但 L3 用 REWRITE 更符合"画像是当前综合"的语义（GBrain 的洞见）。

### 3.4 增量机制

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 增量检测 | seen-ID 差分 (meta.json) | content_hash | SHA256 缓存 | **seen-ID 差分**——与 DeepTutor 一致，纯集合运算，确定性，不受时间影响 |
| 幂等性 | ✅ 相同 seen→相同差分 | ✅ 相同 hash→跳过 | ✅ 相同 SHA256→跳过 | **✅** |
| 持久化 | meta.json sidecar | pages.content_hash 列 | ingest-cache.json | **meta.json sidecar**——与 DeepTutor 一致，与 Markdown 文件同目录 |

**结论：采用 DeepTutor 的 seen-ID 差分 + meta.json sidecar。**

### 3.5 搜索/检索

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 搜索 | 无（直接读 Markdown） | 4策略混合(P@5=49.1) | 分词+向量+图谱(3阶段) | **不需要搜索**——画像只有4个 L2 文件+1个 L3 文件，直接读全文 |
| 向量存储 | 无 | Postgres+pgvector | LanceDB | **不需要**——画像体量小，全文拼入 prompt 即可 |
| 图谱 | 无 | 4信号+BFS+rerank | 4信号+Louvain+洞察 | **MVP 不需要**——学习者画像的关系图不如知识库密集 |

**结论：MVP 不做搜索/向量/图谱。画像直接拼入 LLM system prompt。如果后续画像膨胀到需要搜索，再加向量索引。**

### 3.6 文档格式与引用

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 文档格式 | Markdown + footnote + HTML comment | Markdown + fence + frontmatter | Markdown + frontmatter + wikilink | **DeepTutor 格式**——footnote 引用链+HTML comment 锚点最适合审计 |
| 引用粒度 | entry id / trace id / surface name | fence 行号 / source 标注 | frontmatter sources[] / wikilink | **DeepTutor 粒度**——三层引用（L3→surface→L2→trace→L1）最完整 |
| Facts 结构 | 自然语言条目 | 围栏表格(claim/kind/confidence/visibility) | 自然语言+frontmatter | **自然语言条目+简化版 GBrain kind 字段**——在 entry 的 refs 旁加可选 kind 字段 |

**改进点：借鉴 GBrain 的 Facts 围栏思路，给每个 entry 加可选 `kind` 字段：**

```
DeepTutor 原始格式:
- Prefers step-by-step explanations [^1] <!--m_xxx-->

改进格式:
- Prefers step-by-step explanations [^1] <!--m_xxx kind:preference-->
```

这比 GBrain 的完整围栏表格轻量，但比纯自然语言更有结构。

### 3.7 防御体系

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 参考池限制 | ✅ | 无 | 无 | **✅ 采用**——防止 LLM 幻觉引用 |
| 输出验证 | ✅ validate_fact_refs | ✅ content-sanity | ✅ 路径安全 | **✅ 采用**——兜底防幻觉 |
| Banned phrase | ✅ 20+ 条 | ✅ guardrails(observe-only) | 无 | **✅ 采用**——教学场景最怕过度自信断言 |
| Op 验证 | ✅ 整批原子 | ✅ system-of-record CI gate | ✅ 合并3层保护 | **✅ 采用**——数据完整性 |
| 预算控制 | ✅ ToolBudgets | ✅ cost gate | ✅ context budget | **✅ 采用**——防无限循环 |
| 隐私 | 无 | ✅ 3层剥离 | 无 | **MVP 不做**——单用户无隐私需求 |

**结论：完整采用 DeepTutor 的五层防御。**

### 3.8 分块策略

| 维度 | DeepTutor | GBrain | LLM Wiki | **我们取舍** |
|------|-----------|--------|---------|------------|
| 分块器 | 字符预算+边界扩展 | 5级递归分隔符 | 6级Markdown感知递归 | **DeepTutor 的字符预算+边界扩展**——简单有效，画像体量小 |
| 边界对齐 | 段落/句子 | 段落/行/句子/子句/词 | 标题/段落/行/句子/空格/字符 | **段落/句子**——与 DeepTutor 一致 |
| CJK 支持 | 句级(.。！？) | 专门的CJK分隔符集 | 二元组分词 | **句级 CJK 标点**——足够用于中文画像 |

**结论：采用 DeepTutor 的 chunk_with_boundary，简单移植。**

---

## 四、推荐架构

### 4.1 整体架构

```
vscode-pylearner (P1 架构)
│
├── L1 层（P0 已实现）
│   ├── storage/l1Writer.ts          → JSONL append（已有）
│   ├── events/editListener.ts       → .py edit 事件（已有）
│   ├── events/runListener.ts        → Python run 事件（已有）
│   ├── events/chatListener.ts       → chat 事件（已有）
│   └── events/diagListener.ts       → diagnostics 事件（已有）
│
├── L2 层（P1 新建）
│   ├── memory/document.ts           → Markdown parse/serialize（移植 DeepTutor）
│   ├── memory/ops.ts                → AddOp/EditOp/DeleteOp + validate + apply（移植）
│   ├── memory/ids.ts                → ULID + ID 验证（移植）
│   ├── memory/guards.ts             → banned-phrase 过滤（移植）
│   ├── memory/parse.ts              → 容错 JSON 解析（移植）
│   ├── memory/chunker.ts            → 分块+边界对齐（移植）
│   ├── memory/references.ts         → 参考池+验证（适配）
│   ├── memory/meta.ts               → seen-ID 差分 meta.json（移植）
│   ├── snapshot/entity.ts           → Entity 快照（适配 P0 事件模型）
│   ├── snapshot/diff.ts             → 差分计算（移植）
│   └── consolidator/
│       ├── updateL2.ts              → L2 增量更新（两步思维链）
│       └── prompts/
│           ├── analyzeL2.ts         → 第一步：分析 prompt
│           └── generateL2.ts        → 第二步：生成 prompt
│
├── L3 层（P1 新建）
│   ├── memory/profileWriter.ts      → L3 profile.md REWRITE 逻辑
│   └── consolidator/
│       ├── updateL3.ts              → L3 增量更新（两步思维链 + REWRITE）
│       └── prompts/
│           ├── analyzeL3.ts         → 第一步：分析 prompt
│           └── generateL3.ts        → 第二步：生成 prompt
│
├── 画像注入
│   └── memory/profileInjector.ts    → 读 profile.md → 拼入 LLM system prompt
│
└── UI 扩展
    ├── webview-ui/src/components/ProfilePanel.tsx    → 画像预览面板
    └── commands/updateProfile.ts     → "更新画像" 命令
```

### 4.2 数据流

```
用户点"更新画像"
  │
  ├─ L2 更新流程
  │   │
  │   ├─ 1. Snapshot 当前 surface 实体（从 L1 JSONL 读取）
  │   ├─ 2. Diff vs meta.seen_entity_refs → 新增实体
  │   ├─ 3. render_with_markers() → 带锚点文本
  │   ├─ 4. chunk_with_boundary() → 分块
  │   │
  │   ├─ 5. 对每个 chunk（两步思维链）:
  │   │   │
  │   │   ├─ 第一步：分析
  │   │   │   ├─ system: "你是学习分析专家..." + schema + 引用池
  │   │   │   ├─ user: chunk 内容 + 已有 L2 文档
  │   │   │   └─ LLM → 结构化分析（关键学习信号、与已有知识的关系）
  │   │   │
  │   │   └─ 第二步：生成
  │   │       ├─ system: "你是学习画像构建专家..." + 分析结果 + 引用池
  │   │       ├─ user: chunk 内容 + 已有 L2 文档
  │   │       └─ LLM → AddOp/EditOp/DeleteOp 批次
  │   │
  │   ├─ 6. validate_fact_refs() → 过滤非法引用
  │   ├─ 7. guards._filter_banned() → 过滤禁用措辞
  │   ├─ 8. apply(doc, ops) → 原子应用
  │   ├─ 9. serialize(doc) → 写回 L2/<surface>.md
  │   └─ 10. save_l2_meta() → 更新 seen_entity_refs
  │
  ├─ L3 更新流程
  │   │
  │   ├─ 1. 读取所有 L2 文档
  │   ├─ 2. Diff vs meta.seen_l2_entry_ids → 各面新增条目
  │   ├─ 3. render + chunk
  │   │
  │   ├─ 4. 对每个 chunk（两步思维链 + REWRITE）:
  │   │   │
  │   │   ├─ 第一步：分析
  │   │   │   └─ LLM → 分析跨面学习信号
  │   │   │
  │   │   └─ 第二步：REWRITE（不是追加！）
  │   │       ├─ system: "重写学习者画像..." + 当前 profile.md
  │   │       ├─ user: 分析结果 + 各面新增条目
  │   │       └─ LLM → 完整的新 profile.md
  │   │
  │   ├─ 5. 长度安全检查（新画像 < 70% 原长 → 拒绝）
  │   ├─ 6. 锁定字段保护（type/title/created 不变）
  │   ├─ 7. 写回 L3/profile.md
  │   └─ 8. save_l3_meta() → 更新 seen_l2_entry_ids
  │
  └─ 画像注入
      └─ 下次聊天时: 读 profile.md → 截断到预算 → 拼入 system prompt
```

### 4.3 L2 文档示例

**L2/edit.md** — 编辑面事实：
```markdown
# Edit & Run Activities

## Code Patterns
- Uses list comprehensions frequently [^1] <!--m_01HZK4AB kind:pattern-->
- Prefers f-strings over .format() [^1] <!--m_01HZK5CD kind:preference-->
- Writes docstrings for public functions [^2] <!--m_01HZK6EF kind:habit-->

## Error Patterns
- Recursion without base case [^3] <!--m_01HZK7GH kind:weakness-->
- Off-by-one in range() [^3] <!--m_01HZK8IJ kind:weakness-->

## Progress
- Completed basic syntax module [^2] <!--m_01HZK9KL kind:progress-->
- Started OOP module [^2] <!--m_01HZK0MN kind:progress-->

---

[^1]: edit:01HZK4AB
[^2]: edit:01HZK5CD
[^3]: run:01HZK6EF
```

**L2/diag.md** — 诊断面事实：
```markdown
# Diagnostics & Linting

## Recurring Issues
- Missing self parameter in method definitions (3 occurrences this week) [^1] <!--m_01HZK1AB kind:weakness-->
- Unused imports (pylint W0611) [^1] <!--m_01HZK2CD kind:habit-->
- Inconsistent return types (mypy) [^2] <!--m_01HZK3EF kind:weakness-->

## Improvement Trend
- Linter warnings decreased from 12/day to 4/day over past week [^1] [^2] <!--m_01HZK4GH kind:progress-->
- Type annotation coverage increasing [^2] <!--m_01HZK5IJ kind:progress-->

---

[^1]: diag:01HZK1AB
[^2]: diag:01HZK3EF
```

### 4.4 L3 profile.md 示例

```markdown
---
type: profile
title: Python Learner Profile
created: 2026-08-28
updated: 2026-08-28
---

# Python Learner Profile

## Learning Style
- Prefers concrete examples before abstract explanations [^1] [^2]
- Learns best by modifying existing code rather than writing from scratch [^1]

## Strengths
- Solid grasp of Python basics (variables, loops, functions) [^1] [^2]
- Good at reading error messages and debugging [^2]
- Consistent use of type hints [^1]

## Areas for Improvement
- Struggles with async/await concepts [^2]
- Needs more practice with class inheritance and self parameter [^1] [^4]
- Recursion patterns need reinforcement [^2]
- Uses print debugging instead of interactive debugger [^3]

## Progress
- Completed: basic syntax, functions, file I/O [^1] [^2]
- In progress: OOP, decorators [^1]
- Not started: async, metaclasses, descriptors [^2]

## Preferences
- Uses f-strings consistently [^1]
- Prefers VS Code terminal over debug console [^3]

---

[^1]: edit
[^2]: chat
[^3]: debug
[^4]: diag
```

### 4.5 画像注入方式

```typescript
// profileInjector.ts
function buildSystemPromptWithProfile(
  baseSystemPrompt: string,
  profileMd: string,
  budget: ContextBudget
): string {
  const profileSection = profileMd
    .split('\n---\n')[0]  // 只取 compiled truth，不取 footnote
    .trim();

  const truncated = profileSection.slice(0, budget.pageBudget * 0.3);

  return `${baseSystemPrompt}

## Learner Profile
The following is the learner's profile. Use it to personalize your responses:
- Focus explanations on their areas for improvement
- Reference their strengths to build confidence
- Match their preferred learning style
- Skip topics they've already mastered

${truncated}`;
}
```

### 4.6 上下文预算分配

借鉴 LLM Wiki 的预算分配，但调整比例：

```
┌──────────────────────────────────────────────────┐
│              maxCtx (100%)                       │
├────────────┬──────────────┬──────────┬───────────┤
│  profile   │   history    │  system  │  response │
│    20%     │    45%       │   20%    │    15%    │
└────────────┴──────────────┴──────────┴───────────┘
```

- **Profile 20%**：学习者画像（比 LLM Wiki 的 50% 少，因为画像比 Wiki 页面小得多）
- **History 45%**：聊天历史是主要上下文
- **System 20%**：系统提示
- **Response 15%**：留给 LLM 回答

---

## 五、分阶段策略

### Phase 1a：纯函数移植（无 I/O，无 LLM）

**目标：** 让所有纯逻辑在 TypeScript 中跑通，用单元测试验证。

| 模块 | 来源 | 工作量 | 测试 |
|------|------|--------|------|
| `ids.ts` | DeepTutor ids.py | 小 | ULID 生成/验证/排序 |
| `document.ts` | DeepTutor document.py | 中 | parse/serialize 幂等、footnote 兼容 |
| `ops.ts` | DeepTutor ops.py | 中 | validate+apply 原子性、冲突检测 |
| `chunker.ts` | DeepTutor chunker.py | 小 | 边界对齐、CJK 标点、重叠 |
| `guards.ts` | DeepTutor guards.py | 小 | banned-phrase、引号豁免 |
| `parse.ts` | DeepTutor parse.py | 小 | 容错 JSON、代码围栏剥离 |
| `meta.ts` | DeepTutor meta.py | 小 | load/save、幂等 |
| `snapshot/entity.ts` | DeepTutor snapshot/entity.py | 小 | 数据类 |
| `snapshot/diff.ts` | DeepTutor snapshot/diff.py | 小 | added/modified/removed |

**估计：3-4 天**

### Phase 1b：I/O 适配 + 参考池

**目标：** 接入 P0 的 L1 数据和 globalStorageUri。

| 模块 | 工作量 | 说明 |
|------|--------|------|
| `references.ts` | 中 | 参考池计算，适配 P0 的 L1 事件模型 |
| `snapshot/adapter.ts` | 中 | 从 L1 JSONL 构建 Entity 快照 |
| `paths.ts` | 小 | 路径布局映射到 globalStorageUri |

**估计：2-3 天**

### Phase 1c：LLM 集成 + 两步思维链

**目标：** 实现两步摄入的 LLM 调用和 prompt 工程。

| 模块 | 工作量 | 说明 |
|------|--------|------|
| `consolidator/updateL2.ts` | 大 | L2 更新流程 + 两步思维链 |
| `consolidator/updateL3.ts` | 大 | L3 更新流程 + REWRITE |
| `prompts/analyzeL2.ts` | 中 | L2 分析 prompt |
| `prompts/generateL2.ts` | 中 | L2 生成 prompt |
| `prompts/rewriteL3.ts` | 中 | L3 重写 prompt |

**估计：4-5 天**

### Phase 1d：UI + 画像注入

**目标：** 用户可以看到画像，画像自动注入聊天。

| 模块 | 工作量 | 说明 |
|------|--------|------|
| `profileInjector.ts` | 小 | 画像→system prompt |
| `ProfilePanel.tsx` | 中 | Webview 画像预览 |
| `commands/updateProfile.ts` | 小 | VS Code 命令注册 |

**估计：2-3 天**

### 总估计

| 阶段 | 天数 | 累计 |
|------|------|------|
| Phase 1a：纯函数移植 | 3-4 | 3-4 |
| Phase 1b：I/O 适配 | 2-3 | 5-7 |
| Phase 1c：LLM 集成 | 4-5 | 9-12 |
| Phase 1d：UI + 注入 | 2-3 | 11-15 |

**总计 11-15 天，约 2-3 周。**

---

## 六、不建议采用的设计

### ❌ 不采用 GBrain 的 Postgres/PGLite

**理由：** VS Code 扩展不能运行数据库服务器。globalStorageUri + JSONL + Markdown 足够——画像体量小（单用户，2-3 个 surface，1 个 profile），不需要数据库索引。

### ❌ 不采用 GBrain 的四策略混合检索

**理由：** 画像只有 2-3 个 L2 文件 + 1 个 L3 文件，全文拼入 prompt 即可。搜索在体量小时无价值，反而增加复杂度。如果未来画像膨胀到需要搜索，再加向量索引。

### ❌ 不采用 GBrain 的零 LLM 实体链接

**理由：** 学习者画像的关系不是"人物→公司→投资"这种实体网络，而是"学会了X→接下来应该学Y"这种学习路径。学习路径推理需要 LLM，正则做不到。

### ❌ 不采用 LLM Wiki 的 LLM 自主知识构建

**理由：** 学习者画像的质量要求远高于一般知识库——错误画像会导致教学系统跳过关键内容。DeepTutor 的五层防御+原子 Op 比完全自主生成更安全。

### ❌ 不采用 LLM Wiki 的 Louvain 社区检测

**理由：** 学习面的分类是预定义的（edit/run/chat），不需要自动聚类。学习者的知识领域聚类可以未来再做，但 MVP 不需要。

### ❌ 不采用 DeepTutor 的 7 Surface

**理由：** vscode-pylearner 的 surface 更精炼：
- `edit`：代码编辑行为（合并 DeepTutor 的 chat+notebook 中与编程相关的部分）
- `run`：代码运行结果（错误输出、错误类型解析）
- `debug`：调试行为（断点/单步/变量检查）——揭示元认知能力，与 run 信号不同维度
- `chat`：AI 聊天交互
- `diag`：诊断信号（linter 错误、type 错误、代码质量指标）

5 个 surface 精准覆盖 Python 学习的关键信号维度，不需要 DeepTutor 的 7 个。顶层设计还预留了 `test`，P1 可暂不实现。

### ❌ 不对 L3 使用 AddOp/EditOp/DeleteOp

**理由：** 这是本次对比分析的关键洞察。DeepTutor 对 L3 也用 Op 操作，但 GBrain 的 Compiled Truth REWRITE 语义更适合画像——画像应该是"当前综合"，而不是条目追加。新信息应该触发整个画像重写，这样：
1. 不会出现矛盾条目并存（"掌握了装饰器" 和 "装饰器薄弱" 同时存在）
2. 画像永远是最新的综合视图
3. 长度可控（C不会无限增长

---

## 七、从 GBrain 和 LLM Wiki 吸收的额外洞见

> 以下是在三系统对比中发现的、尚未纳入前面推荐架构但值得吸收的设计思路。
> 不作为 P1 必做项，但应记录为 P1+ 扩展方向。

### 7.1 GBrain 是比 DeepTutor 更近的 TypeScript 参考

DeepTutor 是 Python，我们需要翻译成 TypeScript。GBrain **同样是 TypeScript**，且核心范式相同——"把行为流变成可查询的记忆"。存储/检索/分块/嵌入的代码习惯用法可以直接对照抄。

**P1 实践建议：** 遇到 TypeScript 实现细节问题时（如异步锁、文件原子写入、Markdown 解析边界），先看 GBrain 对应文件怎么写的，再看 DeepTutor 的 Python 逻辑来理解意图。

| 需求 | DeepTutor (Python) | GBrain (TypeScript) |
|------|-------------------|-------------------|
| Markdown parse | document.py | document.ts (围栏解析) |
| 分块 | chunker.py | chunkers/recursive.ts |
| 原子写入 | tempfile + rename | embed-retry.ts 的重试模式 |
| 异步锁 | asyncio.Lock | Map<surface, Promise> 链式序列化 |
| ID 生成 | ids.py (ULID) | ulidx (npm 包，P0 已用) |

### 7.2 评测方法论——我们怎么证明画像让 AI 回答变好了？

GBrain 的 RETRIEVAL.md 用 P@5/R@5 基准对比"有图谱 vs 无图谱 vs 纯 BM25/向量"的检索质量。配套仓库 `gbrain-evals` 展示了怎么搭评分卡。

**我们的管道至今没有回答"L2/L3 到底让 AI 回答变好了多少G"。** 这是一个根本性的缺口——没有评测，就无法知道画像系统是否有效。

**P1+ 扩展方向：** 设计类似 GBrain 的评测：
- 同一批 Python 学习问题
- **带画像 vs 不带画像**的回答质量对比
- 评分维度：准确性、个性化程度、是否跳过已掌握内容、是否针对薄弱点给建议
- 可以用 LLM-as-judge 打分，也可以人工评审

**P1 收尾时至少做一次非正式评测**——找 5-10 个典型 Python 学习问题，对比带/不带画像的 AI 回答，主观判断画像是否有价值。这决定 P2 的投入方向。

### 7.3 零 LLM 实体链接的省钱哲学

GBrain 用三个正则提取实体关系，零 LLM token。LLM Wiki 用 `[[wikil5]]` 双链。核心思路：**用规则先把结构织好，LLM 只干提炼。**

这和我们的设计哲学一致——"分块/校验/验证全是纯函数，LLM 只负责提取事实"。但我们目前只做到了**纵向引用**（条目→证据的DAG），缺少**横向关联**（事实↔事实的概念网络）。

### 7.4 [[wikilink]] 双链——L2 事实间的横向关联

**当前缺口：** L2 条目只有"指向证据的脚注"（纵向），没有"事实与事实之间的横向关联"。

例如：
- "怕递归" 和 "循环写法总出错" 是相关事实，但目前它们只是两条独立的条目
- "ZeroDivisionError ↔ 算术运算 ↔ input() 返回值" 形成概念链，AI 回答时可以联想

**P1+ 扩展方向：** 给 L2 加一层概念关联，借鉴 `[[wikilink]]` 语法：

```markdown
## Error Patterns
- Recursion without base case [[recursion]] [^3] <!--m_xxx kind:weakness-->
- Loop off-by-one in range() [[loop-pattern]] [^3] <!--m_yyy kind:weakness-->

## Related Concepts
- [[recursion]] — always paired with [[loop-pattern]]; student avoids both
- [[zero-division]] — stems from [[arithmetic]] + [[input-uncertainty]]
```

**实现时机：** P1 不做（增加复杂度）。P2 时如果发现 AI 回答缺联想能力（比如只针对单条事实回答，不能关联"怕递归"+"循环出错"给出综合建议），再加双链。

**GBrain 的实体图谱和 LLM Wiki 的 wikilink 是同一个缺口的两种方案**——GBrain 用零 LLM 正则建图，LLM Wiki 用 LLM 生成双链。我们可以在 P2 时选择：
- 如果事实量大→用 GBrain 式正则提取
- 如果事实量小且需要精确关联→用 LLM 生成双链

---

## 八、风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| **LLM 幻觉引用** | 高 | 五层防御：参考池→validate→banned→Op验证→预算 |
| **画像截断/丢失** | 高 | L3 REWRITE + 长度安全检查（<70% 原长→拒绝）+ 锁定字段 |
| **两步摄入 LLM 成本** | 中 | 每次"更新画像"调用 2×chunk 数 次 LLM；画像通常 2-4 个 chunk → 4-8 次调用，可接受 |
| **画像过期** | 中 | 画像显示最后更新时间；用户可随时手动更新 |
| **prompt 工程难度** | 中 | L2/L3 的 prompt 需要反复迭代；先从 DeepTutor 的 YAML prompt 翻译，再调优 |
| **TypeScript 移植差异** | 低 | 纯函数移植是机械工作；Python→TS 的类型系统更强，反而有助于发现 bug |
| **CJK 画像质量** | 低 | banned-phrase 已包含中文；prompt 支持 zh/en 双语（DeepTutor 已有） |

---

## 附录：三系统关键指标速查

| 指标 | DeepTutor | GBrain | LLM Wiki |
|------|-----------|--------|---------|
| 代码量 | ~2K 行管道 | ~8K 行核心 | ~6K 行核心 |
| 语言 | Python | TypeScript | TypeScript+Rust |
| 依赖 | 无（纯 std# asyncio） | Postgres/PGLite | LanceDB+Tauri |
| 部署 | 嵌入式库 | CLI+.MCP | 桌面应用 |
| LLM 依赖度 | 高（每步调用） | 低（零LLM链接） | 高（两步摄入） |
| 搜索 P@5 | N/A | 49.1 | ~71.4 R@R |
| 防御层数 | 5 | 3 | 3 |
| 增量机制 | seen-ID | content_hash | SHA256 |
| 可审计性 | L3→L2→L1 | Truth→Timeline→Source | Wiki→sources[] |
