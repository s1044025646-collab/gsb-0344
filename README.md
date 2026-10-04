# Piece Table 文本编辑与来源片段回放后端

这是一个只包含 API 与 CLI 的 Windows 本地后端示例，使用 TypeScript、Node.js、SQLite 和 `better-sqlite3` 实现。项目不包含网页、多人协作、差异合并或语法高亮。

## 能力

- 每份文档保存两个不可变/追加式文本缓冲区：
  - `original`：创建文档时的原始缓冲区，之后不修改。
  - `added`：只追加的新增缓冲区，撤销、重做或删除都不会改写已有内容。
- 当前文档状态由片段表（piece table）维护，每个片段记录：
  - `source`：`original` 或 `added`
  - `start`：来源缓冲区中的 Unicode 码点起点
  - `length`：引用的码点长度
- 插入时在插入点分裂片段，并把新文本追加到 `added`。
- 删除时只删除或分裂片段引用，不重写两个缓冲区。
- 仅当两个片段来自同一缓冲区且来源区间物理连续时才合并；不会因为文本相同就合并不相邻来源。
- 支持逐步撤销、重做；撤销后创建新编辑会把新路径设为当前首选重做路径，旧分支仍保留在历史中但不再从当前路径重做。
- 空字符串插入和零长度删除不生成新版本，返回 `changed: false`。
- 所有编辑都必须带当前 `version`；过期版本返回 `VERSION_CONFLICT`，不会部分应用。
- SQLite 在一个立即事务中提交新增缓冲、版本片段、操作和当前版本指针；重启后仍可继续编辑、撤销和重做。

## 码点语义

所有位置、长度和缓冲区偏移都按 Unicode 码点（code point）计数，不按 UTF-16 code unit 或 UTF-8 字节计数。

例如：

- `😀` 是一个码点，位置占 1。
- `e\u0301` 是两个码点，位置占 2；虽然用户可能把它感知为一个带重音的字符“é”。
- CRLF 是 `\r` 与 `\n` 两个码点。

本项目不做 Unicode 字形簇（grapheme cluster）合并，也不规范化 CRLF、NFC/NFD 或组合字符。因此 API 位置与用户感知字符不总相同。

## 环境要求

- Windows 本地 PowerShell
- Node.js 22 或更高版本（当前开发环境为 Node.js 25.5.0）
- npm

不需要 Docker、WSL、付费服务或外部在线 API。

## 安装与构建

```powershell
npm install
npm run build
```

编译输出位于 `dist/`。直接运行编译产物：

```powershell
node dist/src/server.js
node dist/src/cli.js create --id=demo --text="你好😀"
```

开发模式也可以直接运行 TypeScript：

```powershell
npm start
npm run cli -- get demo
```

## 测试与演示

```powershell
npm test
npm run demo
```

测试覆盖：

- 独立码点数组参考模型逐步比对文本与长度。
- 独立逐片段拼接核对来源。
- 首尾插入、删空、跨多个片段删除、连续删除。
- 表情、组合字符和 CRLF 位置。
- 相同文字但来源不相邻时不误合并。
- 越界位置、非法范围和过期版本冲突。
- SQLite 关闭重开后继续编辑、撤销和重做。
- HTTP API 基本流程。

演示会在中文与表情混合文本中插入、跨原始与新增片段删除、撤销/重做，并在撤销后创建新分支。

## HTTP API

默认 `PT_PORT=0`，由操作系统选择空闲端口，服务只监听 `127.0.0.1`。启动后控制台会打印实际端口。

### 健康检查

```http
GET /health
```

### 创建文档

```http
POST /documents
Content-Type: application/json

{"id":"doc1","text":"你好😀ABC"}
```

`id` 可省略；省略时使用 UUID。空文档使用 `{"text":""}` 或空请求体。

### 获取完整文档

```http
GET /documents/doc1
```

返回当前版本、全文、码点长度和片段报告。片段的 `displayStart` 为闭区间起点，`displayEnd` 为排他终点。

### 读取区间

```http
GET /documents/doc1/read?start=0&end=3
```

`end` 可省略，默认到文末。空文档只能读取 `0..0`。

### 插入

```http
POST /documents/doc1/insert

{"version":0,"position":2,"text":"世界😎"}
```

在文末插入时，`position` 等于当前码点长度。

### 删除

```http
POST /documents/doc1/delete

{"version":1,"start":1,"end":4}
```

删除范围为 `[start,end)`。`start === end` 是合法空操作，但不生成历史。

### 撤销与重做

```http
POST /documents/doc1/undo
{"version":2}

POST /documents/doc1/redo
{"version":1}
```

### 查询片段与来源

```http
GET /documents/doc1/pieces
GET /documents/doc1/source?position=2
```

来源结果包含来源缓冲区、缓冲区起点、片段内偏移、码点值、片段序号和显示区间。

### 历史与导出

```http
GET /documents/doc1/history
GET /documents/doc1/export
```

## CLI

```powershell
npm run cli -- create --id=demo --text="你好😀ABC世界"
npm run cli -- get demo
npm run cli -- read demo --start=0 --end=4
npm run cli -- insert demo --version=0 --position=4 --text="插入😎"
npm run cli -- delete demo --version=1 --start=2 --end=8
npm run cli -- undo demo --version=2
npm run cli -- redo demo --version=1
npm run cli -- pieces demo
npm run cli -- source demo --position=2
npm run cli -- history demo
npm run cli -- export demo
```

## SQLite 持久化

默认数据库文件：

```text
data/piece-table.db
```

SQLite 同时产生 WAL 模式文件。仓储启动时会自动创建项目内 `data/` 目录。可通过环境变量改变数据库：

```powershell
$env:PT_DB="data/custom.db"
npm start
```

表结构：

- `documents`：文档 ID、原始缓冲区、累计新增缓冲区、当前版本。
- `versions`：每个版本的父版本、首选子版本、完整片段结构、操作、长度和时间。

版本片段是完整不可变快照，不是差分补丁。这样可以直接恢复任一分支版本，并保证旧片段引用的新增缓冲偏移不会因撤销或新分支失效。

## 历史与容量限制

默认限制可通过环境变量配置：

| 环境变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `PT_MAX_ORIGINAL_CODEPOINTS` | 1000000 | 初始原始缓冲区码点数 |
| `PT_MAX_DOCUMENT_CODEPOINTS` | 1000000 | 单个当前文档码点数 |
| `PT_MAX_ADDED_CODEPOINTS` | 2000000 | 单份文档累计新增缓冲区码点数 |
| `PT_MAX_VERSIONS` | 1000 | 每份文档保留的版本节点数 |
| `PT_PORT` | 0 | HTTP 端口，`0` 表示空闲端口 |
| `PT_DB` | `data/piece-table.db` | SQLite 数据库路径 |

保留策略固定为：达到版本数上限前，所有版本节点和所有新增缓冲内容都保留；达到上限后新编辑返回 `HISTORY_LIMIT_EXCEEDED`。本项目不自动删除历史、不回收新增缓冲、不压缩偏移。撤销后新编辑产生新版本号，旧分支不会被删除。

## 错误码

- `INVALID_JSON`：请求体不是 JSON 对象。
- `INVALID_UNICODE`：文本包含孤立 UTF-16 代理项等无效 Unicode。
- `INVALID_POSITION`：位置不是非负安全整数。
- `INVALID_RANGE`：读取/删除范围非法，例如起点大于终点。
- `POSITION_OUT_OF_RANGE`：插入或来源查询位置越界。
- `RANGE_OUT_OF_RANGE`：删除范围超出当前文档。
- `VERSION_CONFLICT`：请求版本不是当前版本。
- `VERSION_NOT_FOUND` / `DOCUMENT_NOT_FOUND`：目标不存在。
- `NO_HISTORY`：已到初始版本，不能撤销。
- `NO_REDO`：当前路径没有首选重做版本。
- `LIMIT_EXCEEDED` / `HISTORY_LIMIT_EXCEEDED`：容量或版本数超限。
- `CORRUPT_PIECE`：持久化片段为空、字段损坏或引用越界。

## 设计边界

- 单用户后端，没有认证授权。
- 不实现多人实时合并。
- 不实现 OT/CRDT。
- 不做全文差异计算。
- 不做光标、选择区或编辑器 UI 状态。
- 新增缓冲只追加，不做垃圾回收；这是有意的历史可回放取舍。
