# Behavior Surface:打字行为分析 → 掌握度画像 — 设计文档(修订版)

> 目标终态:画像能明确回答"这个学生**哪些基本掌握、哪些还较为薄弱**"。
> 手段:新增 `behavior` L1 surface,在本地提取打字行为特征(节奏/删改/错误复发),
> 由现有 L1→L2→L3 管道把它综合成带 `knowledge_strength` 的掌握度断言,
> 由老师总评(profile overview)呈现为阶段性评语。

日期:2026-09-12(修订自 2026-09-09 版)
前置:2026-07-23-vscode-python-learner-profile-design.md(P0-P3 已实现);
2026-09-11-mastery-profile-fix-design.md(已实现);2026-09-11-profile-overview-design.md(已实现)

### 修订说明(2026-09-12,相对 9-09 版)

审查发现 9-09 版是一份"过时快照",本版修正三处与现状冲突的内容:

1. **删除规则版 `renderMasteryMap` 两档总览**。9-11 轮实现的 LLM 老师总评
   (`pickProfileView`)已优先接管 Profile 面板与聊天注入的显示,renderDisplay
   只是无总评时的兜底——规则版总览做完也几乎不可见。改为:behavior 事实汇入
   profile.md 后,由总评每次重写时自然呈现掌握/薄弱判断。
2. **废除已失效的"Across N behavior interactions" guard 论断**。9-11 轮的
   NO PREAMBLE TEMPLATE 规则已禁止该句式,防过度概括改由 SURFACE_FOCUS 中
   的多证据硬规则承担(见 §七)。
3. **k=5 语义对齐**:现行 L3 prompt 定义 5 = "No evidence / unaware"(无法
   评估时也用 5),不再是"最严重"。behavior 条目证据单薄,最容易落 5——
   总评 prompt 与底层语义均已明确"无证据不是薄弱",spec 不再引入 1-2/3-5
   的规则分桶,掌握度分档完全交给总评的 🟢🟡🔴 三档判断。

---

## 一、背景与目标

### 问题

现有 `edit` 表面在采集时过滤了单字符变更([editListener.ts:63-74]),打字节奏信息
(写了又删、停顿、重写)被当作噪音丢弃。但"学生在哪个知识点上卡壳"恰恰藏在这些
信号里。同时,系统无法区分:

- **打字慢/手滑**:插入后几秒内删掉重打,错误随机分布,最终代码正确 —— 不是知识问题
- **概念没掌握**:停顿和重写集中在特定语法结构(如 `for` 行),同类语法错误反复出现 —— 是知识问题

### 终态交付

1. 新 `behavior` surface 的 L1 特征事件、L2 行为摘要(`Typing fluency` / `Concept struggles` / `Edit habits` 三节)。
2. L3 profile.md 的知识级断言获得新证据源(行为证据 + 既有 chat/diag/run 证据),自动带 `knowledge_strength` 1-5。
3. 掌握/薄弱的**呈现由老师总评完成**:behavior 事实并入 profile.md 后,
   synthesizeOverview 每次整篇重写,总评叙述 + 维度表(🟢已掌握/🟡一般/🔴存在误区)
   自然吸收新证据源,Profile 面板与聊天注入共用,零新增渲染层。

### 用户决策记录

- 产品形态:**只要批量画像增强**,不做打字中的实时提醒。
- 优先级:本功能排在 remaining-work 清单(评测→audit→REWRITE)之前。
- **不加隐私/开关设置**(用户明确拒绝):behavior 采集随监听器常开,不新增 config key。
- 掌握度总览**不另做规则版渲染**(2026-09-12 修订):原 9-09 设计的两档
  `renderMasteryMap` 已被 9-11 老师总评取代,不再实现。

## 二、非目标(YAGNI)

- 实时干预/提醒通路(诊断与错误事件继续只写 trace)。
- 光标轨迹、选区变化、焦点时长追踪。
- 原始击键持久化(见 §十 开放问题)。
- 规则版掌握度总览渲染(已被 LLM 老师总评取代,见修订说明)。
- 启用 scope.md L3 槽位(见 remaining-work 9.6)。
- chat 代码上下文注入(独立问题,另立 spec)。

## 三、方案选择

| 方案 | 结论 |
|------|------|
| **A. 本地特征提取 + LLM 判断(采纳)** | 扩展端按会话本地算好统计特征,1 会话=1 条紧凑 L1 事件;LLM 在 L2 提取时结合特征+代码片段做"卡壳 vs 打字"归因。体量小、证据链可审计、复用现有管道。 |
| B. 原始击键流全存,LLM 直读 | LLM 无法可靠计算时序统计(间隔中位数、复发次数),数字会错;体量大;facts 证据链弱。否决。 |
| C. 纯本地阈值规则直接判定 | 阈值因人而异;"跨会话同类错误反复"本来就需要 LLM 跨事件综合;产出不了画像语言。否决。 |

## 四、架构与数据流

```
学生打字(.py 文件)
  │  behaviorListener:逐变更记录(不防抖,内存缓冲,带 Date.now())
  │  + 同文件诊断快照(onDidChangeDiagnostics)
  ▼  会话边界:切编辑器 / 关闭编辑器 / 空闲≥5min / 会话≥90min / 扩展停用
  behaviorFeatures.ts(纯函数):变更日志+诊断快照+文本镜像 → 特征 payload
  ▼
  l1Writer:trace/behavior/YYYY-MM-DD.jsonl,1 会话 = 1 条 typing_session 事件
  ▼
  现有 updateL2(新增 SURFACE_FOCUS.behavior)→ behavior.md 三节
  ▼
  现有 updateL3(零改动)→ profile.md 知识级断言 + knowledge_strength
  ▼
  现有 synthesizeOverview(零改动)→ 老师总评呈现掌握/薄弱
```

复用面:chunker/document/ops/guards/dedup/merge/retry/injector/overview 全部不动;
`SURFACES` 数组加一项后,updateL2 的并发迭代、snapshot reader 的目录扫描自动覆盖新表面(实现时验证)。

## 五、会话定义与采集

### 会话

- 只跟踪 `.py` 文档(与 editListener 的过滤一致),多文件并行各自成会话。
- 每次命中该文件的 `onDidChangeTextDocument`,记录 `{t, startLine, ins, del}`
  (只记字符数,逐变更文本不存——特征不消费它,`final_text` 取自文本镜像);
  诊断变化记录 `{t, errors: [{msg(截 100 字符)}]}`。
- 维护每文件文本镜像(照 editListener 的 open/close 模式),提取 `final_text` 用,不要求文档仍打开。
- **边界**:`onDidChangeActiveTextEditor` 切走 / `onDidCloseTextDocument` 关闭 /
  空闲≥5min(定时器,每次变更重置)/ 会话时长≥90min / `deactivate`。触发后提取→写 L1→清空缓冲。空闲触发的会话在 payload 里记 `ended_by: "idle"`,末次变更到提取的间隔即"最大停顿",不丢信号。
- 窗口强杀丢内存缓冲:可接受,不做持久化缓冲。

### 边界设计细节

- 防抖:刻意**不加**。editListener 的 500ms 防抖是为 L2 提炼服务的,与本目标相反;
  behavior 只在内存缓冲,写盘频率仍是 1 会话 1 事件,无 IO 压力。
- 单会话变更数上限(如 5000):超出后丢弃后续记录并在 payload 标记 `truncated: true`,防御异常写入源(格式化工具全文件重写等)。
- **频繁切换抖动**:同文件在会话结束后 3 分钟(代码常量)内重新激活,
  且无其他文件的会话插入其间 → 视为续会话(沿用原缓冲与起止时间),避免
  "对照抄代码在两文件间来回切"把会话剁碎。2026-09-12 用户确认采纳续会话方案。

## 六、特征 payload schema(kind: `typing_session`)

```jsonc
{
  "id": "behavior:<ULID>", "ts": "...", "surface": "behavior", "kind": "typing_session",
  "payload": {
    "file": "main.py",
    "duration_ms": 1230000,
    "ended_by": "editor_switch | editor_close | idle | max_duration | deactivate",
    "truncated": false,
    "typing": {
      "changes": 420, "insert_chars": 1800, "delete_chars": 640,
      "gap_median_ms": 850, "gap_p90_ms": 5000,
      "hesitations_5s": 12, "max_gap_ms": 230000
    },
    "paste_like_inserts": 3,          // 单事件插入 ≥5 字符
    "hot_regions": [                  // 按 insert+delete 排序的 top-3(3 行一桶)
      {
        "lines": "12-14",
        "final_text": "for i in range(10)\n    print(i)",   // ≤200 字符,取自文本镜像
        "touches": 31, "insert_chars": 400, "delete_chars": 210,
        "constructs": ["for"]
      }
    ],
    "diagnostics": {                  // 会话内同文件诊断快照聚合
      "errors_seen": [
        { "msg": "expected ':'", "first_rel_ms": 120000,
          "fixed": true, "latency_ms": 45000, "recurred": 3 }
      ],
      "unresolved": 0                 // 会话结束时仍存在的错误数
    }
  }
}
```

### 多行 final_text 的存储约定

`final_text` 中的换行在写入 JSONL 前统一转义为 `\n`(JSON 字符串本就如此,
无逐行冲突);L2 渲染时由 contentOf 把 `\n` 还原为实际换行、缩进两格挂在
hot_region 之下,保证 chunker 的段落边界切分仍按整条事件处理,不拦腰截断。

### 知识点映射(constructs)

本地正则打标签,12 类:`for` / `while` / `def` / `class` / `if-elif` / `import` /
`try-except` / `dict` / `list comprehension` / `slicing` / `f-string` / `lambda`。
多标签允许。更细的归类交给 LLM 凭 `final_text` 在 L2 阶段做。

### 错误消息规范化(recurred 匹配规则)

诊断消息先做规范化再匹配复发:`msg.strip()`,去掉尾部 ` (file.py, line N)`
类位置信息与行号(正则剥离 `(?:\(|, )?.*?\.py.*?\)` 与 `line \d+`),再去首尾
空白、统一小写后按全等聚合计数。同消息不同行号视为同一错误复发;
规范化后为空的消息不计。

## 七、L2/L3 集成

### SURFACE_FOCUS.behavior(settings.ts)

```ts
behavior: {
  focus: "Typing fluency vs conceptual struggle. Judge by these criteria: "
       + "(1) Concept struggle: touches concentrate on one construct, the same "
       + "syntax error recurs (recurred>=2) or pauses/rewrites cluster on it. "
       + "(2) Typing fluency: deletions corrected within seconds, errors scattered "
       + "across constructs, no unresolved errors at end — NOT a knowledge gap. "
       + "(3) Paste reliance: paste_like_inserts dominate insert_chars; "
       + "long IME comment inserts are NOT paste evidence. "
       + "Never claim struggle from a single short session alone: hesitation in "
       + "one session is weak evidence — only report struggle when the same "
       + "construct shows it across 2+ sessions or alongside corroborating "
       + "chat/diag/run evidence.",
  sections: ["Typing fluency", "Concept struggles", "Edit habits"],
},
```

判据规则是**给 LLM 的硬性规则**,不是代码阈值;数值特征让 LLM 有据可判。
其中"跨 2+ 会话或与其它表面证据互证才报 struggle"一条,取代 9-09 版已失效的
"Across N behavior interactions" 句式 guard,承担防单会话过度概括的职责。
IME 注释噪音的处理(§八)同步写进了 focus 文本——focus 是 LLM 唯一能看到的地方。
既有 guards(禁绝对化)、refs 强制、dedup/merge 照常生效。

### 掌握度呈现:老师总评,零新增渲染(2026-09-12 修订)

- **不再实现** 9-09 版规划的 `renderMasteryMap` 规则总览——`pickProfileView`
  优先显示 LLM 老师总评,规则总览日常不可见。
- behavior 事实经 updateL3 汇入 profile.md 后,synthesizeOverview 每次整篇重写,
  在总评叙述与维度表中自然给出 🟢/🟡/🔴 的当下综合判断——新旧证据的时间线
  (曾卡壳→已改善)由 LLM 在总评里消化,与既有行为一致。
- L3 管道零改动;k=5("No evidence")不是薄弱档,总评 prompt 已含三档硬约束。

## 八、边界情况

| 情况 | 处理 |
|------|------|
| 自动补全括号/缩进(`(`→`()`、自动缩进) | ≤4 字符插入按"打字辅助"计,不算 paste_like |
| IME 中文注释长插入 | 会冒充粘贴,接受噪音;§七 focus 已注明注释类长插入不算 paste 证据 |
| undo/撤销 | 计入 churn(本来就是重写) |
| 查找替换/格式化 | rare 噪音;truncated 标记兜底;dedup 在 L2 层兜底 |
| 空会话(<3 次变更) | 不写事件,直接丢弃 |
| 非 .py 文件 | 不跟踪 |
| k=5(无证据)条目 | 不视为薄弱;总评三档判断自然排除 |

## 九、配置

**不新增任何设置**(用户决策)。behavior 监听器与其它监听器一同常开,
`extension.ts` 统一注册与 dispose,无独立开关。

## 十、实现落点

| 文件 | 改动 |
|------|------|
| `src/constants.ts` | `SURFACES` 加 `"behavior"`;`EVENT_KINDS` 加 `typingSession` |
| `src/events/types.ts` | `TraceEvent.kind` 联合类型加 `typing_session`(类型层必须,否则编译不过) |
| `src/events/behaviorListener.ts` | **新增**:会话缓冲、边界定时器、诊断快照、文本镜像、续会话窗口、dispose |
| `src/events/behaviorFeatures.ts` | **新增**:纯函数特征提取(变更日志+诊断快照+镜像文本 → payload,含错误消息规范化) |
| `src/extension.ts` | 注册 behaviorListener |
| `src/memory/settings.ts` | `SURFACE_FOCUS.behavior`(TS 会因 Record<Surface,…> 强制要求) |
| `src/memory/document.ts` | 预计零改动(总评已接管掌握度呈现) |
| `src/commands/updateProfile.ts` | 预计零改动(SURFACES 迭代自动覆盖);实现时验证 |
| `src/test/` | 见 §十一 |

## 十一、测试与验收

单测(vitest,沿用现有模式):

1. `behaviorFeatures.test.ts`:手造三种变更日志 → 特征数字正确
   - "打字快但乱错":删除后短间隔重打、错误分散 → hesitations 低、paste_like≈0、errors 无复发
   - "for 循环卡壳":同区域高 touches、`expected ':'` 复发 3 次(不同行号)、末段未解决 → 对应字段正确
   - "粘贴为主":长插入占比高、gap 稀疏 → paste_like_inserts 高
   - "IME 长插入":计入 paste_like(阈值初值 5 字符),不崩溃
   - 错误消息规范化:同一错误不同行号/路径 → recurred 正确聚合
   - 多行 final_text:换行转义/还原正确
2. `behaviorListener.test.ts`:mock vscode 事件,验证边界触发提取、L1 写入、
   3min 内重开续会话、dispose 清理
3. `document.test.ts`:确认 renderDisplay/pickProfileView 无需改动即兼容(回归)

验收(手动):

- 3 个脚本化场景(模拟学生真实敲击)跑完管道 → `behavior.md` 的 facts 归因正确
  (卡壳归卡壳、手滑归手滑),L3 出现带 knowledge_strength 的行为证据断言
- 老师总评的维度表反映行为证据带来的掌握/薄弱变化
- 跑一次 `scripts/eval-profile.ts` 确认注入效果无回归

## 十二、开放问题(不阻塞实现)

1. **原始击键不持久化**:特征算错或未来想加特征时,旧数据无法重算。先接受;
   确有需要再加 raw surface(短保留期)。
2. **paste 阈值 5 字符 / 空闲 5min / 会话 90min / 续会话窗口 3min**:初值,不做设置项,代码常量,后续按实际数据调。
3. **光标停顿 vs 打字停顿**:无法区分"盯着看"和"想别的去了",一视同仁计为 hesitation。
4. **k=5 语义统一**:当前 L3 prompt 把 5 用作"No evidence / unaware"且"无法
   评估时用 5",与文档渲染层"⚠️ 最严重"存在语义张力。behavior 条目最易触发。
   2026-09-12 用户确认:接受现状,在 L2 focus 明确"无证据≠薄弱",总评三档
   自然排除无证据条目;底层语义统一归 mastery-fix 轮的 deferred 项跟踪,
   不阻塞本功能。
