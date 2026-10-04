// Piece table 核心引擎。所有位置均以 Unicode 码点计数。

export type Source = 'original' | 'add';

export interface Piece {
  source: Source;
  start: number; // 在来源缓冲区中的起始码点偏移
  length: number; // 码点长度
}

export interface LocateResult {
  pieceIndex: number;
  piece: Piece;
  offsetInPiece: number; // 码点偏移
  displayStart: number; // 该片段在显示文本中的起始码点位置
}

export class PtError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function toCodePoints(s: string): string[] {
  return Array.from(s);
}

export function assertValidText(s: unknown, field: string): asserts s is string {
  if (typeof s !== 'string') throw new PtError('INVALID_TEXT', `${field} 必须是字符串`);
  // 拒绝孤立代理项（无效 Unicode 标量序列）
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n < 0xdc00 || n > 0xdfff) throw new PtError('INVALID_TEXT', `${field} 含孤立高代理项`);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new PtError('INVALID_TEXT', `${field} 含孤立低代理项`);
    }
  }
}

export function assertNonNegInt(n: unknown, field: string): asserts n is number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new PtError('INVALID_POSITION', `${field} 必须是非负整数`);
  }
}

export class PieceTable {
  // 缓冲区以码点数组保存，保证索引即码点偏移
  readonly original: string[];
  readonly add: string[];
  pieces: Piece[];

  constructor(original: string, add = '', pieces?: Piece[]) {
    this.original = toCodePoints(original);
    this.add = toCodePoints(add);
    this.pieces = pieces
      ? pieces.map((p) => ({ ...p }))
      : this.original.length > 0
        ? [{ source: 'original', start: 0, length: this.original.length }]
        : [];
  }

  get length(): number {
    return this.pieces.reduce((n, p) => n + p.length, 0);
  }

  text(): string {
    return this.slice(0, this.length);
  }

  slice(start: number, len?: number): string {
    assertNonNegInt(start, 'start');
    if (start > this.length) throw new PtError('INVALID_RANGE', 'start 超出文档长度');
    const end = len === undefined ? this.length : start + len;
    if (len !== undefined) {
      assertNonNegInt(len, 'len');
      if (end > this.length) throw new PtError('INVALID_RANGE', '区间超出文档长度');
    }
    const out: string[] = [];
    let pos = 0;
    for (const p of this.pieces) {
      const pEnd = pos + p.length;
      if (pEnd > start && pos < end) {
        const buf = p.source === 'original' ? this.original : this.add;
        const s = Math.max(start - pos, 0);
        const e = Math.min(end - pos, p.length);
        for (let i = s; i < e; i++) out.push(buf[p.start + i]);
      }
      pos = pEnd;
    }
    return out.join('');
  }

  locate(pos: number): LocateResult {
    assertNonNegInt(pos, 'pos');
    if (pos >= this.length) throw new PtError('INVALID_POSITION', 'pos 超出文档长度');
    let d = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (pos < d + p.length) {
        return { pieceIndex: i, piece: { ...p }, offsetInPiece: pos - d, displayStart: d };
      }
      d += p.length;
    }
    throw new PtError('INVALID_POSITION', 'pos 超出文档长度');
  }

  // 在显示位置 pos 处分裂片段表，返回分裂点后的片段下标
  private splitAt(pos: number): number {
    if (pos === 0) return 0;
    let d = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (pos === d + p.length) return i + 1;
      if (pos < d + p.length) {
        const off = pos - d;
        const left: Piece = { source: p.source, start: p.start, length: off };
        const right: Piece = { source: p.source, start: p.start + off, length: p.length - off };
        this.pieces.splice(i, 1, left, right);
        return i + 1;
      }
      d += p.length;
    }
    return this.pieces.length;
  }

  private tryMerge(i: number): void {
    if (i <= 0 || i >= this.pieces.length) return;
    const a = this.pieces[i - 1];
    const b = this.pieces[i];
    // 仅当来源相同且在来源缓冲区中物理连续时才合并
    if (a.source === b.source && a.start + a.length === b.start) {
      a.length += b.length;
      this.pieces.splice(i, 1);
    }
  }

  // 返回是否产生了实际变更（空插入不产生历史）
  insert(pos: number, text: string): boolean {
    assertNonNegInt(pos, 'pos');
    assertValidText(text, 'text');
    if (pos > this.length) throw new PtError('INVALID_POSITION', '插入位置超出文档长度');
    if (text.length === 0) return false;
    const cps = toCodePoints(text);
    const start = this.add.length;
    this.add.push(...cps);
    const idx = this.splitAt(pos);
    this.pieces.splice(idx, 0, { source: 'add', start, length: cps.length });
    this.tryMerge(idx);
    this.tryMerge(idx + 1);
    return true;
  }

  delete(pos: number, len: number): boolean {
    assertNonNegInt(pos, 'pos');
    assertNonNegInt(len, 'len');
    if (pos + len > this.length) throw new PtError('INVALID_RANGE', '删除范围超出文档长度');
    if (len === 0) return false;
    const from = this.splitAt(pos);
    const to = this.splitAt(pos + len);
    this.pieces.splice(from, to - from);
    this.tryMerge(from);
    return true;
  }

  snapshot(): Piece[] {
    return this.pieces.map((p) => ({ ...p }));
  }

  restore(pieces: Piece[]): void {
    this.pieces = pieces.map((p) => ({ ...p }));
  }

  // 校验片段表不变量：无空片段、引用不越界、恰好覆盖 length
  validate(): void {
    let total = 0;
    for (const p of this.pieces) {
      if (p.length <= 0) throw new PtError('INTERNAL', '存在空片段');
      const bufLen = p.source === 'original' ? this.original.length : this.add.length;
      if (p.start < 0 || p.start + p.length > bufLen) {
        throw new PtError('INTERNAL', '片段引用越界');
      }
      total += p.length;
    }
    if (total !== this.length) throw new PtError('INTERNAL', '片段未覆盖全文');
  }
}
