# vscode-pylearner P1 设计规格书

> 学习者画像管道：L1→L2→L3 编译 + 注入
> 版本：1.0 | 日期：2026-08-28
> 基于：三系统对比分析（DeepTutor / GBrain / LLM Wiki）

---

## 1. 目标

将 P0 已有的 L1 事件采集扩展为完整的学习者画像管道，使 AI 聊天能够基于画像个性化回答。

**P1 交付物：**

1. L2 面级事实文档（Markdown + footnote + HTML comment 锚点）
2. L3 学习者画像（profile.md，REWRITE 语义）
3. 画像注入（profile.md → 聊天 system prompt）
4. "更新画像"命令 + 画像预览面板

**不做：** P1 不做，但保留 P1+ 扩展点
- 搜索/向量/图谱：体量小时用全文搜索，膨胀时再加
- 多租户/隐私层：单用户无需
- 四策略混合检索：P1+ 当画像膨胀到需要时
- Facts 围栏：P1 用自然语言+kind字段，P1+ 考虑结构化

---

## 2. 架构概览

```
用户点"更新画像"
  │
  ├─ L2 更新（每 surface）
  │   Snapshot L1 → Diff seen-IDs → Chunk → 两步思维链 → 原子 Op → validate → apply
  │
  ├─ L3 更新
  │   读取所有 L2 → Diff seen-entry-IDs → Chunk → 两步思维链 → REWRITE → 长度安全 → 写回
  │
  └─ 画像注入
      读 profile.md → 截断到预算 → 拼入 system prompt
```

### 2.1 Surface 划分

5 个 surface，与 P0 代码一致：

| Surface | 事件来源 | 学习信号 |
|---------|---------|---------|
| **edit** | `onDidChangeTextDocument`（.py，防抖） | 编辑模式、代码风格、习惯 |
| **run** | Task + Terminal（Python 执行） | 运行结果、错误类型 |
| **debug** | `debug.*`（断点/单步/变量） | 调试策略、元认知能力 |
| **chat** | AI 聊天交互 | 提问模式、困惑点 |
| **diag** | `onDidChangeDiagnostics`（linter/type） | 重复错误模式、代码质量趋势 |

顶层设计还预留 `test` surface，P1 不实现。

---

## 3. 数据模型

### 3.1 L2 文档格式

每个 surface 一个 Markdown 文件，位于 `globalStorageUri/l2/<surface>.md`。

```markdown
# Edit Activities

## Code Patterns
- Uses list comprehensions frequently [^1] <!--m_01HZK4AB kind:pattern-->
- Prefers f-strings over .format() [^1] <!--m_01HZK5CD kind:preference-->
- Writes docstrings for public functions [^2] <!--m_01HZK6EF kind:habit-->

## Error Patterns
- Recursion without base case [^3] <!--m_01HZK7GH kind:weakness-->

## Progress
- Completed basic syntax module [^2] <!--m_01HZK9KL kind:progress-->

---

[^1]: edit:01HZK4AB
[^2]: edit:01HZK5CD
[^3]: edit:01HZK7GH
```

**结构规则：**
- 每条目：`- <自然语言> [^N] <!--m_<ULID> kind:<kind>-->`
- kind 枚举：`pattern | preference | habit | weakness | progress | goal`  
- P1+ 可扩展：`claim | confidence` → 结构化 Facts 围栏（GBrain 模式）
- footnote 格式：`[^N]: <surface>:<trace_id>`
- HTML comment 锚点：`<!--m_<entry_id> kind:<kind>-->`（可选，便于机器解析）
- 一级标题固定，二级标题自由（LLM 可创建新二级标题，但默认使用 Code Patterns / Error Patterns / Progress）

### 3.2 L3 画像格式

单个文件 `globalStorageUri/l3/profile.md`。

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

## Strengths
- Solid grasp of Python basics (variables, loops, functions) [^1] [^2]

## Areas for Improvement
- Struggles with async/await concepts [^2]
- Missing self parameter in method definitions [^4]

## Progress
- Completed: basic syntax, functions, file I/O [^1] [^2]
- In progress: OOP, decorators [^1]

## Preferences
- Uses f-strings consistently [^1]
- Prefers VS Code terminal over debug console [^3]

---

[^1]: edit
[^2]: chat
[^3]: debug
[^4]: diag
```

**结构规则：**
- frontmatter：`type` / `title` / `created` / `updated`（锁定字段，REWRITE 不覆盖）
- 二级标题建议：Learning Style / Strengths / Areas for Improvement / Progress / Preferences
- footnote 指向 surface（不是 trace_id），因为 L3 是跨面综合

### 3.3 Meta Sidecar

每个 L2 文件配套 `l2/<surface>.meta.json`，L3 配套 `l3/profile.meta.json`。

```typescript
interface SurfaceMeta {
  seen_entity_refs: string[];  // 已处理的 L1 实体 ID 集合
  last_updated: string;        // ISO 8601
}

interface ProfileMeta {
  seen_l2_entry_ids: string[]; // 已处理的 L2 entry ID 集合
  last_updated: string;
}
```

---

## 4. 核心模块

### 4.1 文档模型 `memory/document.ts`

移植 DeepTutor `document.py`，参考 GBrain `document.ts` 的 TypeScript 写法。

```typescript
interface Document {
  title: string;
  sections: Section[];
  footnotes: Map<string, Footnote>;
}

interface Footnote {
  id: string;       // ^N
  surface: string;  // surface name (edit/run/chat/debug/diag)
  traceId: string;  // trace ID（L2 用），L3 留空
}

interface Section {
  heading: string;  // 二级标题文本
  entries: Entry[];
}

interface Entry {
  id: string;       // m_<ULID>
  text: string;     // 自然语言
  kind?: string;    // pattern | preference | habit | weakness | progress | goal
  refs: string[];   // footnote ID 列表
}

// 核心操作
function parse(md: string): Document;
function serialize(doc: Document): string;
function renderWithMarkers(doc: Document): string;  // 带 ULID 锚点渲染
```

**不变量：** `serialize(parse(md)) === md`（幂等往返）

### 4.2 原子操作 `memory/ops.ts`

```typescript
type Op = AddOp | EditOp | DeleteOp;

interface AddOp {
  type: "add";
  section: string;   // 目标二级标题
  entry: Entry;
}

interface EditOp {
  type: "edit";
  entryId: string;   // m_<ULID>
  patches: Partial<Entry>;
}

interface DeleteOp {
  type: "delete";
  entryId: string;
}

// 批次操作：整批验证 + 原子应用
function validate(doc: Document, ops: Op[]): ValidationResult;
function apply(doc: Document, ops: Op[]): Document;  // 验证失败则不应用
```

**关键：** validate 和 apply 只在整批上操作。一个 Op 验证失败 → 整批拒绝。防止 LLM 自相矛盾。

### 4.3 增量差分 `snapshot/diff.ts`

```typescript
interface EntitySnapshot {
  surface: Surface;
  entityRefs: string[];  // L1 中的实体 ID
  traceCount: number;    // 该 surface 的 trace 总数
  errorCount?: number;   // run/diag surface 的错误数
  editLineCount?: number; // edit surface 的编辑行数
  chatTurnCount?: number; // chat surface 的对话轮数
  debugStepCount?: number; // debug surface 的单步次数
}

function computeDiff(
  current: EntitySnapshot,
  seen: string[]  // meta.seen_entity_refs
): {
  added: string[];
  modified: string[];
  removed: string[];
};
```

**幂等性：** 相同 current + seen → 相同 diff。

### 4.4 参考池 `memory/references.ts`

```typescript
interface ReferencePool {
  // L2 参考池：当前文档中所有合法的 entry ID + footnote ID
  entryIds: Set<string>;
  footnoteIds: Set<string>;
  // L1 参考池：当前 surface 的所有 trace ID
  traceIds: Set<string>;
}

function buildReferencePool(l2Doc: Document, l1TraceIds: string[]): ReferencePool {
  // 收集文档中所有 entry IDs
  const entryIds = new Set<string>();
  const footnoteIds = new Set<string>();
  
  for (const [_, entries] of l2Doc.sections) {
    for (const entry of entries) {
      entryIds.add(entry.id);
      // 收集 footnote IDs（如果有）
      for (const ref of entry.refs) {
        if (ref.startsWith('^[1-9]')) { // footnote 格式
          footnoteIds.add(ref);
        }
      }
    }
  }
  
  return {
    entryIds,
    footnoteIds,
    traceIds: new Set(l1TraceIds)
  };
}
```

### 4.5 五层防御

```
Layer 1: 参考池限制     — LLM 输出引用必须在 referencePool 中
Layer 2: validate_fact_refs — 检查每个 Op 的 refs 合法性
Layer 3: banned-phrase    — 过滤"你已经完全掌握"等过度自信措辞
Layer 4: Op 验证          — 整批 validate，一个失败全批拒绝
Layer 5: 预算控制         — 每次"更新画像"最多 20 次 LLM 调用（5 surfaces × 2 steps × 2 chunks 上限）
```

**Layer 2: validate_fact_refs 实现**
```typescript
function validate_fact_refs(ops: Op[], pool: ReferencePool): ValidationResult {
  const errors: string[] = [];
  
  for (const op of ops) {
    // 检查所有引用是否在参考池中
    for (const ref of op.refs) {
      if (!pool.entryIds.has(ref) && 
          !pool.footnoteIds.has(ref) && 
          !pool.traceIds.has(ref) &&
          !is_shortname_ref(ref)) {
        errors.push(`Invalid ref: ${ref}`);
      }
    }
    
    // L2 特殊检查：entry 引用必须有对应 trace 支持
    if (op.op === "add" || op.op === "edit") {
      const traceRefs = op.refs.filter(ref => is_trace_id(ref));
      if (traceRefs.length > 0 && !traceRefs.every(ref => pool.traceIds.has(ref))) {
        errors.push(`Missing trace support for: ${traceRefs.join(", ")}`);
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}
```

**banned phrases（初始列表，可扩展）：**

```
"你已经完全掌握"
"你不需要再学习"
"你是专家"
"永远不会再犯"
"100% 掌握"
"perfect understanding"
"fully mastered"
"no need to study"
```

---

## 5. 两步思维链摄入

借鉴 LLM Wiki 的两步思路，每 chunk 分两步调用 LLM：

### 5.1 L2 两步摄入

```
第一步：分析
  system: "你是 Python 学习分析专家。分析以下学习事件，识别关键学习信号。"
  user:   chunk 内容 + 已有 L2 文档 + JSON schema
  输出:   { signals: [...], relations: [...] }

第二步：生成
  system: "你是学习画像构建专家。根据分析结果生成事实条目。"
  user:   分析结果 + chunk 内容 + 已有 L2 文档 + 参考池
  输出:   { ops: [AddOp | EditOp | DeleteOp] }
```

### 5.2 L3 两步摄入 + REWRITE

```
第一步：分析
  system: "你是学习者画像分析专家。分析跨面学习信号的变化。"
  user:   各面新增条目 + 当前 profile.md
  输出:   { changes: [...], highlights: [...] }

第二步：REWRITE（不是追加！）
  system: "重写学习者画像，整合新信息，保持一致性。"
  user:   分析结果 + 当前 profile.md + 各面新增条目
  输出:   完整的新 profile.md 内容
```

**REWRITE 安全检查：**
- 冷启动（无原画像）：创建最小画像（至少包含 Learning Style/Strengths/Areas for Improvement 三个章节）
- 新画像长度 < 50% 原长 → 拒绝（可能丢失关键内容）
- 新画像长度 > 150% 原长 → 截断到预算限制，保留最相关内容
- frontmatter 的 type/title/created 不变
- updated 字段更新为当前时间
- 如果截断，保留所有章节但精简每个章节的内容描述

---

## 6. 错误处理与并发安全

### 6.1 LLM 错误处理

```typescript
interface LLMCallConfig {
  maxRetries: 3;
  timeoutMs: 30000;
  fallbackStrategy: "skip" | "use_last" | "error";
}

interface LLMResult {
  success: boolean;
  data?: any;
  error?: string;
  retryCount: number;
}

async function callLLMSafe(
  prompt: string,
  config: LLMCallConfig = { maxRetries: 3, timeoutMs: 30000, fallbackStrategy: "skip" }
): Promise<LLMResult> {
  let lastError: string;
  
  for (let i = 0; i < config.maxRetries; i++) {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('LLM timeout')), config.timeoutMs)
      );
      
      const result = await Promise.race([
        llmRouter.call(prompt),
        timeoutPromise
      ]);
      
      return { success: true, data: result, retryCount: i };
    } catch (error) {
      lastError = error.message;
      if (i === config.maxRetries - 1) break;
      
      // 指数退避
      await new Promise(resolve => 
        setTimeout(resolve, 1000 * Math.pow(2, i))
      );
    }
  }
  
  return { 
    success: false, 
    error: lastError,
    retryCount: config.maxRetries
  };
}
```

### 6.2 并发安全机制

```typescript
// Surface 级别锁，防止并发更新
const surfaceLocks = new Map<string, Promise<void>>();

async function withSurfaceLock<T>(
  surface: string,
  fn: () => Promise<T>
): Promise<T> {
  const existingLock = surfaceLocks.get(surface);
  if (existingLock) {
    await existingLock;
  }
  
  const newLock = (async () => {
    try {
      return await fn();
    } finally {
      surfaceLocks.delete(surface);
    }
  })();
  
  surfaceLocks.set(surface, newLock);
  return newLock;
}

// 原子文件写入
async function writeAtomically(uri: vscode.Uri, content: string): Promise<void> {
  const tempUri = vscode.Uri.joinPath(uri, `tmp_${Date.now()}.md`);
  
  try {
    // 写入临时文件
    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(content));
    
    // 原子性重命名
    await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
  } catch (error) {
    // 清理临时文件
    try {
      await vscode.workspace.fs.delete(tempUri);
    } catch {}
    throw error;
  }
}
```

---

## 7. 两步思维链详细定义

### 7.1 关键学习信号定义

**信号类型：**
- `pattern`: 代码模式偏好（如特定语法使用频率）
- `preference`: 学习风格偏好（如示例优先vs理论优先）
- `habit`: 编程习惯（如命名规范、注释习惯）
- `weakness`: 常见错误类型（如特定概念理解偏差）
- `progress`: 学习进度里程碑
- `goal`: 明确的学习目标

**信号判断标准：**
- 出现频率：同一概念在 3+ 个不同事件中重复出现
- 上下文一致性：在不同场景下表现相同偏好
- 变化趋势：从错误到正确的行为转变
- 关联性：多个信号指向同一学习障碍

### 7.2 Relations 字段使用

**Relations 表示：**
- `supports`: 新信号支持已有认知
- `contradicts`: 新信号与已有认知冲突
- `extends`: 新信号深化已有理解
- `prerequisite`: 新信号是学习其他概念的基础

---

## 8. 画像注入

```typescript
### 8.1 原子操作时间窗口

**更新画像总时长限制：**
- 最长总耗时：5 分钟
- 单个 surface 更新：1 分钟
- 单个 LLM 调用：30 秒（含重试）
- 文件 I/O 操作：5 秒

**超时处理：**
- 超时后取消所有未完成的 LLM 调用
- 返回部分更新的结果
- 记录超时日志供后续分析

**重试机制：**
- 网络错误：立即重试
- LLM 内部错误：等待 2^n 秒后重试（n=重试次数）
- 超时错误：直接失败，不重试

### 8.2 智能画像截断策略

**截断优先级：**
1. 保留所有章节标题
2. 优先保留 Progress/Strengths（积极反馈）
3. 次要保留 Areas for Improvement（待改进点）
4. 最后精简 Preferences（偏好）

**截断算法：**
```typescript
function truncateProfile(profileMd: string, maxTokens: number): string {
  const sections = parseSections(profileMd);
  let currentLength = 0;
  const truncated: string[] = [];
  
  // 先添加 frontmatter
  truncated.push(sections.frontmatter);
  
  for (const section of sections.content) {
    // 检查是否包含关键词
    const isCritical = section.heading.match(/(Strengths|Progress)/i);
    const isImportant = section.heading.match(/(Areas for Improvement)/i);
    
    if (isCritical) {
      // 完整保留
      truncated.push(section.content);
      currentLength += section.tokens;
    } else if (isImportant) {
      // 保留前 3 条
      const entries = section.entries.slice(0, 3);
      truncated.push(renderSection(section.heading, entries));
      currentLength += section.tokens * 0.5;
    } else {
      // 只保留标题
      truncated.push(`## ${section.heading}`);
      currentLength += 10;
    }
    
    if (currentLength > maxTokens) {
      break;
    }
  }
  
  return truncated.join('\n\n');
}
```

function buildSystemPromptWithProfile(
  baseSystemPrompt: string,
  profileMd: string,
  budget: ContextBudget
): string {
  // 只取 compiled truth（frontmatter + 正文），不取 footnote 段
  const profileSection = extractCompiledTruth(profileMd);
  const truncated = profileSection.slice(0, budget.profileBudget);
  
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

### 6.1 上下文预算

```typescript
interface ContextBudget {
  maxCtx: number;          // 模型最大上下文（token 数）
  profileRatio: 0.20;      // 画像占 20%
  historyRatio: 0.45;      // 历史占 45%
  systemRatio: 0.20;       // 系统提示占 20%
  responseRatio: 0.15;     // 回答预留 15%
  readonly profileBudget: number;  // = maxCtx × profileRatio
}
```

```
┌──────────────────────────────────────────────────┐
│              maxCtx (100%)                       │
├────────────┬──────────────┬──────────┬───────────┤
│  profile   │   history    │  system  │  response │
│    20%     │    45%       │   20%    │    15%    │
└────────────┴──────────────┴──────────┴───────────┘
```

---

## 7. 分阶段实现

### Phase 1a：纯函数移植（3-4 天）

| 模块 | 来源 | 测试要点 |
|------|------|---------|
| `ids.ts` | DeepTutor ids.py | ULID 生成/验证/排序 |
| `document.ts` | DeepTutor document.py + GBrain document.ts | parse/serialize 幂等 |
| `ops.ts` | DeepTutor ops.py | validate+apply 原子性 |
| `chunker.ts` | DeepTutor chunker.py | 边界对齐、CJK 标点 |
| `guards.ts` | DeepTutor guards.py | banned-phrase |
| `parse.ts` | DeepTutor parse.py | 容错 JSON |
| `meta.ts` | DeepTutor meta.py | load/save 幂等 |
| `snapshot/entity.ts` | DeepTutor snapshot/entity.py | 数据类 |
| `snapshot/diff.ts` | DeepTutor snapshot/diff.py | added/modified/removed |

**无 I/O、无 LLM、无 VS Code API 依赖。** 纯函数 + 单元测试。

### Phase 1b：I/O 适配（2-3 天）

| 模块 | 说明 |
|------|------|
| `references.ts` | 参考池计算，适配 P0 的 L1 事件模型 |
| `snapshot/adapter.ts` | 从 L1 JSONL 构建 Entity 快照 |
| `paths.ts` | 路径布局映射到 globalStorageUri |

### Phase 1c：LLM 集成（4-5 天）

| 模块 | 说明 |
|------|------|
| `consolidator/updateL2.ts` | L2 两步思维链更新流程 |
| `consolidator/updateL3.ts` | L3 两步思维链 + REWRITE |
| `prompts/analyzeL2.ts` | L2 分析 prompt |
| `prompts/generateL2.ts` | L2 生成 prompt |
| `prompts/analyzeL3.ts` | L3 分析 prompt |
| `prompts/rewriteL3.ts` | L3 重写 prompt |

### Phase 1d：UI + 注入（2-3 天）

| 模块 | 说明 |
|------|------|
| `profileInjector.ts` | 画像 → system prompt |
| `ProfilePanel.tsx` | Webview 画像预览 |
| `commands/updateProfile.ts` | VS Code 命令注册 |

**总计 11-15 天，约 2-3 周。**

---

## 8. GBrain 参考策略

遇到 TypeScript 实现细节时，优先参考 GBrain（同语言、同范式），再看 DeepTutor（理解意图）：

| 需求 | DeepTutor (Python) | GBrain (TypeScript) |
|------|-------------------|-------------------|
| Markdown parse | document.py | document.ts (围栏解析) |
| 分块 | chunker.py | chunkers/recursive.ts |
| 原子写入 | tempfile + rename | embed-retry.ts 重试模式 |
| 异步锁 | asyncio.Lock | Map\<surface, Promise\> 链式序列化 |
| ID 生成 | ids.py (ULID) | ulidx (npm 包，P0 已用) |

---

## 9. P1+ 扩展方向（不做，但记录）

### 9.1 精确匹配搜索（P1+）
如果 L2 画像膨胀，添加四策略混合检索：
- 向量搜索（语义相似度）
- BM25（关键词匹配，标识符精确查找）
- RRF（融合得分）
- 知识图谱查询（未来横向关联 [[wikilink]] 时）

提升场景：代码变量名、函数名精确匹配（`prefers f-strings` 能检索到）。

### 9.2 评测方法论

设计"带画像 vs 不带画像"回答质量基准（类似 GBrain P@5/R@5）。
P1 收尾时至少做一次非正式评测（5-10 个问题，主观对比），决定 P2 投入方向。

### 9.3 精确匹配搜索（P1+）

给 L2 加事实间横向关联。当前只有纵向脚注（条目→证据），缺少横向（事实↔事实）。
P2 时如果 AI 回答缺联想能力再加。方案选择：事实量大→GBrain 式正则；量小→LLM 生成双链。

### 9.4 画像可移植性

学生换电脑时画像丢失。方案 B（便携导出/导入）优先：
- "导出画像"命令 → 生成 `.zip`（含 l2/ + l3/ + meta/）
- "导入画像"命令 → 从 `.zip` 恢复到 globalStorageUri
- P2+ 可考虑 VS Code Settings Sync 集成（自动漫游）

### 9.5 Markdown 灾难恢复

### 9.6 额外 L3 槽位

顶层设计定义了 4 个 L3 槽位（recent/profile/scope/preferences）。P1 只做 profile，其余渐进。

---

## 10. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| LLM 幻觉引用 | 高 | 五层防御 |
| 画像截断/丢失 | 高 | REWRITE + 长度安全检查 + 锁定字段 |
| 两步摄入 LLM 成本 | 中 | 每次更新 2×chunk 数 次 LLM；通常 4-8 次 |
| 画像过期 | 中 | 显示最后更新时间；用户可手动更新 |
| prompt 工程难度 | 中 | 先从 DeepTutor YAML prompt 翻译，再调优 |
| TypeScript 移植差异 | 低 | 纯函数移植是机械工作；TS 类型系统更强 |
| CJK 画像质量 | 低 | banned-phrase 含中文；prompt 支持 zh/en |

---

## 附录 A：文件路径布局

```
globalStorageUri/
├── l1/
│   ├── edit.jsonl        (P0 已有)
│   ├── run.jsonl         (P0 已有)
│   ├── chat.jsonl        (P0 已有)
│   ├── debug.jsonl       (P0 已有)
│   └── diag.jsonl        (P0 已有)
├── l2/
│   ├── edit.md
│   ├── edit.meta.json
│   ├── run.md
│   ├── run.meta.json
│   ├── debug.md
│   ├── debug.meta.json
│   ├── chat.md
│   ├── chat.meta.json
│   ├── diag.md
│   └── diag.meta.json
└── l3/
    ├── profile.md
    └── profile.meta.json
```

## 附录 B：L2 → L3 引用链

```
L3 profile.md
  └─ footnote → surface name (edit/run/chat/debug/diag)
      └─ L2 <surface>.md
          └─ footnote → surface:trace_id
              └─ L1 <surface>.jsonl (具体事件)
```

三层引用链保证画像中每条断言可追溯到原始事件。
