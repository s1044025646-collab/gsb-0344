// SQLite 持久化层：两个缓冲区、各版本片段结构、历史（撤销/重做）指针。
import { DatabaseSync } from 'node:sqlite';
import { PieceTable, Piece, PtError, assertValidText } from './core.js';

export const LIMITS = {
  MAX_DOC_CODEPOINTS: 1_000_000, // 当前文档最大码点数
  MAX_ADDBUF_CODEPOINTS: 5_000_000, // 新增缓冲区最大码点数（只追加，不回收）
  MAX_HISTORY: 500, // 最多保留的撤销步数（固定策略：超出后丢弃最旧的撤销记录）
};

export interface DocInfo {
  id: number;
  name: string;
  version: number;
  length: number;
  canUndo: boolean;
  canRedo: boolean;
}

export class DocStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        original TEXT NOT NULL,
        addbuf TEXT NOT NULL DEFAULT '',
        head INTEGER NOT NULL  -- 当前历史指针（history.hseq）
      );
      CREATE TABLE IF NOT EXISTS versions (
        doc_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (doc_id, version)
      );
      CREATE TABLE IF NOT EXISTS pieces (
        doc_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        source TEXT NOT NULL,
        start INTEGER NOT NULL,
        length INTEGER NOT NULL,
        PRIMARY KEY (doc_id, version, idx)
      );
      CREATE TABLE IF NOT EXISTS history (
        doc_id INTEGER NOT NULL,
        hseq INTEGER NOT NULL,   -- 单调递增的历史序号
        version INTEGER NOT NULL,
        op TEXT NOT NULL,        -- create/insert/delete/undo 目标说明
        detail TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (doc_id, hseq)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // 单事务执行；失败回滚，不推进版本也不留半成品
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private loadPieces(docId: number, version: number): Piece[] {
    const rows = this.db
      .prepare('SELECT source, start, length FROM pieces WHERE doc_id=? AND version=? ORDER BY idx')
      .all(docId, version) as unknown as Piece[];
    return rows.map((r) => ({ source: r.source, start: r.start, length: r.length }));
  }

  private currentVersion(docId: number): number {
    const row = this.db
      .prepare(
        'SELECT h.version AS v FROM docs d JOIN history h ON h.doc_id=d.id AND h.hseq=d.head WHERE d.id=?'
      )
      .get(docId) as { v: number } | undefined;
    if (!row) throw new PtError('NOT_FOUND', `文档 ${docId} 不存在`);
    return row.v;
  }

  open(docId: number): { pt: PieceTable; version: number } {
    const doc = this.db.prepare('SELECT original, addbuf FROM docs WHERE id=?').get(docId) as
      | { original: string; addbuf: string }
      | undefined;
    if (!doc) throw new PtError('NOT_FOUND', `文档 ${docId} 不存在`);
    const version = this.currentVersion(docId);
    const pt = new PieceTable(doc.original, doc.addbuf, this.loadPieces(docId, version));
    pt.validate();
    return { pt, version };
  }

  create(name: string, text: string): DocInfo {
    assertValidText(text, 'text');
    if (Array.from(text).length > LIMITS.MAX_DOC_CODEPOINTS) {
      throw new PtError('LIMIT_EXCEEDED', '初始文本超过文档大小限制');
    }
    const id = this.tx(() => {
      const r = this.db
        .prepare('INSERT INTO docs (name, original, addbuf, head) VALUES (?, ?, \'\', 0)')
        .run(name, text);
      const newId = Number(r.lastInsertRowid);
      this.persistVersion(newId, 0, new PieceTable(text).snapshot());
      this.db
        .prepare('INSERT INTO history (doc_id, hseq, version, op, detail) VALUES (?,0,0,\'create\',\'\')')
        .run(newId);
      return newId;
    });
    return this.info(id);
  }

  private persistVersion(docId: number, version: number, pieces: Piece[]): void {
    this.db.prepare('INSERT INTO versions (doc_id, version) VALUES (?,?)').run(docId, version);
    const stmt = this.db.prepare(
      'INSERT INTO pieces (doc_id, version, idx, source, start, length) VALUES (?,?,?,?,?,?)'
    );
    pieces.forEach((p, i) => stmt.run(docId, version, i, p.source, p.start, p.length));
  }

  private checkVersion(docId: number, expected: number | undefined): number {
    const cur = this.currentVersion(docId);
    if (expected !== undefined && expected !== cur) {
      throw new PtError('VERSION_CONFLICT', `版本冲突：期望 ${expected}，当前 ${cur}`);
    }
    return cur;
  }

  // 编辑入口：在单事务内更新新增缓冲、版本片段与历史
  private applyEdit(
    docId: number,
    expectedVersion: number | undefined,
    op: string,
    detail: string,
    mutate: (pt: PieceTable) => boolean
  ): DocInfo & { changed: boolean } {
    const result = this.tx(() => {
      this.checkVersion(docId, expectedVersion);
      const { pt } = this.open(docId);
      const changed = mutate(pt);
      if (!changed) return { changed: false };
      if (pt.length > LIMITS.MAX_DOC_CODEPOINTS) {
        throw new PtError('LIMIT_EXCEEDED', '文档大小超过限制');
      }
      if (pt.add.length > LIMITS.MAX_ADDBUF_CODEPOINTS) {
        throw new PtError('LIMIT_EXCEEDED', '新增缓冲区超过限制');
      }
      pt.validate();
      const doc = this.db.prepare('SELECT head FROM docs WHERE id=?').get(docId) as { head: number };
      const newVersion = this.nextVersion(docId);
      // 持久化新增缓冲（只追加，绝不截断）
      this.db.prepare('UPDATE docs SET addbuf=? WHERE id=?').run(pt.add.join(''), docId);
      this.persistVersion(docId, newVersion, pt.snapshot());
      // 丢弃重做分支（仅删历史指针，版本与新增缓冲保留，旧引用不会失效）
      this.db.prepare('DELETE FROM history WHERE doc_id=? AND hseq>?').run(docId, doc.head);
      const newHead = doc.head + 1;
      this.db
        .prepare('INSERT INTO history (doc_id, hseq, version, op, detail) VALUES (?,?,?,?,?)')
        .run(docId, newHead, newVersion, op, detail);
      this.db.prepare('UPDATE docs SET head=? WHERE id=?').run(newHead, docId);
      this.pruneHistory(docId);
      return { changed: true };
    });
    return { ...this.info(docId), changed: result.changed };
  }

  private nextVersion(docId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), -1) + 1 AS v FROM versions WHERE doc_id=?')
      .get(docId) as { v: number };
    return row.v;
  }

  // 固定保留策略：最多保留 MAX_HISTORY 步撤销；超出时删除最旧历史及其独占版本
  private pruneHistory(docId: number): void {
    const doc = this.db.prepare('SELECT head FROM docs WHERE id=?').get(docId) as { head: number };
    const minKeep = doc.head - LIMITS.MAX_HISTORY;
    if (minKeep <= 0) return;
    const old = this.db
      .prepare('SELECT version FROM history WHERE doc_id=? AND hseq<?')
      .all(docId, minKeep) as unknown as { version: number }[];
    this.db.prepare('DELETE FROM history WHERE doc_id=? AND hseq<?').run(docId, minKeep);
    const stillUsed = new Set(
      (this.db.prepare('SELECT version FROM history WHERE doc_id=?').all(docId) as unknown as {
        version: number;
      }[]).map((r) => r.version)
    );
    for (const { version } of old) {
      if (!stillUsed.has(version)) {
        this.db.prepare('DELETE FROM pieces WHERE doc_id=? AND version=?').run(docId, version);
        this.db.prepare('DELETE FROM versions WHERE doc_id=? AND version=?').run(docId, version);
      }
    }
  }

  insert(docId: number, pos: number, text: string, expectedVersion?: number) {
    return this.applyEdit(docId, expectedVersion, 'insert', JSON.stringify({ pos, text }), (pt) =>
      pt.insert(pos, text)
    );
  }

  delete(docId: number, pos: number, len: number, expectedVersion?: number) {
    return this.applyEdit(docId, expectedVersion, 'delete', JSON.stringify({ pos, len }), (pt) =>
      pt.delete(pos, len)
    );
  }

  private move(docId: number, delta: number): DocInfo {
    this.tx(() => {
      const doc = this.db.prepare('SELECT head FROM docs WHERE id=?').get(docId) as
        | { head: number }
        | undefined;
      if (!doc) throw new PtError('NOT_FOUND', `文档 ${docId} 不存在`);
      const target = doc.head + delta;
      const row = this.db
        .prepare('SELECT 1 AS ok FROM history WHERE doc_id=? AND hseq=?')
        .get(docId, target);
      if (!row) {
        throw new PtError(delta < 0 ? 'NO_UNDO' : 'NO_REDO', delta < 0 ? '没有可撤销的操作' : '没有可重做的操作');
      }
      this.db.prepare('UPDATE docs SET head=? WHERE id=?').run(target, docId);
    });
    return this.info(docId);
  }

  undo(docId: number): DocInfo {
    return this.move(docId, -1);
  }

  redo(docId: number): DocInfo {
    return this.move(docId, 1);
  }

  info(docId: number): DocInfo {
    const { pt, version } = this.open(docId);
    const doc = this.db.prepare('SELECT name, head FROM docs WHERE id=?').get(docId) as {
      name: string;
      head: number;
    };
    const has = (hseq: number) =>
      !!this.db.prepare('SELECT 1 AS x FROM history WHERE doc_id=? AND hseq=?').get(docId, hseq);
    return {
      id: docId,
      name: doc.name,
      version,
      length: pt.length,
      canUndo: has(doc.head - 1),
      canRedo: has(doc.head + 1),
    };
  }

  history(docId: number) {
    const doc = this.db.prepare('SELECT head FROM docs WHERE id=?').get(docId) as
      | { head: number }
      | undefined;
    if (!doc) throw new PtError('NOT_FOUND', `文档 ${docId} 不存在`);
    const rows = this.db
      .prepare('SELECT hseq, version, op, detail FROM history WHERE doc_id=? ORDER BY hseq')
      .all(docId) as unknown as { hseq: number; version: number; op: string; detail: string }[];
    return { head: doc.head, entries: rows };
  }

  list(): DocInfo[] {
    const ids = this.db.prepare('SELECT id FROM docs ORDER BY id').all() as unknown as {
      id: number;
    }[];
    return ids.map((r) => this.info(r.id));
  }
}
