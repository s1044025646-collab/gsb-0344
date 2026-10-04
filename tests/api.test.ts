import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { AddressInfo } from 'node:net';
import { DocumentStore } from '../src/store.js';
import { createHttpServer } from '../src/server.js';
import type { Server } from 'node:http';

let directory: string;
let server: Server;
let baseUrl: string;
let store: DocumentStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'piece-api-'));
  store = new DocumentStore(join(directory, 'api.db'));
  server = createHttpServer(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test('HTTP API 可创建、编辑、读取区间、撤销并查询来源', async () => {
  let response = await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'api', text: '你好😀' }),
  });
  assert.equal(response.status, 201);
  const created = await response.json() as { version: number };
  assert.equal(created.version, 0);

  response = await fetch(`${baseUrl}/documents/api/insert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 0, position: 2, text: '中' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { text: string }).text, '你好中😀');

  response = await fetch(`${baseUrl}/documents/api/read?start=1&end=4`);
  assert.equal((await response.json() as { text: string }).text, '好中😀');

  response = await fetch(`${baseUrl}/documents/api/source?position=2`);
  assert.deepEqual(await response.json(), {
    position: 2,
    source: 'added',
    sourceStart: 0,
    sourceOffset: 0,
    codePoint: '中',
    pieceOrdinal: 1,
    displayStart: 2,
    displayEnd: 3,
  });

  response = await fetch(`${baseUrl}/documents/api/undo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal((await response.json() as { text: string }).text, '你好😀');
});

test('过期编辑返回冲突错误', async () => {
  await fetch(`${baseUrl}/documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'conflict', text: 'abc' }),
  });
  const response = await fetch(`${baseUrl}/documents/conflict/insert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 5, position: 0, text: 'x' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, 'VERSION_CONFLICT');
});
