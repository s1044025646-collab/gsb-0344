import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PieceTable, PtError } from '../src/core.js';
import { DocStore } from '../src/store.js';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pt-')), 'test.db');
}

// 简单参考模型：直接操作码点数组
class RefModel {
  cps: string[];
  constructor(s: string) {
    this.cps = Array.from(s);
  }
  insert(pos: number, t: string) {
    this.cps.splice(pos, 0, ...Array.from(t));
  }
  delete(pos: number, len: number) {
    this.cps.splice(pos, len);
  }
  text() {
    return this.cps.join('');
  }
}

// 独立逐片段拼接核对来源
function materializeFromPieces(pt: PieceTable): string {
  let out = '';
  for (const p of pt.pieces) {
    const buf = p.source === 'original' ? pt.original : pt.add;
    out += buf.slice(p.start, p.start + p.length).join('');
  }
  return out;
}

function checkInvariants(pt: PieceTable, expected: string) {
  pt.validate();
  assert.equal(pt.text(), expected);
  assert.equal(materializeFromPieces(pt), expected);
  assert.equal(pt.length, Array.from(expected).length);
  for (const p of pt.pieces) assert.ok(p.length > 0, '无空片段');
}

test('固定编辑序列 vs 参考模型（含中文与表情）', () => {
  const base = '你好，世界🌍！abcdef漢字🎉🎊';
  const pt = new PieceTable(base);
  const ref = new RefModel(base);
  const ops: Array<() => void> = [
    () => { pt.insert(0, '头部'); ref.insert(0, '头部'); },
    () => { pt.insert(pt.length, '尾部🚀'); ref.insert(ref.cps.length, '尾部🚀'); },
    () => { pt.insert(7, '中间🌸'); ref.insert(7, '中间🌸'); },
    () => { pt.delete(0, 2); ref.delete(0, 2); },
    () => { pt.delete(5, 10); ref.delete(5, 10); }, // 跨多个片段
    () => { pt.delete(3, 1); ref.delete(3, 1); },   // 连续删除
    () => { pt.delete(2, 1); ref.delete(2, 1); },
    () => { pt.insert(4, '🎉🎉🎉'); ref.insert(4, '🎉🎉🎉'); },
    () => { pt.delete(pt.length - 3, 3); ref.delete(ref.cps.length - 3, 3); },
    () => { pt.insert(1, 'é组合é'); ref.insert(1, 'é组合é'); },
  ];
  for (const op of ops) {
    op();
    checkInvariants(pt, ref.text());
  }
});

test('首尾插入与文末插入', () => {
  const pt = new PieceTable('中');
  pt.insert(0, '前');
  pt.insert(2, '后');
  checkInvariants(pt, '前中后');
});

test('空文档语义', () => {
  const pt = new PieceTable('');
  assert.equal(pt.length, 0);
  assert.equal(pt.text(), '');
  pt.insert(0, '字');
  checkInvariants(pt, '字');
  pt.delete(0, 1);
  checkInvariants(pt, '');
});

test('空插入与零长度删除不变化', () => {
  const pt = new PieceTable('abc');
  assert.equal(pt.insert(1, ''), false);
  assert.equal(pt.delete(1, 0), false);
  checkInvariants(pt, 'abc');
});

test('CRLF 原样保留', () => {
  const pt = new PieceTable('a\r\nb\nc');
  assert.equal(pt.length, 6);
  pt.insert(3, 'X');
  checkInvariants(pt, 'a\r\nXb\nc');
  assert.equal(pt.slice(0, 3), 'a\r\n');
});

test('表情按码点计数（非 UTF-16 单元）', () => {
  const pt = new PieceTable('a🌍b');
  assert.equal(pt.length, 3);
  pt.insert(2, 'X');
  checkInvariants(pt, 'a🌍Xb');
  pt.delete(1, 1);
  checkInvariants(pt, 'aXb');
});

test('越界与非法参数', () => {
  const pt = new PieceTable('abc');
  assert.throws(() => pt.insert(4, 'x'), (e: any) => e.code === 'INVALID_POSITION');
  assert.throws(() => pt.insert(-1, 'x'), (e: any) => e.code === 'INVALID_POSITION');
  assert.throws(() => pt.insert(1.5, 'x'), (e: any) => e.code === 'INVALID_POSITION');
  assert.throws(() => pt.delete(2, 5), (e: any) => e.code === 'INVALID_RANGE');
  assert.throws(() => pt.locate(3), (e: any) => e.code === 'INVALID_POSITION');
  assert.throws(() => pt.insert(0, '孤\uD800立'), (e: any) => e.code === 'INVALID_TEXT');
});

test('locate 来源解释', () => {
  const pt = new PieceTable('原始文本');
  pt.insert(2, '新增');
  const a = pt.locate(0);
  assert.equal(a.piece.source, 'original');
  const b = pt.locate(2);
  assert.equal(b.piece.source, 'add');
  assert.equal(b.offsetInPiece, 0);
  const c = pt.locate(4);
  assert.equal(c.piece.source, 'original');
});

test('相邻同来源连续片段合并，不同来源不误并', () => {
  const pt = new PieceTable('ab');
  pt.insert(2, 'CD');
  pt.insert(4, 'EF'); // 与上一段在 add 缓冲连续，应合并
  const addPieces = pt.pieces.filter((p) => p.source === 'add');
  assert.equal(addPieces.length, 1);
  assert.equal(addPieces[0].length, 4);
  // 删除中间制造两个 original 片段，中间夹 add，不应合并
  pt.insert(1, 'X');
  const orig = pt.pieces.filter((p) => p.source === 'original');
  assert.ok(orig.length >= 1);
  checkInvariants(pt, 'aXbCDEF');
});

test('持久化：编辑、撤销、重做、新分支、重启后继续', () => {
  const db = tmpDb();
  let store = new DocStore(db);
  const doc = store.create('t', '你好🌍世界');
  let info = store.insert(doc.id, 3, '插入🌸', doc.version);
  info = store.delete(doc.id, 0, 6, info.version);
  assert.equal(store.open(doc.id).pt.text(), '世界');
  store.undo(doc.id);
  assert.equal(store.open(doc.id).pt.text(), '你好🌍插入🌸世界');
  store.redo(doc.id);
  assert.equal(store.open(doc.id).pt.text(), '世界');
  store.undo(doc.id);
  // 撤销后新分支
  info = store.insert(doc.id, 0, '新分支', store.info(doc.id).version);
  assert.throws(() => store.redo(doc.id), (e: any) => e.code === 'NO_REDO');
  const textBefore = store.open(doc.id).pt.text();
  const verBefore = store.info(doc.id).version;
  store.close();

  // 重启：继续编辑与不中断运行一致
  store = new DocStore(db);
  const reopened = store.open(doc.id);
  assert.equal(reopened.pt.text(), textBefore);
  assert.equal(reopened.version, verBefore);
  // 重启后仍可撤销（历史指针已持久化）
  store.undo(doc.id);
  assert.equal(store.open(doc.id).pt.text(), '你好🌍插入🌸世界');
  store.redo(doc.id);
  assert.equal(store.open(doc.id).pt.text(), textBefore);
  // 重启后继续编辑
  const i2 = store.insert(doc.id, 0, '重启后', store.info(doc.id).version);
  assert.equal(store.open(doc.id).pt.text(), '重启后' + textBefore);
  assert.ok(i2.version > verBefore);
  store.close();
});

test('版本冲突不部分应用', () => {
  const db = tmpDb();
  const store = new DocStore(db);
  const doc = store.create('t', 'abc');
  store.insert(doc.id, 0, 'X', doc.version);
  assert.throws(() => store.insert(doc.id, 0, 'Y', doc.version), (e: any) => e.code === 'VERSION_CONFLICT');
  assert.equal(store.open(doc.id).pt.text(), 'Xabc'); // 未部分应用
  assert.throws(() => store.delete(doc.id, 0, 1, 999), (e: any) => e.code === 'VERSION_CONFLICT');
  store.close();
});

test('失败编辑不推进版本、不留越界片段', () => {
  const db = tmpDb();
  const store = new DocStore(db);
  const doc = store.create('t', 'abc');
  const v0 = store.info(doc.id).version;
  assert.throws(() => store.delete(doc.id, 1, 10));
  assert.throws(() => store.insert(doc.id, 99, 'x'));
  assert.equal(store.info(doc.id).version, v0);
  store.open(doc.id).pt.validate();
  store.close();
});

test('空插入/零删除不产生历史记录', () => {
  const db = tmpDb();
  const store = new DocStore(db);
  const doc = store.create('t', 'abc');
  const h0 = store.history(doc.id).entries.length;
  const r1 = store.insert(doc.id, 1, '');
  const r2 = store.delete(doc.id, 1, 0);
  assert.equal(r1.changed, false);
  assert.equal(r2.changed, false);
  assert.equal(store.history(doc.id).entries.length, h0);
  store.close();
});

test('undo/redo 边界', () => {
  const db = tmpDb();
  const store = new DocStore(db);
  const doc = store.create('t', 'x');
  assert.throws(() => store.undo(doc.id), (e: any) => e.code === 'NO_UNDO');
  store.insert(doc.id, 1, 'y');
  store.undo(doc.id);
  assert.throws(() => store.undo(doc.id), (e: any) => e.code === 'NO_UNDO');
  store.redo(doc.id);
  assert.equal(store.open(doc.id).pt.text(), 'xy');
  assert.throws(() => store.redo(doc.id), (e: any) => e.code === 'NO_REDO');
  store.close();
});

test('读取区间与导出', () => {
  const db = tmpDb();
  const store = new DocStore(db);
  const doc = store.create('t', '一二三四五');
  const { pt } = store.open(doc.id);
  assert.equal(pt.slice(1, 2), '二三');
  assert.throws(() => pt.slice(4, 5), (e: any) => e.code === 'INVALID_RANGE');
  store.close();
});
