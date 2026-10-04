export type SourceKind = 'original' | 'added';

export interface Piece {
  source: SourceKind;
  start: number;
  length: number;
}

export interface PieceReport extends Piece {
  ordinal: number;
  displayStart: number;
  displayEnd: number;
  text: string;
}

export interface SourceLocation {
  position: number;
  source: SourceKind;
  sourceStart: number;
  sourceOffset: number;
  codePoint: string;
  pieceOrdinal: number;
  displayStart: number;
  displayEnd: number;
}

export type EditOperation =
  | { type: 'insert'; position: number; text: string }
  | { type: 'delete'; start: number; end: number };

export interface DocumentSnapshot {
  id: string;
  version: number;
  text: string;
  length: number;
  pieces: PieceReport[];
}

export interface VersionRecord {
  version: number;
  parentVersion: number | null;
  operation: EditOperation | null;
  length: number;
  createdAt: string;
  onCurrentLineage: boolean;
}

export interface Limits {
  maxOriginalCodePoints: number;
  maxDocumentCodePoints: number;
  maxAddedCodePoints: number;
  maxVersionsPerDocument: number;
}

export class ApiError extends Error {
 constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
