# 掌握度画像修复:让画像按知识点分节并带掌握度标注 — 设计文档

> 目标终态:插件像老师一样说出该学生的学习情况——**哪些知识点基本掌握、哪些还比较薄弱**,
> 且以具体知识点(循环控制、函数定义、列表操作…)分节展示。
> 手段:修复管道中丢失"知识点分节"与"掌握度标注"的三处 bug,再全量重建 L2/L3。

日期:2026-09-11
前置:2026-09-09-behavior-surface-design.md(behavior surface 本轮**不**实现,下一轮做)
现状证据:`l3/profile.md` 已存在但全部条目堆在 Identity 节、零 `k=` 标注、第二批条目未翻译。

---

## 一、背景与诊断

管道(L1→L2→L3)已经跑通且磁盘有数据(trace 66K、L2 全、L3 profile.md 存在),
但用户看到的画像是空的/无掌握度信息。根因是三处 bug 叠加:

| # | 根因 | 位置 | 后果 |
|---|------|------|------|
| 1 | **prompt 与代码打架**:L3 prompt 要求 LLM 用具体主题 section(prompts.ts:120-128 的 DYNAMIC SECTIONS 规则),但 `appendFactsToDoc` 把不在白名单里的 section 全部降级到 fallback | update.ts:337 | 所有条目被压进 **Identity** |
| 2 | **Identity 被刻意隐藏**:`renderDisplay` 把 Identity 视为 PII 跳过不渲染 | document.ts:382 | 面板只剩标题,看起来像"没生成画像" |
| 3 | **knowledge_strength 两处断链**:① `updateL3` 的 `kept.push({text, refs, section})` 在 parseFacts 解析出 `fact.knowledge_strength` 后丢弃它(update.ts:294,L2 同构位置 update.ts:164);② `ops.apply()` 的 add 分支建 Entry 时只带 `{id, section, text, refs}`,丢掉 `AddOp.knowledge_strength`(ops.ts:143-148) | update.ts:164/294, ops.ts:143-148 | 磁盘上零个 `k=` 标注 → 掌握度标签永不出现 |

证据链现状(`✓` 已通 / `✗` 断点):

```
LLM 输出 k= ✓ → parseFacts ✓ (parse.ts:79-81) → kept.push ✗ (update.ts:164/294)
→ AddOp ✓ (update.ts:340) → apply ✗ (ops.ts:143-148) → Entry
→ serialize ✓ (document.ts:252-253 写 k=) → parse 回读 ✓ (document.ts:197-200)
→ renderDisplay ✓ (document.ts:385-392 渲染标签)
```

即:**下游全部就绪,只差中间两处传递**。修完后无需改任何渲染代码。

次因:增量翻译漏跑(第二批 6 条英文残留)——全量重建会让所有条目重译,另加一轮兜底重试(§3.4)。

## 二、用户决策记录

- 范围:**先修 bug 出效果**;behavior surface 实现与两档总览 renderMasteryMap 留下一轮。
- 重建策略:**全重建 L2+L3**(L2 也按主题重提,L3 综合质量更好;成本约 5 surface × 1-2 chunk)。
- 数据源:**现有 9-09/9-11 真实 trace 优先**;重建后知识点覆盖太薄再补模拟 trace(§六 预案)。
- 修法:**方案 A——信任动态 section**(见 §三)。
- 终态期望:画像按具体知识点分节 + 两极标注,聊天导师注入画像后能"像老师一样说"。

## 三、修法设计

### 方案选择

| 方案 | 结论 |
|------|------|
| **A. 信任动态 section + 修 strength 链路(采纳)** | 代码改 3 处、prompt 零改动;知识点分节由 LLM 凭证据自然产生;与 9-09 设计意图一致,behavior surface 未来接入零返工。碎片化风险靠 prompt 示例清单引导 + 既有 dedup/merge 兜底。 |
| B. 锁定知识点清单(改 prompt 迁就代码) | section 固定清单、总览分桶绝对稳定;但长尾知识点被硬塞进最近清单项会失真,prompt/代码两处同步维护,与 9-09 设计"动态 sections"方向相反。否决。 |
| C. 动态 section + 本地别名归一化表 | A 之上再加 "Loop/while → Loop Control" 映射;碎片化尚未实际发生,提前上防御是 YAGNI,映射表会无限膨胀。否决(真发生碎片化时再考虑)。 |

### 3.1 strength 链路修复(2 处)

- update.ts:164(L2)与 update.ts:294(L3)的 `kept.push(...)`:带上
  `knowledge_strength: fact.knowledge_strength`。
- ops.ts `apply()` add 分支:把 `op.knowledge_strength` 写进 Entry,防御性 clamp:
  非有限数(含 NaN/Infinity)→ undefined;有限数 → `Math.round` 后夹到 [1,5]。

dedup/merge 不需要改:EditOp 只改 text/refs,Entry 上已有的 k= 天然保留(merge 保留
较优条目对象,其 k= 随对象保留)。

### 3.2 section 降级修复 + fallback 陷阱

- update.ts:337:删除"白名单外降级"逻辑,只在 `fact.section` 为空时用 fallback;
  `allowedSections` 参数语义变为「fallback 候选」,实现时改名为 `fallbackSections`
  以免误导。
- **fallback 陷阱**:L3 profile 的 fallback 是 `allowedSections[0]` = "Identity",
  而 renderDisplay 隐藏 Identity——LLM 漏给 section 的条目会再次隐身。修法:
  `SLOT_FOCUS.profile.sections` 调序为 `["Knowledge level", "Learning style",
  "Identity"]`(settings.ts:118),让可见的「知识水平」节当兜底。prompt 不改
  (它仍禁止 LLM 主动用这两个泛化节名,于是该节只会装 fallback 条目,语义自洽)。

### 3.3 中文 section 显示

sectionLabels.ts 补 prompt 示例主题(prompts.ts:45-48/123-125 同一清单)的映射:

```
Import Syntax→导入语法  Variable Scope→变量作用域  Loop Control→循环控制
Function Definition→函数定义  Error Handling→错误处理  Data Structures→数据结构
String Manipulation→字符串操作  List Operations→列表操作  Dictionary Usage→字典用法
Control Flow→流程控制  Exception Handling→异常处理  Module System→模块系统
Type Hints→类型注解  Testing Practices→测试实践  Debugging Habits→调试习惯
Code Organization→代码组织
```

未知 section 沿用现有回退机制显示英文原名(sectionLabel fallback),不崩、不丢内容。

### 3.4 翻译兜底(小加固)

`translateL3Doc`(translate.ts):首轮后若 `untouched > 0`,对漏翻的 id 再跑,
最多补 2 轮;3 轮后仍漏的条目保持英文(接受,记录在结果里)。

### 不改的东西

prompt 文本、guards、dedup/merge 触发逻辑、chunker、renderDisplay/strengthLabel、
profileInjector、任何 config key——全部不动。

## 四、重建脚本

新增 `scripts/rebuild-profile.ts`,复用 eval-profile.ts 的既有模式(esbuild 打包纯模块
+ node 运行 + CLI 参数)。

- CLI:`--storage=<globalStorage路径>`(默认取 win32 标准路径
  `%APPDATA%/Code/User/globalStorage/deeptutor.vscode-pylearner`,可覆盖)+
  LLM 配置参数与 eval-profile.ts 完全一致(--provider/--base-url/--api-key/--model,
  环境变量同名回退)。
- I/O 薄层用 node:fs 重写(~60 行):L2/L3 文档与 meta 的原子读写(tmp+rename)、
  trace 目录扫描——复用纯函数 `parseTraceLine`/`traceEventToEntity`(snapshot/adapter.ts)。
  update/translate/chunker/prompts/document/meta 全是纯模块,直接复用。
- **重置范围(关键)**:删除全部 `l2/<surface>.md` + `l2/<surface>.meta.json` +
  `l3/profile.md` + `l3/profile.meta.json`。**L2 的 md 必须一并删**——只删 meta 的话
  旧文档还在,旧条目带着旧的压扁 section(Patterns/Topics),appendFactsToDoc 只会
  往上追加,分节不会重组。chats/ 与 trace/ 一律不碰。
- 流程:重置 → `updateL2`×5 surfaces(并行,同 updateProfile.ts)→ `updateL3(profile)`
  → `translateL3Doc`(全量,不传 newEntryIds)→ 控制台打印 `renderDisplay` 结果
  与各阶段耗时。
- 现有 `resetProfile` 命令只清 L3,不动 L2,不满足全重建语义;脚本独立实现重置,
  不复用它。

## 五、测试与验收

单测(vitest,沿用现有模式):

1. `ops.test.ts`:add 带 knowledge_strength → Entry 持久化且 serialize 写出 `k=`;
   clamp 用例(0→1、6→5、3.7→4、NaN/Infinity→undefined)。
2. `update.test.ts`:LLM 给的白名单外 section 原样保留;空 section 落到
   fallbackSections[0];strength 经 kept→AddOp→Entry 全链存活。
3. `translate.test.ts`:首轮漏翻的条目在补轮中被翻译,补轮上限 2 次。

验收(真跑):

- `npx esbuild scripts/rebuild-profile.ts --bundle --platform=node --format=cjs
  --outfile=out/rebuild-profile.cjs && node out/rebuild-profile.cjs --api-key=...`
- `l3/profile.md`:出现具体知识点 section(如 Loop Control / Function Definition)、
  条目带 `k=`,不再全部堆在 Identity。
- 脚本打印的 renderDisplay:中文分节、每节头部最弱档标签(✅已掌握→⚠️最严重)、
  每条带标签、无英文残留。
- vitest 全量绿。
- (可选)`scripts/eval-profile.ts` 指向重建后的 profile.md 跑 A/B,确认导师回答
  能引用薄弱知识点。

## 六、模拟数据预案(重建后覆盖太薄才触发)

现有 trace 来自 study.py 的真实编辑,函数/循环/导入/变量有卡壳信号,但列表/字典/
异常等可能零证据(prompt 规则:无法评估标 5,不瞎猜)→ 画像可能稀疏。若重建后
总览太空:

- 手写若干条合法 trace 事件追加到 `trace/edit/`(新日期文件),内容刻意覆盖:
  `for` 行反复卡壳(同区域高 touches + `expected ':'` 复发)与列表操作顺畅
  (低改动、一次成型),事件 schema 以 snapshot/adapter.ts 的
  `parseTraceLine`/`traceEventToEntity` 能解析为准,id 用代码生成 ULID 保证
  `isEntryId`/`isValidRef` 通过。
- 追加后重跑脚本(meta 已删,追加条目自动算新输入)。

## 七、边界情况

| 情况 | 处理 |
|------|------|
| LLM 输出的 section 超长 / 含怪字符 | MAX_SECTION_LEN=80 校验已有(ops.validate),超限整批拒绝——与现状一致,不额外处理 |
| LLM 输出 k= 越界(0/6/小数) | clamp 规则见 §3.1 |
| L3 条目无 section | 落 Knowledge level 兜底节,可见 |
| 翻译 3 轮后仍有英文残留 | 接受,不无限重试 |
| 全重建跑一半中断 | L2/L3 逐块原子写 + meta 最后写;重跑脚本即可从头再来(重置是幂等的) |
| 多 surface 中某个 trace 为空 | updateL2 已有空输入短路(no_new_input),脚本照常继续 |

## 八、非目标(YAGNI)

- behavior surface 实现、typing_session 事件、behaviorListener(下一轮,按 9-09 spec)。
- 两档掌握度总览 `renderMasteryMap`(属 behavior spec §七;本轮 renderDisplay 的
  per-section/per-entry 标签已满足"看薄弱点"需求)。
- section 别名归一化表。
- prompt 文本改动。
- 翻译硬重试超过 2 轮 / 翻译质量评估。
- 新增任何 config key / 设置项。

## 九、开放问题(不阻塞实现)

1. **section 碎片化**:动态分节可能产生近义节("Loop Control" vs "While Loop")。
   重建后观察;真碎片化再上别名归一化(§三 方案 C)或 merge prompt 提示。
2. **薄弱判定灵敏度**:本轮证据是"错了什么"(诊断/运行错误),"哪里卡壳"的打字
   过程证据要等 behavior surface;稀疏画像预期靠后续轮次加厚。
3. **LLM 自造未知 section 名**:会以英文原名显示(fallback),遇到再补映射即可。
