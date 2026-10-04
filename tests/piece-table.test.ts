import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  applyOperation,
  codePointLength,
  initialPieces,
  locatePosition,
  materialize,
  reportPieces,
} from '../src/core.js';
import { DocumentStore } from '../src/store.js';
import type { EditOperation, Piece } from '../src/types.js';

function refEdit(text: string[], operation: EditOperation): string[] {
  if (operation.type === 'insert') return [...text.slice(0, operation.position), ...Array.from(operation.text), ...text.slice(operation.position)];
  return [...text.slice(0, operation.start), ...text.slice(operation.end)];
}

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'piece-table-'));
  dbPath = join(directory, 'test.db');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('纯核心固定编辑与码点参考模型一致', () => {
  const original = '你好😀ABC\r\n世界';
  let added = '';
  let pieces: Piece[] = initialPieces(original);
  let reference = Array.from(original);
  const operations: EditOperation[] = [
    { type: 'insert', position: 4, text: '插入😎' },
    { type: 'insert', position: 0, text: '开头' },
    { type: 'insert', position: codePointLength(materialize(original, added, pieces)), text: '文末' },
    { type: 'delete', start: 2, end: 10 },
    { type: 'delete', start: 0, end: 2 },
    { type: 'insert', position: 3, text: 'x' },
    { type: 'delete', start: 0, end: 8 },
  ];

  for (const operation of operations) {
    const result = applyOperation(original, added, pieces, operation);
    added = result.added;
    pieces = result.pieces;
    reference = refEdit(reference, operation);
    const actual = materialize(original, added, pieces);
    assert.equal(actual, reference.join(''));
    assert.equal(codePointLength(actual), reference.length);
    const reports = reportPieces(original, added, pieces);
    assert.equal(reports.map((piece) => piece.text).join(''), actual);
    assert.ok(reports.every((piece) => piece.length > 0));
    if (reports.length > 0) assert.equal(reports[0].displayStart, 0);
    for (let index = 1; index < reports.length; index += 1) {
      assert.equal(reports[index].displayStart, reports[index - 1].displayEnd);
    }
  }
});

test('表情按 Unicode 码点计位，CRLF 和组合字符原样保留', () => {
  const text = 'a😀e\u0301\r\n';
  let pieces = initialPieces(text);
  let added = '';
  const result = applyOperation(text, added, pieces, { type: 'insert', position: 2, text: '中' });
  pieces = result.pieces;
  added = result.added;
  assert.equal(materialize(text, added, pieces), 'a😀中e\u0301\r\n');
  assert.equal(locatePosition(text, added, pieces, 0).codePoint, 'a');
  assert.equal(locatePosition(text, added, pieces, 1).codePoint, '😀');
  assert.equal(locatePosition(text, added, pieces, 3).codePoint, 'e');
  assert.equal(locatePosition(text, added, pieces, 4).codePoint, '\u0301');
  assert.equal(locatePosition(text, added, pieces, 5).codePoint, '\r');
});

test('相同文字但不相邻来源不会误合并', () => {
  const original = 'AB';
  let pieces = initialPieces(original);
  let added = '';
  let result = applyOperation(original, added, pieces, { type: 'insert', position: 1, text: 'X' });
  pieces = result.pieces;
  added = result.added;
  result = applyOperation(original, added, pieces, { type: 'insert', position: 0, text: 'X' });
  pieces = result.pieces;
  added = result.added;
  assert.equal(materialize(original, added, pieces), 'XAXB');
  assert.deepEqual(pieces, [
    { source: 'added', start: 1, length: 1 },
    { source: 'original', start: 0, length: 1 },
    { source: 'added', start: 0, length: 1 },
    { source: 'original', start: 1, length: 1 },
  ]);
});

test('SQLite 编辑、撤销重做、新分支和重启一致', () => {
  let store = new DocumentStore(dbPath, {
    maxOriginalCodePoints: 1000,
    maxDocumentCodePoints: 1000,
    maxAddedCodePoints: 1000,
    maxVersionsPerDocument: 100,
  });
  store.createDocument('你好😀ABC世界', 'doc');
  let doc = store.edit('doc', 0, { type: 'insert', position: 4, text: '插入😎' });
  assert.equal(doc.text, '你好😀A插入😎BC世界');
  doc = store.edit('doc', 1, { type: 'delete', start: 2, end: 8 });
  assert.equal(doc.text, '你好C世界');
  assert.equal(store.undo('doc', 2).text, '你好😀A插入😎BC世界');
  assert.equal(store.redo('doc', 1).text, '你好C世界');
  assert.equal(store.undo('doc', 2).text, '你好😀A插入😎BC世界');
  doc = store.edit('doc', 1, { type: 'insert', position: 1, text: '新' });
  assert.equal(doc.text, '你新好😀A插入😎BC世界');
  assert.equal(doc.version, 3);
  assert.throws(() => store.redo('doc', 3), (error: Error & { code?: string }) => error.code === 'NO_REDO');
  const piecesBeforeClose = store.pieces('doc');
  const historyBeforeClose = store.history('doc');
  store.close();

  store = new DocumentStore(dbPath);
  assert.equal(store.get('doc').text, '你新好😀A插入😎BC世界');
  assert.deepEqual(store.pieces('doc'), piecesBeforeClose);
  assert.deepEqual(store.history('doc'), historyBeforeClose);
  assert.equal(store.undo('doc', 3).text, '你好😀A插入😎BC世界');
  assert.equal(store.redo('doc', 1).text, '你新好😀A插入😎BC世界');
  const continued = store.edit('doc', 3, { type: 'insert', position: 0, text: '续' });
  assert.equal(continued.text, '续你新好😀A插入😎BC世界');
  store.close();
});

test('空操作不产生历史，过期版本冲突且不部分应用', () => {
  const store = new DocumentStore(dbPath);
  store.createDocument('abc', 'noop');
  const emptyInsert = store.edit('noop', 0, { type: 'insert', position: 0, text: '' });
  assert.equal(emptyInsert.version, 0);
  assert.equal(emptyInsert.changed, false);
  const emptyDelete = store.edit('noop', 0, { type: 'delete', start: 1, end: 1 });
  assert.equal(emptyDelete.version, 0);
  assert.equal(store.history('noop').length, 1);
  store.edit('noop', 0, { type: 'insert', position: 0, text: 'x' });
  assert.throws(() => store.edit('noop', 0, { type: 'insert', position: 0, text: 'y' }), (error: Error & { code?: string }) => error.code === 'VERSION_CONFLICT');
  assert.equal(store.get('noop').text, 'xabc');
  store.close();
});

test('首尾插入、删空、连续删除和非法范围返回明确错误', () => {
  const store = new DocumentStore(dbPath);
  store.createDocument('ABC😀', 'edges');
  assert.equal(store.edit('edges', 0, { type: 'insert', position: 0, text: '[' }).text, '[ABC😀');
  assert.equal(store.edit('edges', 1, { type: 'insert', position: 5, text: ']' }).text, '[ABC😀]');
  assert.equal(store.edit('edges', 2, { type: 'delete', start: 0, end: 6 }).text, '');
  assert.equal(store.pieces('edges').length, 0);
  assert.equal(store.edit('edges', 3, { type: 'insert', position: 0, text: '再来' }).text, '再来');
  assert.equal(store.edit('edges', 4, { type: 'delete', start: 0, end: 1 }).text, '来');
  assert.equal(store.edit('edges', 5, { type: 'delete', start: 0, end: 1 }).text, '');
  assert.throws(() => store.edit('edges', 6, { type: 'delete', start: 1, end: 0 }), (error: Error & { code?: string }) => error.code === 'INVALID_RANGE');
  assert.throws(() => store.edit('edges', 6, { type: 'delete', start: 0, end: 9 }), (error: Error & { code?: string }) => error.code === 'RANGE_OUT_OF_RANGE');
  assert.throws(() => store.edit('edges', 6, { type: 'insert', position: -1, text: 'x' }), (error: Error & { code?: string }) => error.code === 'INVALID_POSITION');
  store.close();
});
