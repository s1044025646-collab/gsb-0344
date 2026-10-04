// HTTP API：仅后端，无网页。
import http from 'node:http';
import { DocStore, LIMITS } from './store.js';
import { PtError } from './core.js';

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PtError('INVALID_TEXT', '请求体不是合法 JSON');
  }
}

export function createServer(store: DocStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const m = url.pathname.match(/^\/docs(?:\/(\d+))?(?:\/(text|insert|delete|undo|redo|pieces|locate|history|export))?$/);
      if (req.method === 'GET' && url.pathname === '/limits') {
        return json(res, 200, LIMITS);
      }
      if (!m) throw new PtError('NOT_FOUND', '路由不存在');
      const id = m[1] ? Number(m[1]) : undefined;
      const sub = m[2];

      if (req.method === 'POST' && url.pathname === '/docs') {
        const b = await body(req);
        if (typeof b.name !== 'string' || !b.name) throw new PtError('INVALID_TEXT', 'name 必填');
        return json(res, 201, store.create(b.name, b.text ?? ''));
      }
      if (req.method === 'GET' && url.pathname === '/docs') {
        return json(res, 200, store.list());
      }
      if (id === undefined) throw new PtError('NOT_FOUND', '缺少文档 id');

      if (req.method === 'GET' && !sub) return json(res, 200, store.info(id));
      if (req.method === 'GET' && sub === 'text') {
        const { pt } = store.open(id);
        const start = url.searchParams.has('start') ? Number(url.searchParams.get('start')) : 0;
        const len = url.searchParams.has('len') ? Number(url.searchParams.get('len')) : undefined;
        return json(res, 200, { text: pt.slice(start, len), start, version: store.info(id).version });
      }
      if (req.method === 'POST' && sub === 'insert') {
        const b = await body(req);
        return json(res, 200, store.insert(id, b.pos, b.text, b.version));
      }
      if (req.method === 'POST' && sub === 'delete') {
        const b = await body(req);
        return json(res, 200, store.delete(id, b.pos, b.len, b.version));
      }
      if (req.method === 'POST' && sub === 'undo') return json(res, 200, store.undo(id));
      if (req.method === 'POST' && sub === 'redo') return json(res, 200, store.redo(id));
      if (req.method === 'GET' && sub === 'pieces') {
        const { pt, version } = store.open(id);
        let d = 0;
        const pieces = pt.pieces.map((p, i) => {
          const r = { index: i, source: p.source, start: p.start, length: p.length, displayStart: d, displayEnd: d + p.length };
          d += p.length;
          return r;
        });
        return json(res, 200, { version, length: pt.length, pieces });
      }
      if (req.method === 'GET' && sub === 'locate') {
        const { pt } = store.open(id);
        const pos = Number(url.searchParams.get('pos'));
        return json(res, 200, pt.locate(pos));
      }
      if (req.method === 'GET' && sub === 'history') return json(res, 200, store.history(id));
      if (req.method === 'GET' && sub === 'export') {
        const { pt, version } = store.open(id);
        return json(res, 200, { version, text: pt.text() });
      }
      throw new PtError('NOT_FOUND', '路由不存在');
    } catch (e) {
      if (e instanceof PtError) {
        const status =
          e.code === 'NOT_FOUND' ? 404 : e.code === 'VERSION_CONFLICT' ? 409 : e.code === 'LIMIT_EXCEEDED' ? 413 : 400;
        return json(res, status, { error: e.code, message: e.message });
      }
      return json(res, 500, { error: 'INTERNAL', message: String(e) });
    }
  });
}

export async function startServer(dbPath: string, port?: number): Promise<{ server: http.Server; port: number }> {
  const store = new DocStore(dbPath);
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(port ?? 0, '127.0.0.1', resolve));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : 0;
  return { server, port: actualPort };
}
