# AI 助教 VS Code 插件设计文档

**日期**：2026-09-15  
**状态**：设计评审通过（待实现）  
**适用范围**：学生端 + 教师端（局域网内网）

---

## 1. 项目概述

### 1.1 产品定位
一个 **VS Code 插件**，包含两个角色端：

| 端 | 角色 | 核心职责 |
|---|---|---|
| **学生端** | 学生 | 监听代码错误 → 上报 → 获得针对性提示 |
| **教师端** | 教师 | 实时监控全班 → 分类统计 → 生成报表 |

### 1.2 核心目标
1. **学生端**：捕获 `diag`（诊断）+ `run`（运行）两类事件，作为 AI 上下文
2. **教师端**：实时接收全班学生错误，按类型分类统计，生成可视化报表
3. **效率**：相同错误只调用一次大模型，缓存 + 并发去重，降低调用成本

---

## 2. 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    局域网 (Intranet)                     │
│                                                         │
│  ┌─────────────────┐          ┌─────────────────────┐   │
│  │ 学生端插件       │          │ 教师端 Web 仪表盘    │   │
│  │ (VS Code)       │ ◄──┐     │ (Browser / Webview) │   │
│  │                 │ POST │     │                     │   │
│  │ ┌─────────────┐ │      │     │ ┌─────────────────┐ │   │
│  │ │ diag+run    │ │      │     │ │ 实时统计面板     │ │   │
│  │ │ 监听器       │ │      │     │ │ (Vue3 + ECharts)│ │   │
│  │ └─────────────┘ │      │     │ └─────────────────┘ │   │
│  │ ┌─────────────┐ │      │     │                     │   │
│  │ │ AI 助手     │ │      │     │                     │   │
│  │ │ (Ollama)    │ │      │     │                     │   │
│  │ └─────────────┘ │      │     │                     │   │
│  └─────────────────┘      │     └─────────────────────┘   │
│                           │                             │
│                           ▼                             │
│                    ┌─────────────────┐                 │
│                    │ 教师端服务器     │                 │
│                    │ (Node.js)       │                 │
│                    │ - Express API   │                 │
│                    │ - SSE 广播      │                 │
│                    │ - SQLite 存储   │                 │
│                    └────────┬────────┘                 │
│                             │                          │
│                             ▼                          │
│                    ┌─────────────────┐                 │
│                    │ SQLite 数据库   │                 │
│                    │ (错误事件 + 缓存)│                 │
│                    └─────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

**数据流向**：学生端 POST → 服务器 → 数据库 + SSE 广播 → 教师页面实时更新

---

## 3. 学生端设计

### 3.1 事件监听
仅监听两类事件：

| 事件 | 来源 | 处理方式 |
|---|---|---|
| `diag` | VS Code 诊断系统 | 提取错误代码、消息、位置 |
| `run` | Python 运行任务 | 解析 stdout/stderr，提取 traceback |

### 3.2 学生注册流程
1. 插件首次启动时弹出输入框：姓名 + 班级（可选）  
2. 信息保存至 VS Code SecretStorage（系统凭据库）  
3. 可在设置中修改：`pylearnerStudent.name`、`pylearnerStudent.classId`  
4. 未登录/未注册时默认自动注册（使用 VS Code 用户名作为默认姓名）

### 3.3 上报逻辑

```typescript
// 学生端：监听并上报
function onEvent(event: TraceEvent) {
  // 1. 组装上报数据
  const payload = {
    studentId,     // 从 SecretStorage 读取
    classId,       // 从 SecretStorage 读取（可选）
    timestamp,     // ISO 时间
    type: 'diag' | 'run',
    // 根据事件类型不同，payload 结构也不同
    ...(event.surface === 'diag' && {
      file: event.payload.file,
      errors: event.payload.errors,
      warnings: event.payload.warnings,
      samples: event.payload.samples,  // 原始 samples（可能近重复）
    }),
    ...(event.surface === 'run' && event.kind === 'execution_error' && {
      errorType: event.payload.error_type,
      errorMessage: event.payload.error_message,
      command: event.payload.command,
      exitCode: event.payload.exit_code,
      file: event.payload.file,
      line: event.payload.line,
      source: event.payload.source,
    }),
    codeContext,   // 代码上下文（新增）
  };

  // 2. POST 到教师端服务器
  fetch(`${teacherUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// 代码上下文结构（前后 10 行）
interface CodeContext {
  filePath: string;        // 文件绝对路径
  lineNo: number;          // 报错行号（1-based）
  snippet: string;         // 前后 10 行代码（约 20 行总计）
}
```

### 3.4 AI 提示生成（带缓存与并发去重）

```typescript
class ErrorExplanationService {
  private cache = new Map<string, ErrorExplanation>(); // 内存缓存（热点）
  private pending = new Map<string, Promise<ErrorExplanation>>(); // 进行中请求

  async getExplanation(event: TraceEvent): Promise<ErrorExplanation | null> {
    // 1. 从事件中提取缓存 key
    const cacheKey = extractCacheKey(event);
    if (!cacheKey) return null;

    // 2. 命中内存缓存 → 直接返回
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // 3. 有正在进行的请求 → 直接等待，不再调 LLM
    if (this.pending.has(cacheKey)) {
      return this.pending.get(cacheKey)!;
    }

    // 4. 发起新的 LLM 调用（带上下文）
    const promise = this.llmCall(event, cacheKey)
      .then(result => {
        // 同时写入持久层（SQLite）和内存缓存
        this.cache.set(cacheKey, result);
        db.saveErrorToCache(cacheKey, result);
        return result;
      })
      .finally(() => {
        this.pending.delete(cacheKey); // 调用结束后从进行中列表移除
      });

    // 记录"进行中"状态，防止同一时间多个学生触发相同报错时重复调用
    this.pending.set(cacheKey, promise);
    return promise;
  }

  private async llmCall(event: TraceEvent, cacheKey: string): Promise<ErrorExplanation> {
    // 实际调用 Ollama（或 vscode-lm），超时设为 5s
    const prompt = buildPrompt(event, cacheKey);
    const raw = await ollama.generate(prompt, { timeout: 5000 });
    return parseLLMResponse(raw);
  }
}

// 从 payload 中提取缓存 key
function extractCacheKey(event: TraceEvent): string | null {
  if (event.surface === 'diag') {
    const samples: string[] = (event.payload as any).samples || [];
    if (samples.length === 0) return null;
    // 取最短的样本作为代表（减少重复干扰）
    return samples.sort((a, b) => a.length - b.length)[0];
  }

  if (event.surface === 'run' && event.kind === 'execution_error') {
    const payload = event.payload as any;
    const errorType = payload.error_type || '';
    const errorMsg = payload.error_message || '';
    if (!errorType || !errorMsg) return null;
    return `${errorType}: ${errorMsg}`;
  }

  return null;
}
```

---

## 4. 教师端设计

### 4.1 页面布局（V1：简约表格 + 图表）

```
┌─────────────────────────────────────────────────────────┐
│ 🟢 AI 助教控制台                      [班级筛选] [刷新]  │
├─────────────────────────────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ │
│ │ 今日错误  │ │ 语法错误  │ │ 运行错误  │ │ 活跃学生  │ │
│ │   128     │ │   64      │ │   42      │ │   18      │ │
│ └───────────┘ └───────────┘ └───────────┘ └───────────┘ │
│                                                         │
│ ┌─────────────────────────────┐ ┌─────────────────────┐ │
│ │ 📊 错误类型分布（饼图）       │ │ 🔥 高频错误 Top 5    │ │
│ │ [饼图]                       │ │ 1. for 缺冒号 12次  │ │
│ │                              │ │ 2. 逗号非英文   9次  │ │
│ └─────────────────────────────┘ └─────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📋 实时错误明细（SSE 实时更新）                      │ │
│ │ 时间 | 学生 | 班级 | 类型 | 错误信息 | 代码位置 | 处理 │ │
│ │ ─────────────────────────────────────────────────── │ │
│ │ 10:23 | 张三 | 3A   | 语法 | for 缺冒号 :           │ │
│ │ 10:25 | 李四 | 3A   | 语法 | 逗号非英文 ,           │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 4.2 实时推送（SSE + 断线重连）

```typescript
// 教师端服务器（Node/Express）
app.get('/api/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (data: any) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // 客户端已断开，忽略
    }
  };

  eventBus.on('new-event', send);

  // 当请求关闭时移除监听
  req.on('close', () => {
    eventBus.off('new-event', send);
  });
});

// 客户端（教师页面）
let eventSource: EventSource | null = null;

function connectSSE() {
  eventSource = new EventSource('/api/events/stream');
  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    appendEventToTable(data);
  };
  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
    }
    // 3 秒后重连
    setTimeout(connectSSE, 3000);
  };
}
connectSSE();
```

### 4.3 教师端服务器启动方式
- 提供 `server.js` 作为入口点  
- 一键启动脚本：`npm run start-server`（在 `package.json` 中定义）  
- 服务器默认监听 `0.0.0.0:3000`（局域网内可通过 IP 访问）  
- 日志输出至 `logs/server.log`，支持环境变量配置端口  

---

## 5. 数据库设计

### 5.1 错误事件表（events）

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  TEXT NOT NULL,      -- 学生 ID（来自注册）
  class_id    TEXT,               -- 班级 ID（可选）
  event_type  TEXT NOT NULL,      -- diag | run
  raw_message TEXT NOT NULL,      -- 原始错误信息（用于缓存 key）
  category    TEXT NOT NULL,      -- 分类：syntax/indentation/name/type/index/runtime
  explanation TEXT,               -- 中文解释（由 LLM 生成或预定义）
  suggestion  TEXT,               -- 修复建议
  file_path   TEXT,               -- 文件路径
  line_no     INTEGER,            -- 行号
  timestamp   DATETIME NOT NULL,  -- 发生时间
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_student ON events(student_id);
CREATE INDEX idx_events_class_time ON events(class_id, timestamp);
CREATE INDEX idx_events_raw_message ON events(raw_message); -- 缓存查询加速
```

### 5.2 错误知识库表（error_cache - 持久化缓存）

```sql
CREATE TABLE error_cache (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_hash      TEXT UNIQUE NOT NULL,  -- SHA256(raw_message) 作为唯一键
  raw_message   TEXT NOT NULL,         -- 原始错误信息（调试/回显）
  category      TEXT NOT NULL,
  explanation   TEXT NOT NULL,
  suggestion    TEXT NOT NULL,
  source        TEXT DEFAULT 'llm',    -- 'llm' 或 'predefined'
  hit_count     INTEGER DEFAULT 0,     -- 命中次数（用于统计）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_error_cache_hash ON error_cache(raw_hash);
```

### 5.3 学生表（students）

```sql
CREATE TABLE students (
  id          TEXT PRIMARY KEY,   -- 学生 ID（学号或自定义）
  name        TEXT NOT NULL,      -- 姓名
  class_id    TEXT,               -- 班级
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 5.4 题目表（assignments - 预生成易错点映射，V2）

```sql
CREATE TABLE assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,      -- 题目名称
  description TEXT,               -- 题目描述
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 题目对应的易错点映射（教师提交题目后自动填充，V2 实现）
CREATE TABLE assignment_error_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id),
  raw_pattern TEXT NOT NULL,      -- 错误模式（正则或关键词）
  category    TEXT NOT NULL,
  explanation TEXT NOT NULL,
  suggestion  TEXT NOT NULL,
  UNIQUE(assignment_id, raw_pattern)
);
```

> **注意**：`assignments` 和 `assignment_error_map` 表结构预留，V1 不实现。

---

## 6. 错误分类与解释生成

### 6.1 分类规则（写死 + 关键词匹配，避免脆弱正则）

```typescript
const errorRules: ErrorRule[] = [
  {
    // 关键词匹配而非精确正则，提高容错性
    keywords: ['expected an indented block'],
    category: 'indentation',
    explanation: '缩进错误：if/for/def 后需要缩进代码块',
    suggestion: '检查缩进，确保代码块有正确的缩进层级'
  },
  {
    keywords: ['invalid syntax', ':'],
    category: 'syntax',
    explanation: '语法错误：for 循环缺少冒号 :',
    suggestion: '在 for 循环语句末尾添加冒号 :'
  },
  {
    keywords: [',', 'English'], // 检测中文逗号或提示需要英文逗号
    category: 'syntax',
    explanation: '逗号错误：请使用英文逗号 ,',
    suggestion: '将中文逗号 ， 替换为英文逗号 ,'
  },
  {
    keywords: ['is not defined'],
    category: 'name',
    explanation: '变量未定义：使用前需要先赋值',
    suggestion: '检查变量名拼写，确保在使用前已声明'
  },
  {
    keywords: ['unsupported operand type(s)'],
    category: 'type',
    explanation: '类型错误：不能对不兼容类型直接运算',
    suggestion: '检查变量类型，必要时使用 int()、float()、str() 转换'
  },
  {
    keywords: ['list index out of range'],
    category: 'index',
    explanation: '列表索引越界：索引超过了列表长度',
    suggestion: '确认列表长度，使用有效索引（0 到 len-1）'
  }
];
```

**匹配逻辑**：错误信息若包含所有关键词（大小写不敏感），则命中该规则。

### 6.2 解释生成流程

```
1. 学生端上报 raw_message + codeContext
2. 教师端服务器：
   a. 查 error_cache（按 raw_hash） → 命中则直接返回 explanation/suggestion
   b. 未命中 → 查 pendingRequests（是否有正在调用的相同 raw_message）
      ├─ 有 → 直接等待该 Promise（不再调 LLM）
      └─ 无 → 发起新的 LLM 调用（Ollama），得到结果后：
           ├─ 存入 error_cache（持久化） + 内存缓存
           ├─ 从 pendingRequests 移除
           └─ 广播给所有已连接的教师页面（SSE）
3. 教师端页面通过 SSE 接收新事件，实时更新表格和统计图
```

---

## 7. API 设计

### 7.1 学生端 → 教师端

| 接口 | 方法 | 说明 |
|---|---|---|
| `POST /api/events` | POST | 上报错误事件（含 codeContext） |
| `POST /api/students/register` | POST | 注册学生（姓名+班级） |
| `GET /api/students` | GET | 获取学生列表（教师端用） |

### 7.2 教师端 → 教师端

| 接口 | 方法 | 说明 |
|---|---|---|
| `GET /api/events` | GET | 查询错误事件（分页+筛选+时间范围） |
| `GET /api/stats` | GET | 获取统计汇总（按类型/班级/时间） |
| `GET /api/events/stream` | GET | SSE 实时推送（text/event-stream） |
| `POST /api/assignments` | POST | 创建题目（标题+描述，V2） |
| `POST /api/assignments/{id}/explain` | POST | 用题目预生成易错点映射（V2） |
| `GET /api/assignments/{id}/errors` | GET | 获取题目对应的易错点映射（V2） |

---

## 8. 关键设计决策说明

### 8.1 为什么选择 SSE 而不是 WebSocket？
- 需求是 **单向** 上报（学生→教师），教师端仅需接收推送  
- SSE 简单：**一行代码** 建立长连接，无需额外库  
- 浏览器原生支持，Node.js 也原生支持（通过 `express`）  
- 适合低并发：20 名学生规模下 SSE 足够，且一个 SSE 连接即可推送所有学生事件  

### 8.2 为什么选择 SQLite？
- **轻量**：单文件数据库，无需单独部署数据库服务  
- **够用**：20 名学生 × 每天几十条错误，数据量极小（MB 级）  
- **持久化**：重启不丢数据，方便后续统计和导出  
- **易备份**：直接复制 `.sqlite` 文件即可  

### 8.3 为什么选择 Ollama？
- **本地运行**：无需联网，隐私安全（课堂内网环境）  
- **免费**：无调用成本，适合教育场景  
- **与现有项目兼容**：复用 pylearner 的 Ollama 后端实现  

### 8.4 错误缓存策略的重要性
- **预生成映射（V2）**：教师提交题目后，一次 LLM 调用生成全部易错点 → 后续学生犯错均走缓存  
- **并发去重**：同一时间多个学生报同一错误，只调用一次 LLM，其余等待同一个 Promise  
- **持久化+热点**：错误解释持久化到 SQLite，内存缓存热点数据，命中率高  

### 8.5 V1 与 V2 范围划分

| 功能 | V1 | V2 |
|---|---|---|
| 错误上报（diag + run） | ✅ | ✅ |
| 缓存 + 并发去重 | ✅ | ✅ |
| 教师端实时仪表盘 | ✅（简约） | ✅（丰富交互） |
| 学生注册（设置页） | ✅ | ✅ |
| 预生成易错点映射 | ❌ | ✅ |
| 题目功能 | ❌ | ✅ |
| 丰富交互（点击跳转等） | ❌ | ✅ |

---

## 9. 待确认的问题（供您审阅）

1. **学生注册方式**：是否接受通过插件设置页填写姓名/班级，还是需要从 Windows 登录名自动获取？  
2. **题目功能优先级**：是否需要在 V1 就实现"提交题目 → 预生成易错点映射"，还是先做基本错误上报+缓存？  
3. **代码上下文字段**：`codeContext` 中的 `snippet` 长度是否足够（前后 10 行），还是需要可配置？  
4. **教师端仪表盘风格**：是否偏好简约表格+图表，还是需要更丰富的交互（如点击错误跳转到学生代码）？  

---

**请审阅上述设计文档（v2）。**  
如果没有问题，请确认，**我将进入实现计划阶段**（写设计文档并提交），随后调用 **writing-plans** 技能生成详细实现计划。  

如需修改，请指出具体位置，我会立即调整。
