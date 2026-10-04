import { rmSync } from 'node:fs';
import { DocumentStore } from './store.js';

const dbPath = process.env.PT_DEMO_DB ?? 'data/demo.db';
try {
  rmSync(dbPath, { force: true });
} catch {
  // Windows 上旧 WAL 文件可能被外部短暂占用；新数据库仍会由 SQLite 初始化。
}

const store = new DocumentStore(dbPath);

function show(title: string, snapshot: { version: number; text: string; length: number; pieces: unknown[] }): void {
  console.log(`\n=== ${title} ===`);
  console.log(`v${snapshot.version} 长度=${snapshot.length} 文本=${JSON.stringify(snapshot.text)}`);
  console.table(snapshot.pieces.map((piece) => piece as Record<string, unknown>));
}

try {
  let doc = store.createDocument('你好😀ABC世界', 'demo');
  show('创建：中文 + 表情 + 英文', doc);

  doc = store.edit('demo', 0, { type: 'insert', position: 4, text: '插入😎' });
  show('在中间插入：片段分裂并引用新增缓冲', doc);

  doc = store.edit('demo', 1, { type: 'delete', start: 2, end: 8 });
  show('跨原始与新增片段删除：只改引用不重写缓冲', doc);

  const undone = store.undo('demo', 2);
  show('撤销删除：恢复前一片段结构', undone);

  const redone = store.redo('demo', 1);
  show('重做删除：回到删除后版本', redone);

  const undoneAgain = store.undo('demo', 2);
  show('再次撤销：准备创建新分支', undoneAgain);

  const branched = store.edit('demo', 1, { type: 'insert', position: 1, text: '新' });
  show('撤销后新编辑：旧重做分支保留但不再是首选路径', branched);

  try {
    store.redo('demo', branched.version);
  } catch (error) {
    console.log('\n新分支末端无重做:', (error as Error).message);
  }

  console.log('\n来源位置 1:', JSON.stringify(store.source('demo', 1)));
  console.log('历史:', JSON.stringify(store.history('demo'), null, 2));
} finally {
  store.close();
}
