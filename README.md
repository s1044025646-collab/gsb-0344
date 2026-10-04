# Piece Table 文本编辑与来源片段回放后端

单用户文本编辑核心，仅提供 HTTP API 与 CLI（无网页）。使用 TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生依赖、无外部服务），Windows 本地直接运行。

## 核心设计

- 每份文档包含：**不可变原始缓冲区**、**只追加新增缓冲区**、按显示顺序引用两者的**片段表**（piece table）。
- 插入：文本追加到新增缓冲区，必要时分裂原片段；删除：只改片段引用，不改写任何缓冲区。
- 相邻且来自**同一缓冲区物理连续区间**的片段才合并，绝不因文字相同误并。
- 所有位置一律按 **Unicode 码点**计数（不是 UTF-16 单元、不是 UTF-8 字节）。例如 `🌍` 算 1 个位置。
- **注意**：码点 ≠ 用户感知字符。组合字符（如 `e` + ́）的多个码点仍按多个位置计算；本系统不做字素簇（grapheme cluster）切分。
- 换行符原样保留，不规范化 CRLF，不规范化 Unicode 组合字符。
- 撤销/重做按版本恢复片段结构；撤销后新编辑会清除旧重做分支（仅删历史指针），**新增缓冲区和旧版本片段永不回收**，旧引用不会失效。
- 空字符串插入、零长度删除为无操作，**不产生历史记录**（固定策略）。
- 编辑可携带期望版本号，过期版本返回 `VERSION_CONFLICT`（HTTP 409），不部分应用。

## 持久化

SQLite 保存：两个缓冲区、每个版本的完整片段结构、历史表（`hseq` 单调递增）与当前历史指针 `head`。每次编辑在**单个事务**内提交；失败回滚，不推进版本、不留越界片段。重启后可继续编辑、撤销与重做。

历史保留策略（固定）：最多保留 500 步撤销，超出时丢弃最旧历史及其独占版本；新增缓冲区永不压缩。

## 大小限制

| 限制 | 值 |
| --- | --- |
| 文档当前长度 | 1,000,000 码点 |
| 新增缓冲区累计 | 5,000,000 码点 |
| 撤销历史 | 500 步 |

## 错误码

`INVALID_POSITION`（位置非非负整数或越界）、`INVALID_RANGE`（删除/读取范围越界）、`INVALID_TEXT`（非字符串或含孤立代理项）、`VERSION_CONFLICT`、`NOT_FOUND`、`NO_UNDO`、`NO_REDO`、`LIMIT_EXCEEDED`。

## 命令

```bat
npm install
npm run build     :: 编译到 dist/
npm test          :: 构建并运行全部测试
npm start         :: 启动 API（默认选择空闲端口）
npm run demo      :: 运行中文+表情演示（插入/跨片段删除/撤销重做/新分支）
```

CLI（数据默认存于项目内 `data/piecetable.db`，可用 `--db` 覆盖）：

```bat
node dist\src\cli.js create --name 文档 --text "你好🌍"
node dist\src\cli.js insert 1 --pos 2 --text "X" --version 0
node dist\src\cli.js delete 1 --pos 0 --len 1
node dist\src\cli.js read 1 --start 0 --len 5
node dist\src\cli.js pieces 1
node dist\src\cli.js locate 1 --pos 2
node dist\src\cli.js undo 1 & node dist\src\cli.js redo 1
node dist\src\cli.js history 1
node dist\src\cli.js export 1
node dist\src\cli.js serve --port 8080
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/docs` `{name, text}` | 创建文档 |
| GET | `/docs` | 列出文档 |
| GET | `/docs/:id/text?start=&len=` | 读取区间（码点） |
| POST | `/docs/:id/insert` `{pos, text, version?}` | 插入 |
| POST | `/docs/:id/delete` `{pos, len, version?}` | 删除 |
| POST | `/docs/:id/undo` `/redo` | 撤销 / 重做 |
| GET | `/docs/:id/pieces` | 片段表（来源、起点、长度、显示区间） |
| GET | `/docs/:id/locate?pos=` | 某显示位置来自哪个缓冲区哪段 |
| GET | `/docs/:id/history` | 历史与当前指针 |
| GET | `/docs/:id/export` | 物化导出全文 |
| GET | `/limits` | 大小限制 |

## 测试

`test/core.test.ts` 覆盖：固定编辑序列对照码点数组参考模型并逐片段独立拼接核对；首尾/文末插入、空文档、空插入与零删除、跨多片段删除、连续删除、表情位置、CRLF 保留、越界与非法参数、过期版本冲突、失败不推进版本、undo/redo 边界、重启后继续编辑与撤销重做。`test/api.smoke.mjs` 为 API 冒烟脚本。

## 限制

- 单用户、单进程；版本号冲突检测不是多人实时合并。
- 位置按码点而非字素簇，与视觉光标位置可能不同。
- 新增缓冲区只增不减，长期大量编辑会累积（受上限保护）。
