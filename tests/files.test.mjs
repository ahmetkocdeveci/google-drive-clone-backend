import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { copyFile, link, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateNodeName, parseByteRange, archiveSegment } from '../src/files.mjs';
import { createHarness } from './helpers.mjs';

test('filenames reject paths, control characters and special dot segments', () => {
  assert.equal(validateNodeName('  Yol haritası.pdf  '), 'Yol haritası.pdf');
  assert.equal(validateNodeName('cafe\u0301.txt'), 'café.txt');
  for (const value of ['', '.', '..', '../secret', 'a\\b', 'a\n.txt', 'a\u202eb', '\ud800.txt', 'x'.repeat(181), { $gt: '' }]) {
    assert.throws(() => validateNodeName(value), error => error.status === 400);
  }
});

test('single byte ranges handle suffixes, clamping and invalid ranges', () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-99', 10), { start: 0, end: 9 });
  assert.deepEqual(parseByteRange('bytes=0-99', 10), { start: 0, end: 9 });
  for (const value of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=6-2', 'bytes=0-1,4-5', 'items=0-1', 'bytes=9007199254740992-']) {
    assert.throws(() => parseByteRange(value, 10), error => error.status === 416);
  }
  assert.throws(() => parseByteRange('bytes=0-0', 0), error => error.status === 416);
});

test('archive segments never retain path separators or extraction dot names', () => {
  assert.equal(archiveSegment('..'), 'isimsiz');
  assert.equal(archiveSegment('/../secret\\file'), '_.._secret_file');
  assert.equal(archiveSegment('CON.txt'), '_CON.txt');
  assert.equal(archiveSegment('rapor.txt'), 'rapor.txt');
});

let h;
before(async () => { h = await createHarness('files'); });
after(async () => { await h?.close(); });
const userId = user => user.id || user._id;

async function workspace(client, name = 'Dosya alanı') {
  const result = await client.request('post', '/workspaces', { name });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function folder(client, ws, name, parentId = null) {
  const result = await client.request('post', `/workspaces/${ws.id}/folders`, { name, parentId });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function beginUpload(client, ws, bytes, parentId = null, name = 'not.txt') {
  return client.request('post', `/workspaces/${ws.id}/files/uploads`, { name, parentId, size: bytes.length, mimeType: 'text/plain' });
}

async function putUpload(upload, bytes) {
  const url = new URL(upload.uploadUrl);
  return h.client().put(`${url.pathname}${url.search}`).set('Origin', h.config.frontendOrigin).set(upload.headers || {}).set('Content-Type', 'text/plain').send(bytes);
}

test('HTTP file APIs isolate every node and parent by workspace', async () => {
  const owner = await h.user({ name: 'Dosya sahibi', email: 'files-owner@example.com' });
  const stranger = await h.user({ name: 'Diğer kişi', email: 'files-other@example.com' });
  const ws = await workspace(owner);
  const other = await workspace(stranger);
  const root = await folder(owner, ws, 'Ana klasör');
  const foreign = await folder(stranger, other, 'Gizli klasör');
  assert.equal((await stranger.request('get', `/workspaces/${ws.id}/nodes/${root.id}`)).status, 404);
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/nodes/${foreign.id}`)).status, 404);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/folders`, { name: 'Sızma', parentId: foreign.id })).status, 404);
  assert.equal((await beginUpload(owner, ws, Buffer.from('a'), foreign.id)).status, 404);
  assert.equal((await h.models.Workspace.findById(ws.id)).storageReserved, 0);
  assert.equal((await owner.request('patch', `/workspaces/${ws.id}/nodes/${root.id}`, { parentId: foreign.id })).status, 404);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/folders`, { name: 'Sızma', parentId: null, workspaceId: other.id })).status, 400);
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/nodes?parentId=${foreign.id}`)).status, 404);
  const listed = await owner.request('get', `/workspaces/${ws.id}/nodes?parentId=root`);
  assert.deepEqual(listed.body.map(node => node.id), [root.id]);
});

test('Viewer can read but direct create, update, delete and upload calls fail', async () => {
  const owner = await h.user({ name: 'Rol sahibi', email: 'files-role-owner@example.com' });
  const viewer = await h.user({ name: 'Görüntüleyen', email: 'files-viewer@example.com' });
  const ws = await workspace(owner);
  await h.models.Membership.create({ workspaceId: ws.id, userId: userId(viewer.user), role: 'viewer', status: 'active' });
  const root = await folder(owner, ws, 'Okunabilir');
  assert.equal((await viewer.request('get', `/workspaces/${ws.id}/nodes/${root.id}`)).status, 200);
  assert.equal((await viewer.request('post', `/workspaces/${ws.id}/folders`, { name: 'Yasak', parentId: null })).status, 403);
  assert.equal((await viewer.request('patch', `/workspaces/${ws.id}/nodes/${root.id}`, { name: 'Yasak' })).status, 403);
  assert.equal((await viewer.request('delete', `/workspaces/${ws.id}/nodes/${root.id}`)).status, 403);
  assert.equal((await beginUpload(viewer, ws, Buffer.from('yasak'))).status, 403);
});

test('folder moves reject cycles and stale versions; searches treat regex as text', async () => {
  const owner = await h.user({ name: 'Ağaç sahibi', email: 'files-tree@example.com' });
  const ws = await workspace(owner);
  const root = await folder(owner, ws, 'Ana');
  const child = await folder(owner, ws, 'Alt', root.id);
  assert.equal((await owner.request('patch', `/workspaces/${ws.id}/nodes/${root.id}`, { parentId: child.id, version: root.version })).status, 409);
  assert.equal((await owner.request('patch', `/workspaces/${ws.id}/nodes/${root.id}`, { name: 'İlk', version: 999 })).status, 409);
  const renamed = await owner.request('patch', `/workspaces/${ws.id}/nodes/${root.id}`, { name: 'Yeni ad', version: root.version });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.version, root.version + 1);
  await folder(owner, ws, 'x.y');
  await folder(owner, ws, 'xay');
  const search = await owner.request('get', `/workspaces/${ws.id}/nodes?search=${encodeURIComponent('x.y')}`);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.map(node => node.name), ['x.y']);
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/nodes?search[$ne]=x`)).status, 400);
});

test('deleting an ancestor immediately hides descendants from direct access and search', async () => {
  const owner = await h.user({ name: 'Silme sahibi', email: 'files-delete@example.com' });
  const ws = await workspace(owner);
  const root = await folder(owner, ws, 'Silinecek');
  const child = await folder(owner, ws, 'Gizlenen çocuk', root.id);
  const upload = await beginUpload(owner, ws, Buffer.from('pending'), child.id);
  assert.equal(upload.status, 201);
  assert.equal((await owner.request('delete', `/workspaces/${ws.id}/nodes/${root.id}`)).status, 204);
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/nodes/${child.id}`)).status, 404);
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/nodes?parentId=${child.id}`)).status, 404);
  assert.equal((await owner.request('patch', `/workspaces/${ws.id}/nodes/${child.id}`, { name: 'Erişilemez' })).status, 404);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/folders`, { name: 'Erişilemez', parentId: child.id })).status, 404);
  const search = await owner.request('get', `/workspaces/${ws.id}/nodes?search=${encodeURIComponent('Gizlenen')}`);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body, []);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${upload.body.uploadId}/complete`)).status, 404);
  assert.ok(await h.models.Job.findOne({ workspaceId: ws.id, type: 'node-cleanup', targetId: root.id }));
});

test('signed upload finalizes real bytes, scopes access, supports ranges and resists PUT replay', async () => {
  const owner = await h.user({ name: 'Yükleyen', email: 'files-upload@example.com' });
  const stranger = await h.user({ name: 'Yabancı', email: 'files-upload-stranger@example.com' });
  const ws = await workspace(owner);
  const bytes = Buffer.from('merhaba drive');
  const begun = await beginUpload(owner, ws, bytes);
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  assert.equal((await h.models.Workspace.findById(ws.id)).storageReserved, bytes.length);
  const uploaded = await putUpload(begun.body, bytes);
  assert.ok([200, 201, 204].includes(uploaded.status), JSON.stringify(uploaded.body));
  const completed = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const node = completed.body;
  const completedAgain = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
  assert.equal(completedAgain.status, 200);
  assert.equal(completedAgain.body.id, node.id);
  const content = await owner.request('get', `/workspaces/${ws.id}/files/${node.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.text, bytes.toString());
  assert.match(content.headers['content-disposition'], /^attachment;/);
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  const range = await owner.agent.get(`/api/v1/workspaces/${ws.id}/files/${node.id}/content`).set('Range', 'bytes=1-4');
  assert.equal(range.status, 206);
  assert.equal(range.text, 'erha');
  assert.equal(range.headers['content-range'], `bytes 1-4/${bytes.length}`);
  const badRange = await owner.agent.get(`/api/v1/workspaces/${ws.id}/files/${node.id}/content`).set('Range', 'bytes=100-');
  assert.equal(badRange.status, 416);
  assert.equal((await stranger.request('get', `/workspaces/${ws.id}/files/${node.id}/content`)).status, 404);
  await putUpload(begun.body, Buffer.from('XXXXXXXXXXXXX'));
  const afterReplay = await owner.request('get', `/workspaces/${ws.id}/files/${node.id}/content`);
  assert.equal(afterReplay.text, bytes.toString());
  const stored = await h.models.Workspace.findById(ws.id);
  assert.equal(stored.storageUsed, bytes.length);
  assert.equal(stored.storageReserved, 0);
  // Even a corrupted metadata reference must not cross the storage tenant boundary.
  const otherWorkspace = await workspace(stranger, 'Başka alandaki dosya');
  const foreignBytes = Buffer.from('gizli dosyasi');
  assert.equal(foreignBytes.length, bytes.length);
  const foreignUpload = await beginUpload(stranger, otherWorkspace, foreignBytes);
  assert.equal(foreignUpload.status, 201);
  assert.ok([200, 201, 204].includes((await putUpload(foreignUpload.body, foreignBytes)).status));
  const foreignComplete = await stranger.request('post', `/workspaces/${otherWorkspace.id}/files/uploads/${foreignUpload.body.uploadId}/complete`);
  assert.equal(foreignComplete.status, 200);
  const foreignNode = await h.models.DriveNode.findOne({ _id: foreignComplete.body.id, workspaceId: otherWorkspace.id });
  await h.models.DriveNode.updateOne({ _id: node.id, workspaceId: ws.id }, { $set: { objectKey: foreignNode.objectKey } });
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/files/${node.id}/content`)).status, 503);
});

test('upload completion rechecks current role, expiry, declared bytes and storage quota', async () => {
  const owner = await h.user({ name: 'Kota sahibi', email: 'files-quota@example.com' });
  const editor = await h.user({ name: 'Yükleyici editör', email: 'files-editor@example.com' });
  const ws = await workspace(owner);
  const membership = await h.models.Membership.create({ workspaceId: ws.id, userId: userId(editor.user), role: 'editor' });
  const first = await beginUpload(editor, ws, Buffer.from('data'));
  assert.equal(first.status, 201);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${first.body.uploadId}/complete`)).status, 404);
  assert.ok([200, 201, 204].includes((await putUpload(first.body, Buffer.from('data'))).status));
  await h.models.Membership.updateOne({ _id: membership._id, workspaceId: ws.id }, { $set: { role: 'viewer' } });
  assert.equal((await editor.request('post', `/workspaces/${ws.id}/files/uploads/${first.body.uploadId}/complete`)).status, 403);
  await h.models.Membership.updateOne({ _id: membership._id, workspaceId: ws.id }, { $set: { status: 'removed' } });
  assert.equal((await editor.request('post', `/workspaces/${ws.id}/files/uploads/${first.body.uploadId}/complete`)).status, 404);
  assert.equal(await h.models.DriveNode.countDocuments({ workspaceId: ws.id, status: 'active', kind: 'file' }), 0);
  const expired = await beginUpload(owner, ws, Buffer.from('old'));
  await h.models.Upload.updateOne({ _id: expired.body.uploadId, workspaceId: ws.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${expired.body.uploadId}/complete`)).status, 409);
  const mismatch = await beginUpload(owner, ws, Buffer.from('four'));
  assert.equal((await putUpload(mismatch.body, Buffer.from('bad'))).status, 400);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${mismatch.body.uploadId}/complete`)).status, 409);
  await h.models.Workspace.updateOne({ _id: ws.id }, { $set: { storageLimit: 1 } });
  assert.equal((await beginUpload(owner, ws, Buffer.from('large'))).status, 413);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads`, { name: 'x', parentId: null, size: 1, mimeType: 'text/plain\r\nx-evil:yes' })).status, 400);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${randomUUID()}/complete`)).status, 404);
});

test('depth 64 applies to new content and pending files after their parent moves', async () => {
  const owner = await h.user({ name: 'Derinlik sahibi', email: 'files-depth@example.com' });
  const ws = await workspace(owner);
  const chain = [];
  for (let index = 0; index < 64; index++) chain.push({
    _id: randomUUID(), workspaceId: ws.id, parentId: index ? chain[index - 1]._id : null,
    name: `Derinlik ${index + 1}`, kind: 'folder', createdBy: userId(owner.user), status: 'active', version: 1,
  });
  await h.models.DriveNode.insertMany(chain);
  const depth63 = chain[62]._id;
  const depth64 = chain[63]._id;
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/folders`, { name: 'Sınırda', parentId: depth63 })).status, 201);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/folders`, { name: 'Çok derin', parentId: depth64 })).status, 409);
  assert.equal((await beginUpload(owner, ws, Buffer.from('x'), depth64)).status, 409);
  const moving = await folder(owner, ws, 'Taşınan');
  const bytes = Buffer.from('bekleyen dosya');
  const pending = await beginUpload(owner, ws, bytes, moving.id);
  assert.equal(pending.status, 201);
  assert.ok([200, 201, 204].includes((await putUpload(pending.body, bytes)).status));
  assert.equal((await owner.request('patch', `/workspaces/${ws.id}/nodes/${moving.id}`, { parentId: depth63, version: moving.version })).status, 200);
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${pending.body.uploadId}/complete`)).status, 409);
  assert.equal(await h.models.DriveNode.countDocuments({ workspaceId: ws.id, kind: 'file', status: 'active' }), 0);
});

function zipEntries(bytes) {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'ZIP central directory exists');
  const count = bytes.readUInt16LE(eocd + 10);
  let cursor = bytes.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10);
    const size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    entries.push({ name, bytes: method === 8 ? inflateRawSync(compressed) : compressed });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('folder archive contains real nested bytes, unique safe names and has a bounded size', async () => {
  const owner = await h.user({ name: 'Arşiv sahibi', email: 'files-archive@example.com' });
  const stranger = await h.user({ name: 'Arşiv yabancısı', email: 'files-archive-other@example.com' });
  const ws = await workspace(owner);
  const root = await folder(owner, ws, 'Arşiv');
  const child = await folder(owner, ws, 'Alt', root.id);
  const content = Buffer.from('arsivdeki gercek baytlar');
  for (let index = 0; index < 2; index++) {
    const begun = await beginUpload(owner, ws, content, child.id, 'ayni.txt');
    assert.equal(begun.status, 201);
    assert.ok([200, 201, 204].includes((await putUpload(begun.body, content)).status));
    assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`)).status, 200);
  }
  const archived = await owner.agent.get(`/api/v1/workspaces/${ws.id}/folders/${root.id}/archive`).buffer(true).parse((response, done) => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => done(null, Buffer.concat(chunks)));
    response.on('error', done);
  });
  assert.equal(archived.status, 200);
  assert.match(archived.headers['content-type'], /application\/zip/);
  const entries = zipEntries(archived.body);
  assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length);
  const files = entries.filter(entry => !entry.name.endsWith('/'));
  assert.equal(files.length, 2);
  for (const entry of files) {
    assert.ok(entry.name.startsWith('Arşiv/Alt/'));
    assert.ok(!entry.name.split('/').includes('..'));
    assert.equal(entry.bytes.toString(), content.toString());
  }
  assert.equal((await stranger.request('get', `/workspaces/${ws.id}/folders/${root.id}/archive`)).status, 404);
  await h.models.DriveNode.create({ workspaceId: ws.id, parentId: root.id, name: 'buyuk.bin', kind: 'file', mimeType: 'application/octet-stream', size: h.config.maxArchiveBytes + 1, createdBy: userId(owner.user), status: 'active', storageState: 'ready', objectKey: `workspaces/${ws.id}/objects/${randomUUID()}/${randomUUID()}.sealed` });
  assert.equal((await owner.request('get', `/workspaces/${ws.id}/folders/${root.id}/archive`)).status, 413);
});

test('a disconnected ZIP request destroys its active storage stream', async () => {
  const owner = await h.user({ name: 'İndirme sahibi', email: 'files-disconnect@example.com' });
  const ws = await workspace(owner);
  const root = await folder(owner, ws, 'İndirilecek');
  const bytes = Buffer.alloc(512 * 1024, 1);
  const begun = await beginUpload(owner, ws, bytes, root.id);
  assert.equal(begun.status, 201);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  const completed = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
  assert.equal(completed.status, 200);
  const read = h.storage.read;
  let source;
  let timer;
  let signalOpened;
  const opened = new Promise(resolve => { signalOpened = resolve; });
  h.storage.read = async () => {
    source = new Readable({
      read() { timer = setTimeout(() => this.push(Buffer.alloc(4096, 1)), 10); },
      destroy(error, callback) { clearTimeout(timer); callback(error); },
    });
    signalOpened();
    return source;
  };
  const request = owner.agent.get(`/api/v1/workspaces/${ws.id}/folders/${root.id}/archive`).buffer(false);
  request.end(() => {});
  try {
    await Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error('Storage stream was not opened')), 2500))]);
    request.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(source.destroyed, true, 'client disconnect must close the underlying storage stream');
  } finally {
    request.abort(); source?.destroy(); clearTimeout(timer); h.storage.read = read;
    request.app.closeAllConnections();
    await new Promise(resolve => request.app.close(() => resolve()));
  }
});

test('HEAD archive validates access without opening storage body streams', async () => {
  const owner = await h.user({ name: 'Başlık kontrolü', email: 'files-head@example.com' });
  const ws = await workspace(owner);
  const root = await folder(owner, ws, 'Başlık klasörü');
  const bytes = Buffer.from('head body okumaz');
  const begun = await beginUpload(owner, ws, bytes, root.id);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  assert.equal((await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`)).status, 200);
  const read = h.storage.read;
  let reads = 0;
  h.storage.read = async (...args) => { reads++; return read(...args); };
  try {
    const head = await owner.request('head', `/workspaces/${ws.id}/folders/${root.id}/archive`);
    assert.equal(head.status, 200);
    assert.equal(head.text, undefined);
    assert.match(head.headers['content-type'], /application\/zip/);
    assert.equal(reads, 0, 'HEAD must not download or compress file bodies');
  } finally { h.storage.read = read; }
});

test('zero-byte and exact-limit files upload and download; larger descriptors are rejected', async () => {
  const owner = await h.user({ name: 'Boyut sınırları', email: 'files-size-boundary@example.com' });
  const ws = await workspace(owner);
  const empty = await beginUpload(owner, ws, Buffer.alloc(0), null, 'bos.txt');
  assert.equal(empty.status, 201);
  assert.ok([200, 201, 204].includes((await putUpload(empty.body, Buffer.alloc(0))).status));
  const emptyNode = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${empty.body.uploadId}/complete`);
  assert.equal(emptyNode.status, 200);
  assert.equal(emptyNode.body.size, 0);
  const emptyDownload = await owner.request('get', `/workspaces/${ws.id}/files/${emptyNode.body.id}/content`);
  assert.equal(emptyDownload.status, 200);
  assert.equal(emptyDownload.text || '', '');
  assert.equal(emptyDownload.headers['content-length'], '0');
  assert.equal((await owner.agent.get(`/api/v1/workspaces/${ws.id}/files/${emptyNode.body.id}/content`).set('Range', 'bytes=0-0')).status, 416);
  const bytes = Buffer.alloc(h.config.maxUploadBytes, 0x61);
  const exact = await beginUpload(owner, ws, bytes, null, 'sinir.txt');
  assert.equal(exact.status, 201);
  assert.ok([200, 201, 204].includes((await putUpload(exact.body, bytes)).status));
  const exactNode = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${exact.body.uploadId}/complete`);
  assert.equal(exactNode.status, 200);
  assert.equal(exactNode.body.size, bytes.length);
  const actual = await owner.request('get', `/workspaces/${ws.id}/files/${exactNode.body.id}/content`);
  assert.equal(actual.status, 200);
  assert.equal(createHash('sha256').update(actual.text).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const rejected = await owner.request('post', `/workspaces/${ws.id}/files/uploads`, { name: 'buyuk.txt', parentId: null, size: h.config.maxUploadBytes + 1, mimeType: 'text/plain' });
  assert.equal(rejected.status, 413);
  assert.equal(await h.models.Upload.countDocuments({ workspaceId: ws.id }), 2);
  const stored = await h.models.Workspace.findById(ws.id);
  assert.equal(stored.storageUsed, bytes.length);
  assert.equal(stored.storageReserved, 0);
});

test('a disconnected content download destroys its storage body stream', async () => {
  const owner = await h.user({ name: 'İptal indirme', email: 'files-content-disconnect@example.com' });
  const ws = await workspace(owner);
  const bytes = Buffer.alloc(128 * 1024, 1);
  const begun = await beginUpload(owner, ws, bytes);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  const node = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
  assert.equal(node.status, 200);
  const read = h.storage.read;
  let source;
  let timer;
  let opened;
  const sourceOpened = new Promise(resolve => { opened = resolve; });
  h.storage.read = async () => {
    source = new Readable({
      read() { timer = setTimeout(() => this.push(Buffer.alloc(4096, 1)), 10); },
      destroy(error, callback) { clearTimeout(timer); callback(error); },
    });
    opened();
    return source;
  };
  const request = owner.agent.get(`/api/v1/workspaces/${ws.id}/files/${node.body.id}/content`).buffer(false);
  request.end(() => {});
  try {
    await Promise.race([sourceOpened, new Promise((_, reject) => setTimeout(() => reject(new Error('Content stream was not opened')), 2500))]);
    request.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(source.destroyed, true);
  } finally {
    request.abort(); source?.destroy(); clearTimeout(timer); h.storage.read = read;
    request.app.closeAllConnections();
    await new Promise(resolve => request.app.close(() => resolve()));
  }
});

test('concurrent quota reservations and duplicate finalize requests account for bytes once', async () => {
  const owner = await h.user({ name: 'Eşzamanlı kota', email: 'files-concurrent-quota@example.com' });
  const ws = await workspace(owner);
  await h.models.Workspace.updateOne({ _id: ws.id }, { $set: { storageLimit: 3 } });
  const results = await Promise.all([
    beginUpload(owner, ws, Buffer.from('ab'), null, 'bir.txt'),
    beginUpload(owner, ws, Buffer.from('cd'), null, 'iki.txt'),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 413]);
  const upload = results.find(result => result.status === 201).body;
  assert.equal((await h.models.Workspace.findById(ws.id)).storageReserved, 2);
  assert.equal(await h.models.Upload.countDocuments({ workspaceId: ws.id }), 1);
  assert.ok([200, 201, 204].includes((await putUpload(upload, Buffer.from('ok'))).status));
  const completed = await Promise.all([
    owner.request('post', `/workspaces/${ws.id}/files/uploads/${upload.uploadId}/complete`),
    owner.request('post', `/workspaces/${ws.id}/files/uploads/${upload.uploadId}/complete`),
  ]);
  assert.deepEqual(completed.map(result => result.status), [200, 200]);
  assert.equal(completed[0].body.id, completed[1].body.id);
  const stored = await h.models.Workspace.findById(ws.id);
  assert.equal(stored.storageUsed, 2);
  assert.equal(stored.storageReserved, 0);
});

test('finalize rechecks role changes made while object promotion is in progress', async () => {
  const owner = await h.user({ name: 'Yetki sahibi', email: 'files-permission-race-owner@example.com' });
  const editor = await h.user({ name: 'Yarış editörü', email: 'files-permission-race-editor@example.com' });
  const ws = await workspace(owner);
  const membership = await h.models.Membership.create({ workspaceId: ws.id, userId: userId(editor.user), role: 'editor' });
  const bytes = Buffer.from('yetkili basladi');
  const begun = await beginUpload(editor, ws, bytes);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  const originalPromote = h.storage.promoteUpload;
  let signalPromoted;
  const promoted = new Promise(resolve => { signalPromoted = resolve; });
  let continueFinalize;
  const release = new Promise(resolve => { continueFinalize = resolve; });
  h.storage.promoteUpload = async upload => {
    const result = await originalPromote(upload);
    if (upload._id === begun.body.uploadId) { signalPromoted(); await release; }
    return result;
  };
  const completion = editor.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`).then(response => response);
  try {
    await Promise.race([promoted, new Promise((_, reject) => setTimeout(() => reject(new Error('Promotion barrier was not reached')), 2500))]);
    await owner.request('patch', `/workspaces/${ws.id}/members/${membership._id}/role`, { role: 'viewer' }).expect(200);
    continueFinalize();
    assert.equal((await completion).status, 403);
    assert.equal(await h.models.DriveNode.countDocuments({ workspaceId: ws.id, kind: 'file', status: 'active' }), 0);
    const reserved = await h.models.Workspace.findById(ws.id);
    assert.equal(reserved.storageUsed, 0);
    assert.equal(reserved.storageReserved, bytes.length);
  } finally { continueFinalize(); h.storage.promoteUpload = originalPromote; await completion; }
});

test('late duplicate-finalize publication is collected after deletion without collecting active bytes', async () => {
  const owner = await h.user({ name: 'Yarış sahibi', email: 'files-finalize-race@example.com' });
  const ws = await workspace(owner);
  const keepWs = await workspace(owner, 'Korunan alan');
  const bytes = Buffer.from('yarista silinen baytlar');
  const keptBytes = Buffer.from('korunan dosya');
  const keptUpload = await beginUpload(owner, keepWs, keptBytes);
  assert.ok([200, 201, 204].includes((await putUpload(keptUpload.body, keptBytes)).status));
  const keptNode = await owner.request('post', `/workspaces/${keepWs.id}/files/uploads/${keptUpload.body.uploadId}/complete`);
  assert.equal(keptNode.status, 200);
  const begun = await beginUpload(owner, ws, bytes);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  const originalPromote = h.storage.promoteUpload;
  let signalCopied;
  const copied = new Promise(resolve => { signalCopied = resolve; });
  let publish;
  const canPublish = new Promise(resolve => { publish = resolve; });
  let delayed = true;
  h.storage.promoteUpload = async upload => {
    if (!delayed || upload._id !== begun.body.uploadId) return originalPromote(upload);
    delayed = false;
    const objectKey = `${upload.objectKey}.sealed`;
    const destination = path.join(h.config.localStoragePath, ...objectKey.split('/'));
    const temporary = `${destination}.${randomUUID()}.race.tmp`;
    await copyFile(path.join(h.config.localStoragePath, ...upload.objectKey.split('/')), temporary);
    signalCopied();
    await canPublish;
    try { await link(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
    return { objectKey, size: upload.size, mimeType: upload.mimeType };
  };
  const slowComplete = owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`).then(response => response);
  try {
    await Promise.race([copied, new Promise((_, reject) => setTimeout(() => reject(new Error('Promotion did not reach copy barrier')), 2500))]);
    const fastComplete = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
    assert.equal(fastComplete.status, 200);
    await owner.request('delete', `/workspaces/${ws.id}/nodes/${fastComplete.body.id}`).expect(204);
    await h.worker.drain(100);
    publish();
    const afterDelete = await slowComplete;
    assert.ok([404, 409].includes(afterDelete.status));
    const upload = await h.models.Upload.findOne({ _id: begun.body.uploadId, workspaceId: ws.id }).lean();
    assert.ok(await h.storage.head(`${upload.objectKey}.sealed`), 'controlled slow publisher reproduced late orphan bytes');
    await h.models.Upload.updateOne({ _id: upload._id, workspaceId: ws.id }, { $set: { expiresAt: new Date(Date.now() - 11 * 60000) } });
    await h.worker.drain(100);
    assert.equal(await h.storage.head(`${upload.objectKey}.sealed`), null);
    const kept = await owner.request('get', `/workspaces/${keepWs.id}/files/${keptNode.body.id}/content`);
    assert.equal(kept.status, 200);
    assert.equal(kept.text, keptBytes.toString());
    const stored = await h.models.Workspace.findById(ws.id);
    assert.equal(stored.storageUsed, 0);
    assert.equal(stored.storageReserved, 0);
  } finally { publish(); h.storage.promoteUpload = originalPromote; await slowComplete; }
});

test('late staging bytes from an expired signed PUT are collected while the completed file stays active', async () => {
  const owner = await h.user({ name: 'Geç staging', email: 'files-late-staging@example.com' });
  const ws = await workspace(owner);
  const bytes = Buffer.from('aktif dosyanin sabit baytlari');
  const begun = await beginUpload(owner, ws, bytes);
  assert.ok([200, 201, 204].includes((await putUpload(begun.body, bytes)).status));
  const completed = await owner.request('post', `/workspaces/${ws.id}/files/uploads/${begun.body.uploadId}/complete`);
  assert.equal(completed.status, 200);
  const past = new Date(Date.now() - 11 * 60000);
  await h.models.Upload.updateOne({ _id: begun.body.uploadId, workspaceId: ws.id }, { $set: { expiresAt: past } });
  await h.models.Job.updateOne({ workspaceId: ws.id, type: 'upload-expiry', targetId: begun.body.uploadId }, { $set: { availableAt: past } });
  await h.worker.drain(100);
  const upload = await h.models.Upload.findOne({ _id: begun.body.uploadId, workspaceId: ws.id }).lean();
  assert.equal(upload.state, 'completed');
  assert.equal(await h.storage.head(upload.objectKey), null);
  // Object providers can finish a PUT that was authorized before URL expiry.
  await writeFile(path.join(h.config.localStoragePath, ...upload.objectKey.split('/')), Buffer.from('gec staging baytlari'));
  assert.ok(await h.storage.head(upload.objectKey));
  await h.worker.drain(100);
  assert.equal(await h.storage.head(upload.objectKey), null);
  const kept = await owner.request('get', `/workspaces/${ws.id}/files/${completed.body.id}/content`);
  assert.equal(kept.status, 200);
  assert.equal(kept.text, bytes.toString());
});
