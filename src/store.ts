import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  applyOperation,
  codePointLength,
  documentLength,
  initialPieces,
  isValidUnicodeText,
  locatePosition,
  materialize,
  normalizeDelete,
  normalizeInsert,
  readRange,
  reportPieces,
  validatePieces,
} from './core.js';
import { ApiError } from './types.js';
import type {
  DocumentSnapshot,
  EditOperation,
  Limits,
  Piece,
  PieceReport,
  VersionRecord,
} from './types.js';

interface DocumentRow {
  id: string;
  original: string;
  added: string;
  current_version: number;
}

interface VersionRow {
  document_id: string;
  version: number;
  parent_version: number | null;
  preferred_child_version: number | null;
  pieces: string;
  operation: string | null;
  length: number;
  created_at: string;
}

export const defaultLimits: Limits = {
  maxOriginalCodePoints: Number(process.env.PT_MAX_ORIGINAL_CODEPOINTS ?? 1_000_000),
  maxDocumentCodePoints: Number(process.env.PT_MAX_DOCUMENT_CODEPOINTS ?? 1_000_000),
  maxAddedCodePoints: Number(process.env.PT_MAX_ADDED_CODEPOINTS ?? 2_000_000),
  maxVersionsPerDocument: Number(process.env.PT_MAX_VERSIONS ?? 1000),
};

export class DocumentStore {
  private readonly db: DatabaseType;

  constructor(path = 'data/piece-table.db', private readonly limits: Limits = defaultLimits) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        original TEXT NOT NULL,
        added TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS versions (
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version INTEGER,
        preferred_child_version INTEGER,
        pieces TEXT NOT NULL,
        operation TEXT,
        length INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (document_id, version),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );
    `);
  }

  createDocument(input: unknown = '', requestedId?: unknown): DocumentSnapshot {
    const text = input ?? '';
    if (!isValidUnicodeText(text)) throw new ApiError('INVALID_UNICODE', '初始文本必须是有效 Unicode 文本');
    const id = requestedId === undefined ? randomUUID() : String(requestedId);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      throw new ApiError('INVALID_DOCUMENT_ID', '文档 ID 只能包含字母、数字、下划线或短横线，长度 1-80');
    }
    const length = codePointLength(text);
    if (length > this.limits.maxOriginalCodePoints) throw new ApiError('LIMIT_EXCEEDED', '原始缓冲区超过大小限制');
    const pieces = initialPieces(text);
    const transaction = this.db.transaction(() => {
      try {
        this.db.prepare(
          `INSERT INTO documents (id, original, added, current_version) VALUES (?, ?, '', 0)`,
        ).run(id, text);
        this.db.prepare(
          `INSERT INTO versions (document_id, version, parent_version, preferred_child_version, pieces, operation, length)
           VALUES (?, 0, NULL, NULL, ?, NULL, ?)`,
        ).run(id, JSON.stringify(pieces), length);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
          throw new ApiError('DOCUMENT_EXISTS', '文档 ID 已存在', 409);
        }
        throw error;
      }
    });
    transaction();
    return this.snapshot(id, 0, text, '', pieces);
  }

  edit(id: string, expectedVersion: unknown, operationInput: EditOperation): DocumentSnapshot & { changed: boolean } {
    const expected = this.requireVersion(expectedVersion);
    return this.withLockedDocument(id, (doc) => {
      if (doc.current_version !== expected) {
        throw new ApiError('VERSION_CONFLICT', `版本已过期，当前版本为 ${doc.current_version}`, 409);
      }
      const current = this.getVersionRow(id, doc.current_version);
      const pieces = this.parsePieces(current.pieces);
      const currentLength = documentLength(pieces);
      const normalized =
        operationInput.type === 'insert'
          ? normalizeInsert(operationInput.position, operationInput.text, currentLength)
          : normalizeDelete(operationInput.start, operationInput.end, currentLength);
      if (!normalized) {
        return { ...this.snapshot(id, doc.current_version, doc.original, doc.added, pieces), changed: false };
      }
      const result = applyOperation(doc.original, doc.added, pieces, normalized);
      validatePieces(doc.original, result.added, result.pieces);
      const nextLength = documentLength(result.pieces);
      const oldAddedLength = codePointLength(doc.added);
      const newAddedLength = codePointLength(result.added);
      if (nextLength > this.limits.maxDocumentCodePoints) throw new ApiError('LIMIT_EXCEEDED', '文档超过码点大小限制');
      if (newAddedLength > this.limits.maxAddedCodePoints) throw new ApiError('LIMIT_EXCEEDED', '新增缓冲区超过大小限制');
      const versionCount = this.db.prepare('SELECT COUNT(*) AS count FROM versions WHERE document_id = ?').get(id) as { count: number };
      if (versionCount.count >= this.limits.maxVersionsPerDocument) {
        throw new ApiError('HISTORY_LIMIT_EXCEEDED', '文档历史版本数超过限制');
      }
      const nextVersion = (this.db
        .prepare('SELECT COALESCE(MAX(version), -1) + 1 AS next FROM versions WHERE document_id = ?')
        .get(id) as { next: number }).next;
      const createdAt = new Date().toISOString();
      this.db.prepare('UPDATE documents SET added = ?, current_version = ? WHERE id = ?').run(result.added, nextVersion, id);
      this.db.prepare(
        `INSERT INTO versions (document_id, version, parent_version, preferred_child_version, pieces, operation, length, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
      ).run(id, nextVersion, doc.current_version, JSON.stringify(result.pieces), JSON.stringify(normalized), nextLength, createdAt);
      this.db.prepare('UPDATE versions SET preferred_child_version = ? WHERE document_id = ? AND version = ?').run(nextVersion, id, doc.current_version);
      if (newAddedLength < oldAddedLength) throw new ApiError('INTERNAL_ERROR', '新增缓冲区只能追加');
      return { ...this.snapshot(id, nextVersion, doc.original, result.added, result.pieces), changed: true };
    });
  }

  undo(id: string, expectedVersion: unknown): DocumentSnapshot {
    const expected = this.requireVersion(expectedVersion);
    return this.withLockedDocument(id, (doc) => {
      if (doc.current_version !== expected) throw new ApiError('VERSION_CONFLICT', `版本已过期，当前版本为 ${doc.current_version}`, 409);
      const current = this.getVersionRow(id, doc.current_version);
      if (current.parent_version === null) throw new ApiError('NO_HISTORY', '没有可撤销的历史记录', 409);
      const parent = this.getVersionRow(id, current.parent_version);
      this.db.prepare('UPDATE documents SET current_version = ? WHERE id = ?').run(parent.version, id);
      return this.snapshotFromRow(doc.original, doc.added, parent);
    });
  }

  redo(id: string, expectedVersion: unknown): DocumentSnapshot {
    const expected = this.requireVersion(expectedVersion);
    return this.withLockedDocument(id, (doc) => {
      if (doc.current_version !== expected) throw new ApiError('VERSION_CONFLICT', `版本已过期，当前版本为 ${doc.current_version}`, 409);
      const current = this.getVersionRow(id, doc.current_version);
      if (current.preferred_child_version === null) throw new ApiError('NO_REDO', '没有可重做的编辑', 409);
      const child = this.getVersionRow(id, current.preferred_child_version);
      this.db.prepare('UPDATE documents SET current_version = ? WHERE id = ?').run(child.version, id);
      return this.snapshotFromRow(doc.original, doc.added, child);
    });
  }

  get(id: string): DocumentSnapshot {
    const doc = this.requireDocument(id);
    return this.snapshotFromDocument(doc);
  }

  read(id: string, start: unknown, end: unknown): { text: string; start: number; end: number } {
    const doc = this.requireDocument(id);
    const pieces = this.parsePieces(this.getVersionRow(id, doc.current_version).pieces);
    const text = readRange(doc.original, doc.added, pieces, Number(start), Number(end));
    return { text, start: Number(start), end: Number(end) };
  }

  pieces(id: string): PieceReport[] {
    const doc = this.requireDocument(id);
    return reportPieces(doc.original, doc.added, this.parsePieces(this.getVersionRow(id, doc.current_version).pieces));
  }

  source(id: string, position: unknown) {
    const doc = this.requireDocument(id);
    const pieces = this.parsePieces(this.getVersionRow(id, doc.current_version).pieces);
    return locatePosition(doc.original, doc.added, pieces, Number(position));
  }

  history(id: string): VersionRecord[] {
    this.requireDocument(id);
    const rows = this.db.prepare('SELECT * FROM versions WHERE document_id = ? ORDER BY version').all(id) as VersionRow[];
    const doc = this.requireDocument(id);
    const ancestors = new Set<number>();
    let row: VersionRow | undefined = this.getVersionRow(id, doc.current_version);
    while (row) {
      ancestors.add(row.version);
      row = row.parent_version === null ? undefined : this.getVersionRow(id, row.parent_version);
    }
    const future = new Set<number>();
    let nextVersion: number | null = this.getVersionRow(id, doc.current_version).preferred_child_version;
    while (nextVersion !== null) {
      future.add(nextVersion);
      const nextRow = this.getVersionRow(id, nextVersion);
      nextVersion = nextRow.preferred_child_version;
    }
    return rows.map((item) => ({
      version: item.version,
      parentVersion: item.parent_version,
      operation: item.operation === null ? null : (JSON.parse(item.operation) as EditOperation),
      length: item.length,
      createdAt: item.created_at,
      onCurrentLineage: ancestors.has(item.version) || future.has(item.version),
    }));
  }

  export(id: string): { text: string; version: number; length: number } {
    const snapshot = this.get(id);
    return { text: snapshot.text, version: snapshot.version, length: snapshot.length };
  }

  private withLockedDocument<T>(id: string, action: (doc: DocumentRow) => T): T {
    const transaction = this.db.transaction(() => {
      const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
      if (!doc) throw new ApiError('DOCUMENT_NOT_FOUND', '文档不存在', 404);
      return action(doc);
    });
    return transaction.immediate();
  }

  private requireDocument(id: string): DocumentRow {
    const doc = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    if (!doc) throw new ApiError('DOCUMENT_NOT_FOUND', '文档不存在', 404);
    return doc;
  }

  private getVersionRow(id: string, version: number): VersionRow {
    const row = this.db.prepare('SELECT * FROM versions WHERE document_id = ? AND version = ?').get(id, version) as VersionRow | undefined;
    if (!row) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404);
    return row;
  }

  private requireVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new ApiError('INVALID_VERSION', 'version 必须是非负安全整数');
    }
    return value;
  }

  private parsePieces(value: string): Piece[] {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new ApiError('CORRUPT_PIECE', '片段数据损坏');
    return parsed.map((item, index) => {
      const piece = item as Partial<Piece>;
      if ((piece.source !== 'original' && piece.source !== 'added') || typeof piece.start !== 'number' || typeof piece.length !== 'number') {
        throw new ApiError('CORRUPT_PIECE', `第 ${index} 个片段数据损坏`);
      }
      return { source: piece.source, start: piece.start, length: piece.length };
    });
  }

  private snapshotFromDocument(doc: DocumentRow): DocumentSnapshot {
    const row = this.getVersionRow(doc.id, doc.current_version);
    return this.snapshotFromRow(doc.original, doc.added, row);
  }

  private snapshotFromRow(original: string, added: string, row: VersionRow): DocumentSnapshot {
    return this.snapshot(row.document_id, row.version, original, added, this.parsePieces(row.pieces));
  }

  private snapshot(id: string, version: number, original: string, added: string, pieces: Piece[]): DocumentSnapshot {
    validatePieces(original, added, pieces);
    const text = materialize(original, added, pieces);
    const snapshot: DocumentSnapshot = {
      id,
      version,
      text,
      length: codePointLength(text),
      pieces: reportPieces(original, added, pieces),
    };
    return snapshot;
  }
}
