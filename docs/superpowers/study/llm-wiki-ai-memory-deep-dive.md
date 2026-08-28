# LLM Wiki 工作原理深度解析（特别是 AI 记忆方面）

> 基于 LLM Wiki 开源项目源码精读：https://github.com/nashsu/llm_wiki
> 本地代码路径：D:\ruan\llm_wiki
> 基于 Karpathy 的 LLM Wiki 方法论：https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
> 生成日期：2026-08-28

---

## 目录

1. [LLM Wiki 是什么](#一llm-wiki-是什么)
2. [Karpathy 原始方法论（设计哲学）](#二karpathy-原始方法论设计哲学)
3. [三层架构（核心记忆模型）](#三三层架构核心记忆模型)
4. [两步思维链摄入（知识构建管道）](#四两步思维链摄入知识构建管道)
5. [页面合并与增量缓存](#五页面合并与增量缓存)
6. [多阶段检索管道](#六多阶段检索管道)
7. [四信号知识图谱与关联度模型](#七四信号知识图谱与关联度模型)
8. [Louvain 社区检测与图谱洞察](#八louvain-社区检测与图谱洞察)
9. [向量语义搜索与分块策略](#九向量语义搜索与分块策略)
10. [上下文预算控制](#十上下文预算控制)
11. [深度研究与知识自扩展](#十一深度研究与知识自扩展)
12. [审核系统（异步人机协作）](#十二审核系统异步人机协作)
13. [MCP Server 与 Agent Skill](#十三mcp-server-与-agent-skill)
14. [与 GBrain 和 DeepTutor 的对比](#十四与-gbrain-和-deeptutor-的对比)
15. [自测问题](#十五自测问题)

---

## 一、LLM Wiki 是什么

LLM Wiki 是一个**跨平台桌面应用**（Tauri: Rust 后端 + React/TypeScript 前端），能将你的文档自动转化为有组织、相互关联的知识库。

### 核心理念

> **与传统 RAG 不同——RAG 每次查询都从头检索和回答；LLM Wiki 是增量构建并维护一个持久化的 Wiki。知识只编译一次并持续更新，而非每次查询都重新推导。**

这是 Karpathy 的核心洞见：**把 LLM 当作知识编译器，而不是知识检索器。**

### 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri (Rust) |
| 前端 | React + TypeScript + Vite |
| 后端 | Rust (api_server.rs, commands/) |
| 图谱 | sigma.js + graphology + ForceAtlas2 |
| 向量存储 | LanceDB (Rust 后端) |
| Markdown 编辑 | Milkdown |
| Chrome 扩展 | Manifest V3 + Readability.js + Turndown.js |

---

## 二、Karpathy 原始方法论（设计哲学）

LLM Wiki 基于 Andrej Karpathy 的 [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 方法论：

### 核心范式

```
人类策展，LLM 维护

人类：决定什么资料进入知识库
LLM：自动阅读、分析、构建 Wiki、维护交叉引用
```

### 三个核心操作

| 操作 | 说明 |
|------|------|
| **Ingest（摄入）** | LLM 阅读新资料 → 提取实体/概念 → 生成/更新 Wiki 页面 → 维护 index.md 和 log.md |
| **Query（查询）** | LLM 检索相关 Wiki 页面 → 综合回答 → 引用来源 |
| **Lint（检查）** | LLM 审查 Wiki 一致性 → 发现矛盾/遗漏 → 建议修复 |

### 关键设计

- **index.md** 作为内容目录和 LLM 导航入口
- **log.md** 作为时序操作记录（可解析格式）
- **[[wikilink]]** 语法用于交叉引用
- **YAML frontmatter** 存在于每个 Wiki 页面
- **Obsidian 兼容**——Wiki 目录可直接作为 Obsidian 仓库使用

---

## 三、三层架构（核心记忆模型）

这是 LLM Wiki 对 AI 记忆的基础设计——忠实遵循 Karpathy 方法论：

```
┌─────────────────────────────────────────────┐
│  Layer 3: Schema (schema.md + purpose.md)   │  规则层：Wiki 如何运作、为什么存在
│  - schema.md: 结构规则、页面类型、字段定义    │
│  - purpose.md: 目标、关键问题、研究范围       │
├─────────────────────────────────────────────┤
│  Layer 2: Wiki (wiki/ 目录)                 │  知识层：LLM 生成的持久化 Wiki
│  - entities/: 实体页面（人物、组织...）       │
│  - concepts/: 概念页面（理论、框架...）       │
│  - sources/: 资料摘要页面                   │
│  - queries/: 查询归档页面                   │
│  - index.md: 内容目录                       │
│  - overview.md: 全局概要                    │
│  - log.md: 操作日志                         │
├─────────────────────────────────────────────┤
│  Layer 1: Raw Sources (raw/sources/ 目录)   │  原始层：不可变的原始资料
│  - PDF、Office、EPUB、图片、音视频...         │
│  - 只读，永远不修改                           │
└─────────────────────────────────────────────┘
```

### 与传统 RAG 的关键区别

| 维度 | 传统 RAG | LLM Wiki |
|------|---------|---------|
| 知识存储 | 无持久化，每次从头检索 | 持久化 Wiki，增量构建 |
| 编译次数 | 每次查询都重新推导 | 只编译一次，持续更新 |
| 交叉引用 | 无 | [[wikilink]] 自动维护 |
| 结构化 | 无（纯向量块） | 类型化页面 + frontmatter |
| 可读性 | 向量块不可读 | Wiki 页面人类可读可编辑 |
| 审计性 | 无来源追溯 | 每页 `sources: []` 字段 |

### purpose.md——Wiki 的灵魂

这是 LLM Wiki 新增的（Karpathy 原始方法论没有），定义了 Wiki **为什么**存在：
- 目标、关键问题、研究范围
- 演进中的论点
- LLM 在每次摄入和查询时都读取 purpose.md 获取上下文
- 与 schema 不同——schema 是结构规则，purpose 是方向意图

---

## 四、两步思维链摄入（知识构建管道）

这是 LLM Wiki 最核心的 AI 记忆构建机制——对 Karpathy 原始单步摄入的重大改进。

### 两步流程

```
原始资料 (raw/sources/)
  │
  ├─ 第一步：分析（LLM Call 1）
  │   输入：资料内容 + 现有 Wiki (index.md + overview.md + 相关页面)
  │   输出：结构化分析
  │     ├─ 关键实体、概念、论点
  │     ├─ 与现有 Wiki 内容的关联
  │     ├─ 与现有知识的矛盾和张力
  │     └─ Wiki 结构建议
  │
  ├─ 第二步：生成（LLM Call 2）
  │   输入：原始资料 + 第一步的分析结果 + 现有 Wiki
  │   输出：Wiki 文件块（---FILE: path--- 格式）
  │     ├─ 资料摘要页面 (sources/)
  │     ├─ 实体页面 (entities/) + 概念页面 (concepts/)
  │     ├─ 更新 index.md、log.md、overview.md
  │     ├─ 审核项（需人工判断的项）
  │     └─ 深度研究搜索查询
  │
  └─ 写入 Wiki
      ├─ parseFileBlocks() → 解析 ---FILE:--- 块
      ├─ isSafeIngestPath() → 路径安全检查（防目录穿越）
      ├─ mergePageContent() → 与现有页面合并
      └─ 写入 wiki/ 目录
```

### 为什么两步比一步好

| 维度 | 一步摄入 | 两步摄入 |
|------|---------|---------|
| 质量 | LLM 同时读和写，容易遗漏 | 先分析再生成，信息不丢 |
| 关联性 | 只看当前资料 | 主动发现与现有 Wiki 的关联/矛盾 |
| 可控性 | 生成结果不可预测 | 分析步骤可审查、可调优 |
| 上下文利用 | 浅 | 深度利用 index.md + overview.md + 相关页面 |

### LLM 生成的文件格式

LLM 第二步输出用 `---FILE:---` 围栏标记：

```
---FILE: wiki/entities/sarah-chen.md---
---
type: entity
title: Sarah Chen
sources: ["meeting-notes-2026-04-07.pdf"]
tags: [engineering, acme-corp]
---
# Sarah Chen
VP Engineering at Acme Corp...

---FILE: wiki/concepts/graphql-migration.md---
---
type: concept
title: GraphQL Migration
sources: ["meeting-notes-2026-04-07.pdf"]
---
# GraphQL Migration
The ongoing API migration from REST...
```

### 安全解析（`isSafeIngestPath`）

LLM 生成的路径不可信——可能被 prompt injection 攻击。解析时拒绝：
- 不在 `wiki/` 下的路径
- 绝对路径（`/etc/passwd`、`C:\Windows\...`）
- 包含 `..` 的路径穿越
- Windows 非法字符 / 保留设备名
- NUL / 控制字符

---

## 五、页面合并与增量缓存

### SHA256 增量缓存

摄入前检查源文件内容哈希，**未变更则自动跳过**，节省 LLM token 和时间。

```
源文件 → SHA256 哈希 → 与缓存比较 →
  相同 → 跳过（幂等）
  不同 → 执行两步摄入 → 更新缓存
```

### 页面合并（`mergePageContent`）

当多个源文件贡献内容到同一个实体/概念页面时，需要合并而非覆盖。三层保护：

```
┌────────────────────────────────────────────────────┐
│ 第 1 层：Frontmatter 数组字段（sources/tags/related）│
│ → 始终 union 合并，零成本，确定性                   │
├────────────────────────────────────────────────────┤
│ 第 2 层：Body 正文                                  │
│ → 新旧不同时，调用 LLM 生成合并版本                  │
│ → 长度安全检查：合并后 < 70% 原长 → 拒绝（LLM 截断）│
├────────────────────────────────────────────────────┤
│ 第 3 层：锁定字段（type/title/created）              │
│ → 即使 LLM 改写，强制恢复原值                       │
│ → type/title 变化会破坏 wikilink                    │
│ → created 是一次性时间戳                            │
└────────────────────────────────────────────────────┘
```

**Fallback：** LLM 合并失败或安全检查不通过 → 退回数组合并 frontmatter + 新 body（可选备份旧内容）。

### 持久化摄入队列

- 串行处理，防止并发 LLM 调用
- 队列持久化到磁盘，应用重启后自动恢复
- 失败任务自动重试最多 3 次
- 支持取消和重试
- 进度可视化

---

## 六、多阶段检索管道

查询时，LLM 不是直接搜原始资料，而是从已编译的 Wiki 中检索：

```
用户查询
  │
  ├─ 阶段 1：分词搜索
  │   ├─ 英文：分词 + 停用词过滤
  │   ├─ 中文：CJK 二元组分词（每个 → [每个, 个…]）
  │   ├─ 标题匹配加分（+10 分）
  │   └─ 同时搜索 wiki/ 和 raw/sources/
  │
  ├─ 阶段 1.5：向量语义搜索（可选，默认关闭）
  │   ├─ 任意 OpenAI 兼容 /v1/embeddings 端点
  │   ├─ LanceDB (Rust) 快速 ANN 检索
  │   ├─ 余弦相似度
  │   └─ 增强已有匹配 + 添加新发现
  │
  ├─ 阶段 2：图谱扩展
  │   ├─ 搜索结果作为种子节点
  │   ├─ 四信号关联度模型发现相关页面
  │   └─ 2 跳遍历带衰减，发现更深层关联
  │
  ├─ 阶段 3：预算控制
  │   ├─ 可配置上下文窗口：4K → 1M tokens
  │   ├─ 比例分配：50% Wiki + 5% 索引 + ~30% 历史+系统 + 15% 响应
  │   └─ 页面按搜索+图谱关联度综合分数排序
  │
  └─ 阶段 4：上下文组装
      ├─ 编号页面附完整内容（非仅摘要）
      ├─ 系统提示包含：purpose.md、语言规则、引用格式、index.md
      └─ LLM 被指示按编号引用：[1]、[2] 等
```

### 向量搜索基准

- 关闭时：分词 + 图谱，召回率 58.2%
- 开启时：分词 + 向量 + 图谱，召回率 71.4%
- 向量搜索**完全可选**，默认关闭

### CJK 分词

中文分词采用**二元组（bigram）策略**：

```typescript
// "每个概念" → ["每个", "个概", "概念", "每", "个", "概", "念", "每个概念"]
function tokenizeQuery(query: string): string[] {
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff]/.test(token)
    if (hasCJK && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++)
        tokens.push(chars[i] + chars[i + 1])  // 二元组
      for (const ch of chars)
        if (!STOP_WORDS.has(ch)) tokens.push(ch)  // 单字
      tokens.push(token)  // 完整词
    }
  }
}
```

---

## 七、四信号知识图谱与关联度模型

这是 LLM Wiki 的核心图检索机制——四维关联度模型：

### 四个信号

| 信号 | 权重 | 描述 | 计算方式 |
|------|------|------|---------|
| **直接链接** | ×3.0 | 通过 `[[wikilinks]]` 链接的页面 | 正则提取 `[[slug]]`，双向建边 |
| **来源重叠** | ×4.0 | 共享同一原始资料的页面 | frontmatter `sources[]` 交集 |
| **Adamic-Adar** | ×1.5 | 共享共同邻居的页面 | Σ 1/log(degree(共同邻居)) |
| **类型亲和** | ×1.0 | 相同页面类型的加分 | TYPE_AFFINITY 矩阵查表 |

### 类型亲和矩阵

```typescript
const TYPE_AFFINITY = {
  entity:   { concept: 1.2, entity: 0.8, source: 1.0, synthesis: 1.0, query: 0.8 },
  concept:  { entity: 1.2, concept: 0.8, source: 1.0, synthesis: 1.2, query: 1.0 },
  source:   { entity: 1.0, concept: 1.0, source: 0.5, query: 0.8, synthesis: 1.0 },
  query:    { concept: 1.0, entity: 0.8, synthesis: 1.0, source: 0.8, query: 0.5 },
  synthesis:{ concept: 1.2, entity: 1.0, source: 1.0, query: 1.0, synthesis: 0.8 },
}
```

实体↔概念 高亲和(1.2)；同类型内 低亲和(0.5-0.8)——鼓励跨类型发现。

### RetrievalGraph 构建

```typescript
interface RetrievalNode {
  id: string          // slug（无 .md 后缀）
  title: string
  type: string        // entity/concept/source/query/synthesis
  path: string
  sources: string[]   // frontmatter sources[] 字段
  outLinks: Set<string>  // 出链
  inLinks: Set<string>   // 入链
}

interface RetrievalGraph {
  nodes: Map<string, RetrievalNode>
  dataVersion: number    // 缓存版本号
}
```

构建流程：
1. 遍历 `wiki/` 目录所有 `.md` 文件
2. 解析每个文件的 frontmatter（title, type, sources）
3. 提取 `[[wikilinks]]` 建立双向边
4. 缓存（dataVersion 不变则返回缓存）

---

## 八、Louvain 社区检测与图谱洞察

### Louvain 社区检测

基于 **Louvain 算法**（graphology-communities-louvain）自动发现知识聚类：

- **自动聚类**：根据链接拓扑发现哪些页面自然归为一组
- **内聚度评分**：每个社区按内部边密度评分（实际边数 / 可能边数）
- **低内聚警告**：cohesion < 0.15 的社区标警告
- **大图优化**：>3000 节点时使用 Web Worker 并行计算
- **缓存**：最多缓存 2 个项目的图

### 图谱洞察

系统自动分析图谱结构，呈现两种可操作的洞察：

**惊奇连接（Surprising Connections）：**

| 信号 | 加分 | 说明 |
|------|------|------|
| 跨社区边 | +3 | 连接不同知识集群 |
| 跨类型边 | +2 | 实体↔概念等跨类型链接 |
| 边缘↔核心 | +1 | 低度数节点连接高度数枢纽 |

复合惊奇度排序，可消除（标记已查看后不再出现）。

**知识空白（Knowledge Gaps）：**

| 类型 | 检测条件 | 建议 |
|------|---------|------|
| 孤立页面 | 度 ≤ 1 | 缺少与 Wiki 的连接 |
| 稀疏社区 | cohesion < 0.15 且 ≥ 3 页 | 内部交叉引用薄弱 |
| 桥接节点 | 连接 3+ 个集群 | 维系多个领域的关键枢纽 |

知识空白和桥接节点附带 **Deep Research 按钮**，一键触发网络搜索补充知识。

---

## 九、向量语义搜索与分块策略

### 向量搜索管道

```
Wiki 页面
  │
  ├─ 1. chunkMarkdown(content)     → Markdown 感知分块
  ├─ 2. fetchEmbedding(heading_path + chunk_text)  → 嵌入
  │     └─ auto-halve retry（超长时自动减半重试）
  ├─ 3. vector_upsert_chunks()     → LanceDB 写入
  │
  └─ 搜索时：
      ├─ fetchEmbedding(query)     → 查询嵌入
      ├─ vector_search_chunks()    → ANN 检索 (topK × 3)
      └─ 按 page_id 分组 → max-pool 主分 + 加权尾和
```

### Markdown 感知递归分块器

**6 级分隔符优先级**（Langchain-style Recursive Character Text Splitter）：

```
(a) 标题定义的章节 (## / ### / ####)
(b) 段落边界 (\n\n)
(c) 换行 (\n)
(d) 句子终止符 (. ! ? 。！？ ; ；)
(e) 空格 ( 　\t)
(f) 硬字符切片（最后手段）
```

**关键设计约束：**

1. **headingPath 面包屑**：每个块携带 `"## Intro > ### Usage"` 路径，嵌入时包含结构上下文
2. **不拆分代码围栏**：fenced code block 超过 maxChars 保持完整，不撕裂
3. **不拆分表格**：表格行保持完整
4. **YAML frontmatter 剥离**：元数据不污染嵌入
5. **块间重叠**：同节内相邻块有重叠，防概念截断
6. **小块合并**：< minChars 的块贪心合并到相邻块
7. **纯确定论**：相同输入→相同输出

### 嵌入错误处理

```typescript
// 自动识别"输入过长"错误
function looksLikeOversizeError(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true
  // 匹配 "too long", "max_tokens", "context length", "exceeds" 等
}
```

超长时自动减半重试，保证不因单个长块失败而中断整个嵌入流程。

---

## 十、上下文预算控制

查询时 LLM 的上下文窗口需要精细分配：

```
┌─────────────────────────────────────────────────┐
│              maxCtx (100%)                      │
├──────┬───────────────┬──────────────┬───────────┤
│ idx  │   pages       │ history+sys  │  resp     │
│  5%  │    50%        │   ~30%       │   15%     │
└──────┴───────────────┴──────────────┴───────────┘
```

| 区域 | 占比 | 说明 |
|------|------|------|
| **indexBudget** | 5% | index.md 摘要，列出每个页面标题 |
| **pageBudget** | 50% | 检索到的 Wiki 页面内容 |
| **history+system** | ~30% | 聊天历史 + 系统提示 |
| **responseReserve** | 15% | 留给 LLM 回答的空间 |

**Per-page 截断上限：** 单个页面不超过 `pageBudget × 30%`（最低 5000 字符），防止一个长页面占满预算。

**默认窗口：** 204,800 字符（~200K），可配置 4K → 1M。

---

## 十一、深度研究与知识自扩展

当 LLM 识别出知识空白时，可以主动扩展 Wiki：

```
知识空白 / 用户请求
  │
  ├─ 1. LLM 生成研究主题
  │   └─ 读取 overview.md + purpose.md → 领域精准主题
  │
  ├─ 2. 用户确认（可编辑主题和查询）
  │
  ├─ 3. 多条搜索查询 → 网络搜索
  │   ├─ Tavily (API Key)
  │   ├─ SerpApi (API Key, 可选搜索引擎)
  │   └─ SearXNG (实例 URL, 自托管)
  │
  ├─ 4. LLM 综合搜索结果
  │   └─ 生成 Wiki 研究页面 (type: query, origin: deep-research)
  │
  └─ 5. 自动摄入
      └─ 研究结果进入两步摄入流程 → 提取实体/概念 → 更新 Wiki
```

**关键设计：** 深度研究的结果**不是一次性消费**，而是**持久化到 Wiki** 中，成为知识网络的一部分，后续查询可以直接利用。

---

## 十二、审核系统（异步人机协作）

LLM 在摄入过程中可能标记需要人工判断的项目：

```
LLM 摄入
  │
  ├─ 高置信度内容 → 自动写入 Wiki
  │
  └─ 需人工判断 → 进入审核队列
      ├─ 预定义操作类型：创建页面 / 深度研究 / 跳过
      ├─ 预生成搜索查询（LLM 为每个审核项生成优化查询）
      └─ 用户方便时处理 → 不阻塞摄入流程
```

**为什么是异步？** 摄入可能处理大量文件，要求用户每次都确认会严重阻塞。异步审核让摄入持续进行，用户可以在方便时批量处理审核项。

---

## 十三、MCP Server 与 Agent Skill

### MCP Server

随包提供的 MCP Server，暴露以下工具给外部 Agent：

- **Hybrid 检索**：分词 + 向量 + 图谱混合搜索
- **文件读取**：读取 Wiki 页面和原始资料
- **知识图谱遍历**：浏览实体关系
- **源资料重新扫描**：触发增量摄入

### Agent Skill

配套 [agent skill](https://github.com/nashsu/llm_wiki_skill)，一行命令接入 Claude Code / Codex：

```bash
npx skills add ...
```

### Rust 后端 Chat Agent

聊天由 Rust 后端 Agent runtime 驱动：
- **工具型 Agent**：自主选择 Wiki/Source/Graph/Web 检索、workspace 文件工具、shell 命令
- **Skill 管理**：扫描 + 启用/禁用 Skill，`/skill` 补全选择
- **生成物管理**：Agent 生成的文件放在 `agent-workspace/` 下
- **安全模型**：项目内命令顺畅执行，外部 shell 命令需明确批准

---

## 十四、与 GBrain 和 DeepTutor 的对比

### 三系统架构对比

| 维度 | DeepTutor | GBrain | LLM Wiki |
|------|-----------|--------|---------|
| **定位** | 教学系统 | 个人知识大脑 | 个人知识库 |
| **记忆分层** | L1→L2→L3 | Timeline+CompiledTruth | Raw→Wiki→Schema |
| **真相源** | JSONL+Markdown | Git 中的 Markdown | 文件系统中的 Markdown |
| **派生存储** | meta.json | Postgres/PGLite DB | LanceDB (向量) |
| **知识构建** | LLM 驱动管道 | 手动+Agent 写入 | **LLM 两步摄入** |
| **搜索** | 向量为主 | 4策略混合(P@5=49.1) | 分词+向量+图谱(3阶段) |
| **图谱** | 无 | 4信号+图遍历 | 4信号+Louvain+洞察 |
| **实体链接** | LLM+footnote | 零LLM正则 | LLM 生成 wikilink |
| **隐私** | 无 | 3层剥离 | 无显式隐私层 |
| **可审计性** | L3→L2→L1 | Truth→Timeline→Source | Wiki→frontmatter sources[] |
| **更新语义** | Add/Edit/Delete | APPEND+REWRITE | LLM 合并+锁定字段 |
| **增量** | seen-ID | content_hash | SHA256 缓存 |
| **语言** | Python | TypeScript | TypeScript+Rust |
| **部署** | 嵌入式库 | CLI+MCP+DB | 桌面应用(Tauri) |

### 记忆模型映射

```
DeepTutor           GBrain                LLM Wiki
──────────          ──────                ────────
L1 (JSONL 原始事件) ≈ Timeline (追加)     ≈ Raw Sources (不可变)
L2 (Markdown per-   ← 无精确对应          ≈ Wiki pages (per-entity
 surface facts)                            摘要，但混合了综合)
L3 (Markdown cross- ≈ Compiled Truth      ≈ Wiki pages (实体/概念
 surface synthesis)  (重写)                页面本身)
Schema (规则)       ← 无                  ≈ schema.md + purpose.md
```

### 核心差异深入

#### 1. 知识构建方式

| 系统 | 方式 | 特点 |
|------|------|------|
| **DeepTutor** | 自动管道：L1→L2→L3 | 完全自动，9步管道，LLM 在每步做提取/综合 |
| **GBrain** | Agent 驱动：Agent 调用 gbrain put | 人类策展为主，Agent 辅助，写入是显式操作 |
| **LLM Wiki** | LLM 驱动：两步摄入 | **LLM 自主阅读→分析→生成**，人类只做异步审核 |

LLM Wiki 最激进——LLM 直接生成所有 Wiki 内容，人类只在审核队列中做最终判断。GBrain 最保守——要求显式写入操作。DeepTutor 介于中间——管道自动运行但每步有验证。

#### 2. 页面更新语义

| 系统 | 新信息到达时 |
|------|------------|
| **DeepTutor** | AddOp 追加 / EditOp 修改 / DeleteOp 删除——原子操作 |
| **GBrain** | Timeline APPEND + Compiled Truth **整体 REWRITE** |
| **LLM Wiki** | **LLM 合并**——读旧+新，LLM 生成合并版，3层保护防数据丢失 |

LLM Wiki 的合并最复杂但也最灵活——LLM 可以做真正的语义合并（去重、综合、重排），而不仅仅是追加或重写。

#### 3. 图谱能力

| 系统 | 图构建 | 图利用 |
|------|--------|--------|
| **DeepTutor** | 无 | 无 |
| **GBrain** | 零LLM正则提取 + 启发式关系推断 | BFS遍历 + RRF融合 + rerank |
| **LLM Wiki** | LLM生成wikilink + sources重叠 | 2跳衰减 + 4信号关联度 + Louvain社区 + 洞察 |

LLM Wiki 的图分析最强（社区检测+洞察），GBrain 的图检索最强（BFS+RRF+rerank，P@5=49.1）。

#### 4. "知识编译" vs "知识检索"

| 系统 | 范式 | 说明 |
|------|------|------|
| **DeepTutor** | **编译** | L1→L2→L3 是显式的知识编译管道 |
| **GBrain** | **编译+检索** | put_page 编译，search 检索编译结果 |
| **LLM Wiki** | **编译** | 摄入=编译，查询=读编译结果（这正是 Karpathy 的核心洞见） |

三者都认同 Karpathy 的理念：**知识应该编译一次，而非每次查询都重新推导。**

### LLM Wiki 对我们项目的参考价值

| 特性 | 参考价值 | 理由 |
|------|---------|------|
| ✅ 两步思维链摄入 | **高** | 先分析再生成，P1 的 LLM 调用可以采用这个模式 |
| ✅ SHA256 增量缓存 | **高** | 简单有效，vscode-pylearner 也需要幂等摄入 |
| ✅ 页面合并3层保护 | **高** | LLM 合并+长度检查+锁定字段，防数据丢失 |
| ✅ 上下文预算分配 | **高** | 50%页面+5%索引+30%历史+15%响应的比例可借鉴 |
| ✅ CJK 二元组分词 | **中** | 中文查询场景可能需要 |
| ✅ 图谱洞察 | **中** | 惊奇连接+知识空白对学习者画像有意义 |
| ✅ purpose.md | **中** | 定义 Wiki 为什么存在——教学系统也需要"教学目标" |
| ⚠️ 四信号关联度 | **低** | 学习者画像的关系不如知识库密集 |
| ⚠️ Louvain 社区 | **低** | 学习面分类是预定义的，不需要自动聚类 |
| ⚠️ MCP Server | **低** | vscode-pylearner 用 VS Code 扩展 API，不需要 MCP |

### 三个系统各有的独到之处

| 系统 | 独到之处 |
|------|---------|
| **DeepTutor** | **学习者画像**——不是通用知识库，而是围绕"学习者掌握度"构建的个性化模型 |
| **GBrain** | **Facts 围栏**——结构化事实存储(claim/kind/confidence/visibility)，比自然语言更精确；**隐私3层剥离** |
| **LLM Wiki** | **LLM 自主知识构建**——两步摄入让 LLM 真正"理解"资料而非只做向量切片；**图谱洞察**——惊奇连接和知识空白检测 |

---

## 十五、自测问题

### Q1: LLM Wiki 与传统 RAG 的核心区别是什么？

**答：** 传统 RAG 每次查询都从头检索原始资料并重新推导答案；LLM Wiki 是**增量构建并维护持久化 Wiki**——知识只编译一次并持续更新。这就像解释型语言 vs 编译型语言的区别：RAG 是"解释执行"（每次从头），LLM Wiki 是"编译执行"（编译一次，多次使用）。

### Q2: 两步思维链摄入的具体流程是什么？为什么比一步好？

**答：**
- **第一步（分析）**：LLM 阅读资料+现有Wiki → 输出关键实体/概念/关联/矛盾/结构建议
- **第二步（生成）**：LLM 基于分析结果+资料+现有Wiki → 输出Wiki文件块

一步摄入时 LLM 同时读和写，容易遗漏信息、忽略与现有Wiki的关联。两步摄入让LLM先充分理解再生成，质量显著提升。

### Q3: 页面合并的三层保护分别是什么？

**答：**
1. **Frontmatter 数组字段**（sources/tags/related）→ 始终 union 合并，确定性，零成本
2. **Body 正文**→ 新旧不同时调用 LLM 合并，合并后长度 < 70% 原长则拒绝（防截断）
3. **锁定字段**（type/title/created）→ 即使 LLM 改写也强制恢复原值（type/title 变化破坏 wikilink）

### Q4: 四信号关联度模型的四个信号和权重分别是什么？

**答：**
| 信号 | 权重 |
|------|------|
| 直接链接（[[wikilinks]]） | ×3.0 |
| 来源重叠（frontmatter sources[] 交集） | ×4.0 |
| Adamic-Adar（共享共同邻居，按度数加权） | ×1.5 |
| 类型亲和（TYPE_AFFINITY 矩阵查表） | ×1.0 |

来源重叠权重最高(4.0)——共享同一原始资料的页面有最强的关联度。

### Q5: 上下文预算的比例分配是怎样的？为什么这样分？

**答：**
- index 5%：只列标题，占用少但给 LLM 全局视图
- pages 50%：检索到的 Wiki 页面是回答的主体内容，占大头
- history+system ~30%：聊天历史+系统提示（含 purpose.md、语言规则、引用格式）
- response 15%：留给 LLM 回答的空间

单页面不超过 pageBudget×30%（最低5000字符），防止一个长页面占满预算。

### Q6: LLM Wiki 的图洞察有哪两种？分别检测什么？

**答：**
1. **惊奇连接**：跨社区边(+3)、跨类型边(+2)、边缘↔核心(+1)——发现意外关联
2. **知识空白**：孤立页面(度≤1)、稀疏社区(cohesion<0.15)、桥接节点(连接3+集群)——发现知识缺陷

两种洞察都可操作——点击高亮图谱，知识空白可触发 Deep Research。

### Q7: Markdown 分块器有哪6级分隔符优先级？有哪些"不拆分"规则？

**答：** 6级：(a)标题章节 (b)段落 (c)行 (d)句子 (e)空格 (f)字符切片。每级只在前一级产生的块仍超长时才启用。

不拆分规则：
- 不拆分 fenced code block（保持完整，宁可超大块）
- 不拆分表格（保持行完整）
- YAML frontmatter 剥离（不嵌入元数据）

### Q8: `isSafeIngestPath` 防御什么攻击？如何防御？

**答：** 防御 **prompt injection 导致的路径穿越攻击**。攻击者在源文档中注入 `---FILE: ../../../etc/passwd---`，LLM 可能生成这个路径，写入系统文件。

防御规则：
- 必须在 `wiki/` 下
- 无 `..` 段段
- 无绝对路径
- 无 Windows 非法字符/保留名
- 无控制字符

### Q9: purpose.md 和 schema.md 的区别是什么？为什么需要 purpose.md？

**答：**
- **schema.md**：定义 Wiki **如何**运作——结构规则、页面类型、字段定义
- **purpose.md**：定义 Wiki **为什么**存在——目标、关键问题、研究范围、演进论点

需要 purpose.md 因为：没有它，LLM 不知道应该优先关注什么、什么信息重要、知识库的方向。它给 LLM 提供语义上下文，而不仅仅是结构规则。

### Q10: 对 vscode-pylearner 项目，LLM Wiki 最值得借鉴的三个设计是什么？

**答：**
1. **两步思维链摄入**：vscode-pylearner 的 P1 也需要 LLM 分析学习事件→生成/更新学习者画像。先分析再生成比一步到位质量高得多。
2. **SHA256 增量缓存 + 页面合并 3 层保护**：学习事件可能重复触发画像更新，需要幂等性保证和数据丢失防护。
3. **上下文预算分配**：P1 的 LLM 调用也需要精细分配上下文窗口（多少给历史事件、多少给现有画像、多少给 LLM 回答），50%页面+5%索引+30%历史+15%响应的比例是一个好的起点。

---

*本文档基于 LLM Wiki 源码精读生成。关键源文件：*
- `src/lib/ingest.ts` — 摄入管道（核心，~800+ 行）
- `src/lib/search.ts` — 搜索管道
- `src/lib/graph-relevance.ts` — 四信号关联度模型
- `src/lib/wiki-graph.ts` — 知识图谱构建与 Louvain 社区检测
- `src/lib/graph-insights.ts` — 图谱洞察（惊奇连接+知识空白）
- `src/lib/embedding.ts` — 向量嵌入管道
- `src/lib/text-chunker.ts` — Markdown 感知递归分块器
- `src/lib/context-budget.ts` — 上下文预算控制
- `src/lib/page-merge.ts` — 页面合并 3 层保护
- `src/lib/deep-research.ts` — 深度研究
- `src/lib/llm-client.ts` — LLM 客户端（流式、多 provider）
- `src-tauri/src/api_server.rs` — Rust 后端 API 服务器（120K 行）
- `src-tauri/src/commands/` — Rust 命令集（search, vectorstore, project, fs 等）
- `mcp-server/` — MCP Server
