# L1 Trace 全量归档设计

- 日期：2026-10-13
- 状态：已批准
- 涉及仓库：vscode-pylearner（客户端）、classroom-assistant（服务端）

## 1. 背景与目标

L1 trace 目前只上报 diag/run 两类事件到教师服务器（分析链路），edit/chat/debug 等其余事件仅存本地。学生今天用这台电脑、明天换一台，本地数据散落多机且无法归集；共享电脑上先后多名学生使用时，本地混存事件无法区分归属；麒麟内网机上 globalStorage 目录很深也难以查找。

目标：

1. 本地 L1 按学号分目录记录，共享电脑上多学生数据天然隔离
2. L1 全量事件（6 个 surface）按学号归档到服务器，学生换机后数据自动汇聚，不乱不丢
3. 归档通道与现有分析上报通道（`/api/events`）完全解耦，纯归档备份用途，不入库
4. 内网断网不丢数据，恢复后自动补传
5. 服务器压力最小化：不做高频推送

非目标：

- 不修改现有分析链路（TeacherReporter / events 表 / dashboard 聚合）
- 不同步 L2/L3 学习者画像与聊天会话文件（本次范围外）
- 不做本地数据清理（归档后本地 JSONL 保留，一学期量级几十 MB）
- 不迁移旧布局混存数据（归属不明，保留原地不归档）

## 2. 总体架构

两条独立链路：

```
                       ┌─ 现有（不动）→ POST /api/events ──────→ SQLite events 表 → dashboard 分析
L1Writer.append ───────┤
                       └─ 新增（归档）→ TraceArchiver ────────→ POST /api/trace/archive → 服务器文件系统
```

关键决策：

- **本地按学号分目录**：L1Writer 写入时读取当前身份，事件落入对应学号目录；未设身份落 `unknown/`
- **归档单位 = 目录学号，不是当前登录者**：批次身份取自各学号目录的 `.identity.json`，学生 A 用完没归档、电脑换 B 在用，A 的历史数据仍归档到 A 名下
- Archiver **不接收内存中的事件对象，而是激活时读本地 JSONL 文件 + 位点**。本地 JSONL 是唯一事实源，天然构成补传队列——断网、崩溃、换机（重装后）都能续传。L1Writer 除写路径加学号层外零改动

## 3. 通信协议

### 请求

`POST /api/trace/archive`

```json
{
  "student_id": "2024001",
  "student_name": "张三",
  "class_id": "default",
  "surface": "edit",
  "date": "2026-10-13",
  "events": [
    { "id": "edit:01KZW...", "ts": "2026-10-13T06:31:14.754Z", "surface": "edit", "kind": "code_change", "payload": {} }
  ]
}
```

### 响应

`200 { "ok": true, "accepted": 42, "duplicated": 3 }`

- `accepted`：本次新落盘的事件数
- `duplicated`：按 id 判重后跳过的事件数

### 校验规则

- `student_id`、`events` 非空；`student_id` 仅允许 `[A-Za-z0-9_-]` 且不等于保留字 `unknown`（防路径穿越与目录冲突），否则 400
- `surface` 限定已知 6 值（edit/run/chat/debug/diag/behavior），否则 400
- `class_id` 缺省 `default`
- 宽松度与现有 `/api/events` 一致，不做名册校验

### 服务器存储结构

```
<TRACE_DIR>/trace/<classId>/<studentId>/<surface>/<YYYY-MM-DD>.jsonl
```

默认 `TRACE_DIR` 为 server 包下 `data/`（与 `assistant.db` 同级），环境变量 `TRACE_DIR` 可覆盖（与 `DB_PATH` 环境变量同款约定）。数据目录已在 classroom-assistant 的 .gitignore 中（`packages/server/data/`），不会进仓库。

### 幂等合并

服务器读现有归档文件 → 按事件 `id`（ulid，全局唯一）建集合 → 只追加不存在的行 → 写回。学生多台电脑同一天写同名文件、客户端重传已归档数据，均不产生重复。

### 并发控制

per-file 写锁（`Map<path, Promise>` 链式串行化），防并发请求读写交错，与客户端 L1Writer 的锁模式同思路。

### 批次上限

客户端单批 ≤ 200 事件或 ≤ 512KB；服务端 `express.json({ limit: "2mb" })` 已满足。

## 4. 客户端设计（vscode-pylearner）

### 4.1 本地存储布局（按学号分目录）

```
globalStorage/
├── trace/
│   ├── archive-state.json                 # 位点文件（key 带学号前缀）
│   ├── 2024001/                           # 学生 A
│   │   ├── .identity.json                 # { studentId, studentName, classId } 身份快照
│   │   └── edit/2026-10-13.jsonl
│   ├── 2024002/                           # 学生 B
│   │   └── ...
│   └── unknown/                           # 未设身份时的事件（永不归档）
│       └── edit/...
└── chats/                                 # 现状不动
```

规则：

- L1Writer 注入 `getIdentity()`（extension.ts 现成），每次 append 读取 → 决定落盘目录；学号变更后下一条事件立即落新目录
- 每次 append 同步维护 `.identity.json`（身份变化时覆写，内容为写入时的身份快照）
- 学号合法性：仅 `[A-Za-z0-9_-]`，且不与 6 个 surface 名、保留字 `unknown` 冲突；不合法一律落 `unknown/`
- 未设身份落 `unknown/`，本地照记（行为延续），但永不归档（归属不明，归档即错）
- 旧布局遗留（现有 `trace/<surface>/` 混存文件）：保留原地、不归档、不迁移

### 4.2 归档模块（新增 `src/archive/`）

| 文件 | 职责 |
|---|---|
| `archiveState.ts` | 位点读写（纯函数）。`trace/archive-state.json` 记录 `{"2024001/edit/2026-10-13.jsonl": 12345}`——`<studentId>/<surface>/<date>.jsonl` → 已归档字节数 |
| `batcher.ts` | 扫描 `trace/<studentId>/<surface>/*.jsonl`（跳过 `unknown/` 与旧布局顶层 surface 目录），对比位点，读出未归档段，解析 JSONL，切批（≤200 事件或 ≤512KB） |
| `archiver.ts` | 调度器：激活后延迟触发 + fetch 上传 + 位点推进；启动延迟纳入 `context.subscriptions`（dispose 取消） |

### 4.3 批次身份来源

批次的 `student_id` / `student_name` / `class_id` 取自**该学号目录的 `.identity.json`**，不取当前登录者。identity.json 缺失或损坏 → 跳过该目录，下次激活重试。

### 4.4 触发时机（仅激活归档，零后台常驻）

| 触发 | 时机 | 说明 |
|---|---|---|
| 激活归档 | 激活后延迟 10s，扫描一次 | 换机/补传的唯一路径 |

- 无定时器、无事件驱动触发。扩展经 `onStartupFinished` 自动激活，任何人打开 VS Code 都会触发全量扫描——机房共享机场景下，前一学生滞留的数据在其离场后的下一次激活自动归到他名下（归档单位 = 目录学号，spec §4.3）
- 归档频率只影响服务器数据的新鲜度，不影响数据完整性——本地 JSONL 持久存在，机器中途崩溃后下次激活自动补齐；服务器侧实时性由现有分析链路（/api/events）承担

### 4.5 扫描与位点规则

- 扫描对象：`trace/<studentId>/<surface>/*.jsonl`（排除 `unknown/`、旧布局顶层目录）
- 位点无记录 → 从 0 归档；有记录 → 从 offset 起归档
- 本地文件比位点小（异常，理论只追加）→ 位点重置 0 全量重传，服务器按 id 去重，安全
- 位点文件直接覆写（体积小；损坏顶多重传，服务器幂等，无需原子 rename）

### 4.6 位点推进规则

- 批次 2xx → 立即推进位点
- 网络错误 / 5xx → 位点不动，下次激活重试
- 400 → 位点直接跳到文件尾（数据本身有问题，重试无意义），记 warning 日志
- 单文件多批：位点按批推进（每批 2xx 后推进该批字节数）；某批失败则停止该文件的推送，已成功的批次推进保留，下次激活从失败处续传

### 4.7 配置门控

- 复用 `pylearner.teacher.url` + `pylearner.teacher.enabled`，不新增配置项（归档和分析同一服务器、同一开关）
- 学号中途变更：旧目录数据按旧目录身份归档，新事件落新学号目录（目录即归属，无需特殊处理）

### 4.8 画像管线适配

[snapshot/reader.ts](../../../src/snapshot/reader.ts) `readTraceEntities` 增加学号参数，读 `trace/<studentId>/<surface>/`；三个调用方（updateProfile / autoRefresh / memoryGraph）传当前学号，无身份 → 空数组（画像不为无身份者工作）。

### 4.9 运维入口

新增命令 `Python Learner: 打开数据文件夹`（`pylearner.openDataFolder`）：revealInExplorer 定位到 globalStorage，供教师/运维查看本地数据，缓解麒麟目录深不好找的问题。

## 5. 服务端设计（classroom-assistant）

- 新文件 `packages/server/src/routes/traceArchive.ts`，以现有 `registerXxxRoutes(app, deps)` 模式在 `index.ts` 注册
- 接口依赖注入：`{ traceDir }`（默认 `path.join(process.cwd(), "data")` 下 `trace/`，`TRACE_DIR` 覆盖），便于测试传临时目录
- 复用 `logEvent` 打结构化日志（`archive.batch_received` / `archive.batch_rejected` 等）
- 零 DB 改动，events 表 / aggregator / dashboard 完全不碰

## 6. 错误处理汇总

| 场景 | 行为 |
|---|---|
| 内网断网 | 静默重试（console.warn + outputChannel），不弹 UI；恢复后下次激活自动补传 |
| 未设身份 | 事件落 `unknown/` 本地照记；unknown 目录永不归档 |
| identity.json 缺失/损坏 | 跳过该学号目录，下次激活重试 |
| 学号不合法（含路径穿越字符/与保留字冲突） | 事件落 `unknown/` |
| 本地文件读取失败 | 跳过该文件，下次激活再试 |
| 批次 400 | 位点跳文件尾 + warning（重试无意义） |
| deactivate | 启动延迟计时器随 dispose 取消；不做退出 flush（位点机制保证下次激活补传） |
| 本地数据 | 归档后不删除，无清理机制 |

## 7. 测试策略

客户端（vitest + 现有 vscode-mock 模式）：

- archiveState：位点读写、文件缩小重置、路径 key 归一（含学号前缀）
- batcher：扫描 diff（新文件/增量/无新增）、`unknown/` 与旧布局目录跳过、JSONL 解析容错（坏行跳过）、批次切分边界（事件数上限/字节上限）、identity.json 缺失跳过
- L1Writer：按身份落目录、身份切换即时生效、学号不合法落 unknown、identity.json 维护
- archiver：2xx 推进 / 5xx 重试 / 400 跳尾 / 网络异常 / 启动延迟生命周期（dispose）
- reader：按学号读取、无身份返回空

服务端（vitest，沿用 `__tests__/` 集成测试风格）：

- 合并幂等：同 id 重传不重复、乱序到达可合并、`accepted`/`duplicated` 计数正确
- 目录组织：classId/studentId/surface/date 落位正确
- 安全：studentId 含 `../`、非法字符、保留字 `unknown` → 400
- 并发写锁：交错请求不丢行
- 校验：缺 student_id / 空 events / 非法 surface → 400
