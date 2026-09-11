# 老师总评:LLM 综合判定学习情况 — 设计文档

> 目标终态:Profile 面板与聊天导师看到的不再是逐条事件式画像,
> 而是一份老师口吻的**总评**:一段学习情况叙述 + 维度表(维度/表现/判断),
> 由 LLM 综合判定生成。
> 手段:画像更新后新增一个「总评 pass」——把 L3 画像回喂给 LLM,
> 提示词要求以老师身份判断学生学 Python 的学习情况。

日期:2026-09-11
前置:2026-09-11-mastery-profile-fix-design.md(已完成,k= 标注与知识点分节已重建达标)
现状:画像有 11 个知识点分节、每条带 k=,但视图是逐条事件罗列,像流水账不像老师评价。

---

## 一、背景与动机

修复轮之后画像数据质量已达标(分节+k=+全中文),但展示形态仍是「每节若干条事实」,
用户反馈:**像单纯的事件记录**。期望形态(用户提供样例):

- 一段总叙述:「处于入门初期,基础语法存在系统性薄弱,但已具备初步的纠错意识和
  基本概念运用能力」
- 一张维度表:维度 | 表现(具体证据摘要) | 判断(🟢/🟡/🔴 三档);
  维度是对分节的**语义归并**(导入语法+语法错误×3+流程控制 →「基础语法」),
  表现列是自然语言证据描述。

这种语义归并与叙事判断是 LLM 强项、规则弱项,故采纳 LLM 总评。

## 二、用户决策记录

- 生成方式:**方案 A——LLM 总评 pass**(把画像回喂 LLM,提示词"判断学生学 Python
  的学习情况");规则聚合(B)与混合(C)否决。
- 展示:**只显示总评**——面板与聊天注入不再展示逐节明细;
  需要看证据时打开原始 profile.md(既有 Open profile 通道)。
- 判断三档沿用既有词汇:🟢已掌握 / 🟡一般 / 🔴存在误区(与 k= 标签一致)。
- 9-09 spec 的规则版 renderMasteryMap(两档总览)由本总评**取代**,不再实现。

## 三、方案设计

### 3.1 新模块 `src/memory/overview.ts`(纯模块,可单测)

- `buildOverviewSystem(today: string): string` — 系统提示词:
  - 角色:Python 老师,基于画像判断该学生学习情况,像给家长/本人写评语;
  - 输出契约(硬约束):中文;先一段 80-200 字总评叙述,再一张 markdown 表格,
    表头固定 `维度 | 表现 | 判断`;维度 5±3 个,由画像分节语义归并;
    表现列引用画像中的具体证据(如拼写错误、未定义变量清单);
    判断列只能用 🟢已掌握 / 🟡一般 / 🔴存在误区;
    只基于画像证据,不臆造画像中不存在的知识点;禁止绝对化断言
    (沿用 guards 精神,prompt 内声明)。
- `buildOverviewUser(profileDisplay: string): string` — 用户消息:完整
  `renderDisplay(profile)` 输出(中文分节 + 每条 k= 标签)。
- `synthesizeOverview(deps: OverviewDeps, slot: L3Slot): Promise<void>`:
  - `OverviewDeps = { loadL3Doc(slot)→Document|null; callLlm(system,user,context);
    saveOverviewText(text); onEvent? }` — 不动 ConsolidatorDeps 冻结接口,
    各调用方自行装配 IO(与 modeDeps 适配器同理)。
  - 流程:loadL3Doc → 空文档(无条目)直接返回(无画像可评)→
    renderDisplay → callLlm(context=`L3:${slot}:overview`)→
    saveOverviewText(输出原文,不解析、不翻译——prompt 已要求中文)。

### 3.2 存储

- 新文件 `l3/profile-overview.md`(自由 markdown,**不走** Document 条目机制——
  它是综合产物,无需条目 id/refs/k=/dedup)。
- `paths.ts` 新增 `overviewFile(storageUri, slot)` → `l3/<slot>-overview.md`。
- `store.ts` 新增 `loadOverview` / `saveOverview`(沿用既有 tmp+rename 原子写;
  读失败返回 null)。脚本侧(rebuild-profile.ts)用自己的 node:fs 薄层加同一文件
  读写,模式与现有 l2/l3 I/O 层一致。

### 3.3 触发点(全部 best-effort)

| 调用方 | 时机 | 跳过条件 |
|---|---|---|
| `runProfileUpdate`(updateProfile.ts) | translate 完成后 | `factsAdded===0` **且** overview 文件已存在(修复轮新增事实或上轮总评失败时才补跑) |
| rebuild-profile.ts | translate 完成后 | 画像为空 |
| reset 命令 | 走 runProfileUpdate,自动覆盖 | 同上 |

- 失败处理:try/catch 包裹,emit `{stage:"overview_failed", error}`,日志警告,
  **不中断管道**——画像本身已保存成功,总评是增强层。
- 取消令牌:与 translate 同样检查。

### 3.4 渲染(只显示总评)

- Profile 面板(profileViewProvider):overview 文件存在 → 显示其全文;
  否则回退现有 renderDisplay(画像刚重置、总评尚未生成的窗口期)。
  renderRaw(原始审计视图)通道不变。
- 聊天注入(messageHandler):同样 overview 优先,缺失回退 renderDisplay。
  总评体量 200-400 token,注入预算安全。
- 两个调用方共享一个小纯函数 `pickProfileView(overviewText: string|null, doc):
  string`(overview 有值用 overview,否则 renderDisplay(doc)),便于单测。

### 3.5 重置语义(关键边界)

- `resetProfile`(updateProfile.ts:227)删除清单追加 `l3/profile-overview.md`——
  否则重置后旧总评残留,与新画像脱节。
- rebuild 脚本 resetStorage 同步追加删除该文件。
- 总评文件无 meta sidecar(单文件整体覆盖写,不需要 seen-id 追踪)。

## 四、测试(vitest,沿用现有模式)

1. `overview.test.ts`(新):prompt 构建含全部硬约束关键词;synthesizeOverview
   成功路径(fake LLM → saveOverviewText 收到原文);空文档跳过;callLlm 抛错
   向上传播(由调用方 catch)。
2. `document.test.ts` 或新文件:`pickProfileView` 两分支。
3. updateProfile 接线:手动验收为主(逻辑薄);脚本侧同。

## 五、验收(真跑)

- rebuild 脚本重跑(--reset-only 之外全流程),生成 l3/profile-overview.md:
  一段中文总评 + 维度表,维度≤8,判断只用三档 emoji,无绝对化断言。
- Profile 面板:只显示总评;聊天导师回答能引用总评中的维度与判断。
- vitest 全量绿。

## 六、边界情况

| 情况 | 处理 |
|---|---|
| 总评 LLM 调用失败/超时 | 调用方 catch,emit overview_failed,面板回退 renderDisplay |
| profile.md 为空(重置后未更新) | synthesizeOverview 直接返回,面板回退 |
| 总评文件存在但画像刚重置 | 不可能:重置与重建路径都会删总评(§3.5) |
| LLM 输出格式跑偏/夹英文 | prompt 硬约束,不做运行时校验(best-effort,接受) |
| 总评过长撑爆注入 | prompt 限 80-200 字叙述+≤8 行表格;注入层现有截断逻辑兜底 |

## 七、非目标(YAGNI)

- behavior surface、typing_session 事件(9-09 spec,仍属下一轮)。
- 规则版 renderMasteryMap(被总评取代,正式取消)。
- 总评的人工编辑/重新生成按钮(面板刷新自然重生成)。
- 新增任何 config key。
- 总评格式运行时校验。

## 八、开放问题(不阻塞实现)

1. 维度归并的稳定性:同一学生不同次更新,维度名可能变化(「基础语法」vs「语法基础」)。
   总评是每次全文重写的综合产物,不存在增量合并,影响仅限跨次阅读一致性;先观察。
2. 总评与 k= 三档的颜色语义映射:🟢/🟡/🔴 与 k= 1-5 的对应由 LLM 按画像标签推断,
   不在 prompt 里硬编码映射表(画像分节最弱档标签已是现成输入)。