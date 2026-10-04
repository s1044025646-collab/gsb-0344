import { ApiError } from './types.js';
import type { EditOperation, Piece, PieceReport, SourceLocation } from './types.js';

export function isValidUnicodeText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; ) {
    const code = value.codePointAt(index);
    if (code === undefined) return false;
    if (code >= 0xd800 && code <= 0xdfff) return false;
    index += code > 0xffff ? 2 : 1;
  }
  return true;
}

export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

export function codePointSlice(text: string, start: number, end: number = codePointLength(text)): string {
  return Array.from(text).slice(start, end).join('');
}

export function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError('INVALID_POSITION', `${field} 必须是非负安全整数`);
  }
  return value;
}

export function normalizeInsert(position: number, text: unknown, documentLength: number): EditOperation | null {
  const pos = assertNonNegativeInteger(position, 'position');
  if (pos > documentLength) throw new ApiError('POSITION_OUT_OF_RANGE', '插入位置超出文档末尾');
  if (!isValidUnicodeText(text)) {
    throw new ApiError('INVALID_UNICODE', 'text 必须是不含孤立代理项的有效 Unicode 文本');
  }
  if (text.length === 0) return null;
  return { type: 'insert', position: pos, text };
}

export function normalizeDelete(start: unknown, end: unknown, documentLength: number): EditOperation | null {
  const from = assertNonNegativeInteger(start, 'start');
  const to = assertNonNegativeInteger(end, 'end');
  if (from > to) throw new ApiError('INVALID_RANGE', '删除起点不能大于终点');
  if (to > documentLength) throw new ApiError('RANGE_OUT_OF_RANGE', '删除范围超出文档');
  if (from === to) return null;
  return { type: 'delete', start: from, end: to };
}

function splitPiecesAt(pieces: Piece[], position: number): { before: Piece[]; after: Piece[] } {
  let consumed = 0;
  const before: Piece[] = [];
  const after: Piece[] = [];
  for (const piece of pieces) {
    const pieceEnd = consumed + piece.length;
    if (position <= consumed) {
      after.push({ ...piece });
    } else if (position >= pieceEnd) {
      before.push({ ...piece });
    } else {
      const offset = position - consumed;
      before.push({ ...piece, length: offset });
      after.push({ ...piece, start: piece.start + offset, length: piece.length - offset });
    }
    consumed = pieceEnd;
  }
  return { before, after };
}

function splitCopy(pieces: Piece[], position: number): Piece[] {
  const { before, after } = splitPiecesAt(pieces, position);
  return [...before, ...after];
}

function mergeAdjacent(pieces: Piece[]): Piece[] {
  const result: Piece[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const previous = result.at(-1);
    if (
      previous &&
      previous.source === piece.source &&
      previous.start + previous.length === piece.start
    ) {
      previous.length += piece.length;
    } else {
      result.push({ ...piece });
    }
  }
  return result;
}

function readPiece(original: string, added: string, piece: Piece): string {
  const source = piece.source === 'original' ? original : added;
  return codePointSlice(source, piece.start, piece.start + piece.length);
}

export function materialize(original: string, added: string, pieces: Piece[]): string {
  return pieces.map((piece) => readPiece(original, added, piece)).join('');
}

export function documentLength(pieces: Piece[]): number {
  return pieces.reduce((sum, piece) => sum + piece.length, 0);
}

export function applyOperation(
  original: string,
  added: string,
  pieces: Piece[],
  operation: EditOperation,
): { pieces: Piece[]; added: string } {
  if (operation.type === 'insert') {
    const currentLength = documentLength(pieces);
    const normalized = normalizeInsert(operation.position, operation.text, currentLength);
    if (!normalized || normalized.type !== 'insert') return { pieces: mergeAdjacent(pieces), added };
    const addedStart = codePointLength(added);
    const { before, after } = splitPiecesAt(pieces, normalized.position);
    const next = [
      ...before,
      { source: 'added' as const, start: addedStart, length: codePointLength(normalized.text) },
      ...after,
    ];
    return { pieces: mergeAdjacent(next), added: added + normalized.text };
  }

  const currentLength = documentLength(pieces);
  const normalized = normalizeDelete(operation.start, operation.end, currentLength);
  if (!normalized || normalized.type !== 'delete') return { pieces: mergeAdjacent(pieces), added };
  let next = splitCopy(pieces, normalized.end);
  next = splitCopy(next, normalized.start);
  let cursor = 0;
  next = next.filter((piece) => {
    const pieceStart = cursor;
    const pieceEnd = cursor + piece.length;
    cursor = pieceEnd;
    return pieceEnd <= normalized.start || pieceStart >= normalized.end;
  });
  return { pieces: mergeAdjacent(next), added };
}

export function reportPieces(original: string, added: string, pieces: Piece[]): PieceReport[] {
  let displayStart = 0;
  return pieces.map((piece, ordinal) => {
    const displayEnd = displayStart + piece.length;
    const report: PieceReport = {
      ...piece,
      ordinal,
      displayStart,
      displayEnd,
      text: readPiece(original, added, piece),
    };
    displayStart = displayEnd;
    return report;
  });
}

export function readRange(
  original: string,
  added: string,
  pieces: Piece[],
  start: number,
  end: number,
): string {
  const length = documentLength(pieces);
  const from = assertNonNegativeInteger(start, 'start');
  const to = assertNonNegativeInteger(end, 'end');
  if (from > to || to > length) throw new ApiError('INVALID_RANGE', '读取范围非法或超出文档');
  let cursor = 0;
  let output = '';
  for (const piece of pieces) {
    const pieceEnd = cursor + piece.length;
    if (pieceEnd > from && cursor < to) {
      const localStart = Math.max(0, from - cursor);
      const localEnd = Math.min(piece.length, to - cursor);
      output += codePointSlice(readPiece(original, added, piece), localStart, localEnd);
    }
    cursor = pieceEnd;
  }
  return output;
}

export function locatePosition(
  original: string,
  added: string,
  pieces: Piece[],
  position: number,
): SourceLocation {
  const length = documentLength(pieces);
  const pos = assertNonNegativeInteger(position, 'position');
  if (pos >= length) throw new ApiError('POSITION_OUT_OF_RANGE', '来源查询位置必须位于当前文本中');
  let cursor = 0;
  for (let ordinal = 0; ordinal < pieces.length; ordinal += 1) {
    const piece = pieces[ordinal];
    const pieceEnd = cursor + piece.length;
    if (pos < pieceEnd) {
      const sourceOffset = pos - cursor;
      const text = readPiece(original, added, piece);
      return {
        position: pos,
        source: piece.source,
        sourceStart: piece.start,
        sourceOffset,
        codePoint: codePointSlice(text, sourceOffset, sourceOffset + 1),
        pieceOrdinal: ordinal,
        displayStart: cursor,
        displayEnd: pieceEnd,
      };
    }
    cursor = pieceEnd;
  }
  throw new ApiError('POSITION_OUT_OF_RANGE', '来源查询位置超出文档');
}

export function initialPieces(text: string): Piece[] {
  const length = codePointLength(text);
  return length === 0 ? [] : [{ source: 'original', start: 0, length }];
}

export function validatePieces(original: string, added: string, pieces: Piece[]): void {
  const originalLength = codePointLength(original);
  const addedLength = codePointLength(added);
  for (const piece of pieces) {
    const bufferLength = piece.source === 'original' ? originalLength : addedLength;
    if (piece.length <= 0) throw new ApiError('CORRUPT_PIECE', '存在空片段');
    if (piece.start < 0 || piece.start + piece.length > bufferLength) {
      throw new ApiError('CORRUPT_PIECE', '片段引用超出缓冲区');
    }
  }
}
