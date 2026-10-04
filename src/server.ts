import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentStore, defaultLimits } from './store.js';
import { ApiError } from './types.js';
import type { EditOperation } from './types.js';

const JSON_PARSE_LIMIT = 2_000_000;

export function createHttpServer(store: DocumentStore = new DocumentStore()): Server {
  return createServer((request, response) => {
    handle(request, response, store).catch((error: unknown) => sendError(response, error));
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, store: DocumentStore): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method ?? 'GET';
  const body = method === 'POST' ? await readJson(request) : {};

  if (method === 'POST' && path === '/documents') {
    sendJson(response, 201, store.createDocument((body as { text?: unknown }).text, (body as { id?: unknown }).id));
    return;
  }

  const documentMatch = /^\/documents\/([^/]+)(?:\/(read))?$/.exec(path);
  if (documentMatch) {
    const id = decodeURIComponent(documentMatch[1]);
    const readAction = documentMatch[2];
    if (method === 'GET') {
      if (readAction === 'read') {
        const snapshot = store.get(id);
        const start = url.searchParams.get('start') ?? 0;
        const end = url.searchParams.get('end') ?? String(snapshot.length);
        sendJson(response, 200, store.read(id, Number(start), Number(end)));
      } else {
        sendJson(response, 200, store.get(id));
      }
      return;
    }
  }

  const actionMatch = /^\/documents\/([^/]+)\/(insert|delete|undo|redo|pieces|source|history|export)$/.exec(path);
  if (actionMatch) {
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    if (method === 'POST' && (action === 'insert' || action === 'delete' || action === 'undo' || action === 'redo')) {
      const version = (body as { version?: unknown }).version;
      let operation: EditOperation;
      if (action === 'insert') {
        operation = { type: 'insert', position: Number((body as { position?: unknown }).position), text: String((body as { text?: unknown }).text ?? '') };
      } else if (action === 'delete') {
        operation = { type: 'delete', start: Number((body as { start?: unknown }).start), end: Number((body as { end?: unknown }).end) };
      } else {
        sendJson(response, 200, store[action](id, version));
        return;
      }
      sendJson(response, 200, store.edit(id, version, operation));
      return;
    }
    if (method === 'GET' && (action === 'pieces' || action === 'history' || action === 'export' || action === 'source')) {
      if (action === 'source') {
        sendJson(response, 200, store.source(id, url.searchParams.get('position') ?? ''));
      } else {
        sendJson(response, 200, store[action](id));
      }
      return;
    }
  }

  if (method === 'GET' && path === '/health') {
    sendJson(response, 200, { ok: true, limits: defaultLimits });
    return;
  }

  throw new ApiError('NOT_FOUND', '接口不存在', 404);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > JSON_PARSE_LIMIT) throw new ApiError('REQUEST_TOO_LARGE', '请求体超过限制', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError('INVALID_JSON', '请求体必须是 JSON 对象');
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(response, error.status, { error: error.code, message: error.message });
  } else {
    const message = error instanceof Error ? error.message : '未知错误';
    sendJson(response, 500, { error: 'INTERNAL_ERROR', message });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const requestedPort = Number(process.env.PT_PORT ?? 0);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0;
  const server = createHttpServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Piece Table API 已启动: http://127.0.0.1:${actualPort}`);
    console.log(`数据目录: ${process.env.PT_DB ?? 'data/piece-table.db'}`);
  });
}
