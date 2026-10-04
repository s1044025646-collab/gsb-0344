import { startServer } from '../dist/src/server.js';

const { port, server } = await startServer('data/api-test.db');
const b = `http://127.0.0.1:${port}`;
const j = (r) => r.json();
const post = (p, body) =>
  fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const doc = await post('/docs', { name: 'api', text: '你好🌍' }).then(j);
console.log('create', doc);
console.log('insert', await post(`/docs/${doc.id}/insert`, { pos: 2, text: 'X', version: 0 }).then(j));
console.log('text', await fetch(b + `/docs/${doc.id}/text?start=1&len=2`).then(j));
console.log('pieces', await fetch(b + `/docs/${doc.id}/pieces`).then(j));
console.log('locate', await fetch(b + `/docs/${doc.id}/locate?pos=2`).then(j));
console.log('conflict status', (await post(`/docs/${doc.id}/insert`, { pos: 0, text: 'Y', version: 0 })).status);
console.log('undo', await post(`/docs/${doc.id}/undo`).then(j));
console.log('history', await fetch(b + `/docs/${doc.id}/history`).then(j));
server.close();
