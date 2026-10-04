// 演示：中文+表情混合文本，中间插入、跨原始/新增片段删除、撤销重做、撤销后新分支。
import { DocStore } from './store.js';

export async function runDemo(store: DocStore): Promise<void> {
  const p = (label: string, x: unknown) => console.log(`\n== ${label} ==\n${JSON.stringify(x)}`);
  const showPieces = (id: number) => {
    const { pt, version } = store.open(id);
    let d = 0;
    console.log(`版本 ${version} 文本: ${JSON.stringify(pt.text())}`);
    for (const piece of pt.pieces) {
      const buf = piece.source === 'original' ? pt.original : pt.add;
      const seg = buf.slice(piece.start, piece.start + piece.length).join('');
      console.log(`  [${piece.source}@${piece.start}+${piece.length}] 显示[${d},${d + piece.length}) = ${JSON.stringify(seg)}`);
      d += piece.length;
    }
  };

  const doc = store.create('演示', '你好，世界🌍！这是piece table演示。');
  p('创建文档', doc);
  showPieces(doc.id);

  // 在中间（“世界”之后）插入含表情的文本
  let info = store.insert(doc.id, 5, '美丽的🌸🌺', doc.version);
  p('中间插入 “美丽的🌸🌺”', info);
  showPieces(doc.id);

  // 跨原始与新增片段删除：从原文末尾跨到插入段
  info = store.delete(doc.id, 3, 6, info.version);
  p('跨片段删除 pos=3 len=6', info);
  showPieces(doc.id);

  p('撤销', store.undo(doc.id));
  showPieces(doc.id);
  p('重做', store.redo(doc.id));
  showPieces(doc.id);
  p('再次撤销', store.undo(doc.id));

  // 撤销后产生新分支：旧重做分支被清除，新增缓冲不回收
  info = store.insert(doc.id, 3, '【新分支✨】', store.info(doc.id).version);
  p('撤销后插入新分支', info);
  showPieces(doc.id);
  p('历史', store.history(doc.id));
  try {
    store.redo(doc.id);
  } catch (e: any) {
    p('重做（应失败，分支已清除）', { error: e.code, message: e.message });
  }
  p('导出', { text: store.open(doc.id).pt.text() });
}
