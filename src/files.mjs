import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { HttpError } from './errors.mjs';
import { requireAuth, requireVerified } from './auth.mjs';
import { resolveWorkspace, mutateWorkspace, audit } from './tenant.mjs';
import { parsePageQuery, encodeCursor, decodeCursor, keysetAfter } from './pagination.mjs';
import {createStreamAccessMonitor} from './stream-access.mjs';

const MAX_DEPTH = 64;
const MAX_LIST = 500;
const MAX_SEARCH_CANDIDATES = 5000;
const NODE_TYPES = new Set(['all', 'folder', 'image', 'pdf', 'document', 'spreadsheet', 'presentation', 'video', 'audio', 'other']);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_FILTERS = {
  folder: { kind: 'folder' },
  image: { kind: 'file', mimeType: /^image\// },
  pdf: { kind: 'file', mimeType: 'application/pdf' },
  document: { kind: 'file', mimeType: /^(text\/(?!csv$)|application\/(msword$|vnd\.openxmlformats-officedocument\.wordprocessingml\.|vnd\.oasis\.opendocument\.text$))/ },
  spreadsheet: { kind: 'file', mimeType: /^(text\/csv$|application\/(vnd\.ms-excel$|vnd\.openxmlformats-officedocument\.spreadsheetml\.|vnd\.oasis\.opendocument\.spreadsheet$))/ },
  presentation: { kind: 'file', mimeType: /^application\/(vnd\.ms-powerpoint$|vnd\.openxmlformats-officedocument\.presentationml\.|vnd\.oasis\.opendocument\.presentation$)/ },
  video: { kind: 'file', mimeType: /^video\// },
  audio: { kind: 'file', mimeType: /^audio\// },
};

const invalid = (message = 'İstek alanları geçersiz.') => new HttpError(400, 'VALIDATION_ERROR', message);
const missing = () => new HttpError(404, 'NODE_NOT_FOUND', 'İçerik bulunamadı.');
const conflict = (message) => new HttpError(409, 'NODE_CONFLICT', message);
const tooLarge = (message) => new HttpError(413, 'LIMIT_EXCEEDED', message);

export function nodeObjectKey(node) {
  const prefix = `workspaces/${node.workspaceId}/objects/${node._id}/`;
  if (typeof node.objectKey !== 'string' || !node.objectKey.startsWith(prefix) || !/^[0-9a-f-]{36}\.sealed$/i.test(node.objectKey.slice(prefix.length))) {
    throw new HttpError(503, 'STORAGE_INTEGRITY_ERROR', 'Dosya güvenle okunamıyor.');
  }
  return node.objectKey;
}

function id(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw missing();
  return value;
}

function bodyObject(body, allowed, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !(key in body))) throw invalid();
  return body;
}

export function validateNodeName(value) {
  if (typeof value !== 'string') throw invalid('İçerik adı gerekli.');
  const name = value.normalize('NFC').trim();
  if (!name || !name.isWellFormed() || name.length > 180 || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw invalid('Ad 1–180 karakter olmalı; yol ayırıcıları veya kontrol karakterleri içeremez.');
  }
  return name;
}

function parentId(value) {
  return value === null ? null : id(value);
}

function mimeType(value) {
  if (typeof value !== 'string' || value.length > 180 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value)) throw invalid('Dosya türü geçersiz.');
  return value.toLowerCase();
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

async function nodeById(models, workspaceId, nodeId, session) {
  return withSession(models.DriveNode.findOne({ _id: nodeId, workspaceId, status: 'active' }), session).lean();
}

/** Every lookup includes the tenant, including ancestors and cache entries. */
export async function activeChain(models, workspaceId, startId, { session, cache = new Map(), forbiddenId } = {}) {
  const chain = [];
  const seen = new Set();
  let currentId = startId;
  while (currentId !== null) {
    if (chain.length >= MAX_DEPTH) throw conflict('Klasör derinliği sınırı aşıldı.');
    if (seen.has(currentId)) throw conflict('Klasör ağacı geçersiz.');
    if (currentId === forbiddenId) throw conflict('Klasör kendi içine veya alt klasörüne taşınamaz.');
    seen.add(currentId);
    if (!cache.has(currentId)) cache.set(currentId, await nodeById(models, workspaceId, currentId, session));
    const node = cache.get(currentId);
    if (!node || node.kind !== 'folder') throw missing();
    chain.push(node);
    currentId = node.parentId;
  }
  return chain;
}

export async function visibleNode(models, workspaceId, nodeId, session) {
  const node = await nodeById(models, workspaceId, nodeId, session);
  if (!node) throw missing();
  await activeChain(models, workspaceId, node.parentId, { session });
  return node;
}

async function nodeDtos(models, nodes, session) {
  const ids = [...new Set(nodes.map(node => node.createdBy))];
  const users = ids.length ? await withSession(models.User.find({ _id: { $in: ids } }).select('_id name'), session).lean() : [];
  const names = new Map(users.map(user => [user._id, user.name]));
  return nodes.map(node => ({
    id: node._id, workspaceId: node.workspaceId, parentId: node.parentId, name: node.name,
    kind: node.kind, mimeType: node.mimeType || '', size: node.size || 0,
    createdAt: new Date(node.createdAt).toISOString(), updatedAt: new Date(node.updatedAt).toISOString(),
    createdBy: { id: node.createdBy, name: names.get(node.createdBy) || 'Silinmiş kullanıcı' }, version: node.version,
  }));
}

async function tree(models, workspaceId, root, { session, maxNodes = 10000, maxBytes = Infinity } = {}) {
  const result = [{ node: root, path: [root.name], depth: 1 }];
  const seen = new Set([root._id]);
  let bytes = root.kind === 'file' ? root.size : 0;
  for (let cursor = 0; cursor < result.length; cursor++) {
    const item = result[cursor];
    if (item.node.kind !== 'folder') continue;
    const children = await withSession(models.DriveNode.find({ workspaceId, parentId: item.node._id, status: 'active' }).sort({ name: 1, _id: 1 }).limit(maxNodes + 1), session).lean();
    for (const child of children) {
      if (seen.has(child._id)) throw conflict('Klasör ağacı geçersiz.');
      if (item.depth >= MAX_DEPTH) throw conflict('Klasör derinliği sınırı aşıldı.');
      seen.add(child._id);
      bytes += child.kind === 'file' ? child.size : 0;
      if (result.length >= maxNodes || bytes > maxBytes) throw tooLarge('Bu klasör doğrudan işlemek için çok büyük. Daha küçük bir alt klasör seç.');
      result.push({ node: child, path: [...item.path, child.name], depth: item.depth + 1 });
    }
  }
  return result;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function listQuery(query) {
  const allowed = ['parentId', 'search', 'type', 'sort', 'direction', 'recent'];
  if (Object.keys(query).some(key => !allowed.includes(key)) || Object.values(query).some(value => typeof value !== 'string')) throw invalid();
  if (query.search !== undefined && query.search.length > 120) throw invalid('Arama en fazla 120 karakter olabilir.');
  const type = query.type || 'all';
  const sort = query.sort || 'name';
  const direction = query.direction || 'asc';
  if (!NODE_TYPES.has(type) || !['name', 'updatedAt', 'size'].includes(sort) || !['asc', 'desc'].includes(direction) || (query.recent !== undefined && !['true', 'false'].includes(query.recent))) throw invalid();
  const search = query.search?.trim();
  const global = !!search || query.recent === 'true';
  const filter = {};
  if (!global) filter.parentId = query.parentId === undefined || query.parentId === 'root' ? null : id(query.parentId);
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  if (type === 'other') Object.assign(filter, { kind: 'file', $nor: Object.values(TYPE_FILTERS) });
  else if (type !== 'all') Object.assign(filter, TYPE_FILTERS[type]);
  return { filter, global, sort: { [query.recent === 'true' ? 'updatedAt' : sort]: query.recent === 'true' ? -1 : direction === 'asc' ? 1 : -1, _id: 1 } };
}

export function parseByteRange(header, size) {
  if (header === undefined) return null;
  if (typeof header !== 'string' || !/^bytes=(\d*)-(\d*)$/.test(header)) throw new HttpError(416, 'INVALID_RANGE', 'Bayt aralığı geçersiz.');
  const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(header);
  let start;
  let end;
  if (!first) {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || !size) throw new HttpError(416, 'INVALID_RANGE', 'Bayt aralığı geçersiz.');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(first); end = last ? Number(last) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new HttpError(416, 'INVALID_RANGE', 'Bayt aralığı geçersiz.');
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\/;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Safe path segments also cover legacy data; user filenames never become paths. */
export function archiveSegment(value) {
  const safe = String(value).normalize('NFC').replace(/[\\/\x00-\x1f\x7f:<>"|?*]/g, '_').replace(/[. ]+$/g, '').slice(0, 180);
  if (!safe || safe === '.' || safe === '..') return 'isimsiz';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? `_${safe}` : safe;
}

export function createFilesRouter({ models, config, storage }) {
  const router = Router();
  router.use('/workspaces/:wid', requireAuth, requireVerified);
  const actor = req => String(req.auth.user._id);
  const scope = req => ({ models, workspaceId: id(req.params.wid), userId: actor(req) });
  const readScope = req => resolveWorkspace({ ...scope(req), permission: 'content:read' });
  const mutate = (req, permission, callback) => mutateWorkspace({ ...scope(req), permission }, async(context,session)=>{
    const result=await callback(context,session);
    await models.Workspace.updateOne({_id:context.workspace._id,status:'active'},{$inc:{contentVersion:1}},{session});
    return result;
  });

  router.get('/workspaces/:wid/nodes', async (req, res) => {
    await readScope(req);
    const workspaceId = id(req.params.wid);
    const parsed = listQuery(req.query);
    if (!parsed.global) await activeChain(models, workspaceId, parsed.filter.parentId);
    const cap = parsed.global ? MAX_SEARCH_CANDIDATES : MAX_LIST;
    const candidates = await models.DriveNode.find({ ...parsed.filter, workspaceId, status: 'active' }).sort(parsed.sort).limit(cap + 1).lean();
    if (candidates.length > cap) throw tooLarge('Liste sınırı aşıldı. Alt klasör veya daha dar bir arama kullan.');
    const nodes = [];
    const cache = new Map();
    for (const candidate of candidates) {
      try { await activeChain(models, workspaceId, candidate.parentId, { cache }); }
      catch (error) { if (error instanceof HttpError && error.status === 404) continue; throw error; }
      nodes.push(candidate);
      if (nodes.length > MAX_LIST) throw tooLarge('Liste sınırı aşıldı. Alt klasör veya daha dar bir arama kullan.');
    }
    res.json(await nodeDtos(models, nodes));
  });

  router.get('/workspaces/:wid/nodes/page', async (req, res) => {
    const context = await readScope(req);
    const workspaceId = id(req.params.wid);
    const { limit, cursor } = parsePageQuery(req.query);
    const { limit: _limit, cursor: _cursor, ...query } = req.query;
    const parsed = listQuery(query);
    if (!parsed.global) await activeChain(models, workspaceId, parsed.filter.parentId);
    const field = Object.keys(parsed.sort)[0];
    const direction = parsed.sort[field] === -1 ? 'desc' : 'asc';
    const binding = { endpoint: 'nodes', workspaceId, userId: actor(req), query, limit, authorizationVersion: context.workspace.authorizationVersion, mutationSequence: context.workspace.mutationSequence };
    const position = decodeCursor({ config, binding, cursor });
    const after = keysetAfter({ field, direction, position, valueType: field === 'updatedAt' ? 'date' : field === 'size' ? 'number' : 'string' });
    const rows = models.DriveNode.find({ $and: [parsed.filter, after], workspaceId, status: 'active' }).sort(parsed.sort).cursor({ batchSize: 100 });
    const nodes = [];
    const cache = new Map();
    let nextCursor = null;
    let scanned = 0;
    try {
      for await (const node of rows) {
        let visible = true;
        try { await activeChain(models, workspaceId, node.parentId, { cache }); }
        catch (error) { if (error instanceof HttpError && error.status === 404) visible = false; else throw error; }
        if (visible && nodes.length === limit) {
          const last = nodes.at(-1);
          nextCursor = encodeCursor({ config, binding, position: { value: last[field], id: last._id } });
          break;
        }
        if (visible) nodes.push(node);
        scanned++;
        // Bound each HTTP scan, but retain its last scanned position for continuation.
        if (scanned >= 1000) { nextCursor = encodeCursor({ config, binding, position: { value: node[field], id: node._id } }); break; }
      }
    } finally { await rows.close(); }
    const latest = await readScope(req);
    if (latest.workspace.mutationSequence !== context.workspace.mutationSequence || latest.workspace.authorizationVersion !== context.workspace.authorizationVersion) throw new HttpError(409, 'PAGINATION_STALE', 'Liste değişmiş. Listeyi yenileyip tekrar dene.');
    res.json({ items: await nodeDtos(models, nodes), nextCursor });
  });

  router.get('/workspaces/:wid/nodes/:nid', async (req, res) => {
    await readScope(req);
    const node = await visibleNode(models, id(req.params.wid), id(req.params.nid));
    res.json((await nodeDtos(models, [node]))[0]);
  });

  router.post('/workspaces/:wid/folders', async (req, res) => {
    const input = bodyObject(req.body, ['name', 'parentId'], ['name', 'parentId']);
    const name = validateNodeName(input.name);
    const parent = parentId(input.parentId);
    const nodeId = randomUUID();
    const result = await mutate(req, 'content:create', async ({ workspace }, session) => {
      const chain = await activeChain(models, workspace._id, parent, { session });
      if (chain.length >= MAX_DEPTH) throw conflict('En fazla 64 klasör derinliği destekleniyor.');
      const [node] = await models.DriveNode.create([{ _id: nodeId, workspaceId: workspace._id, parentId: parent, name, kind: 'folder', mimeType: '', size: 0, createdBy: actor(req), version: 1, status: 'active' }], { session });
      await audit({ models, workspaceId: workspace._id, actorId: actor(req), action: 'folder.created', targetId: nodeId, session });
      return (await nodeDtos(models, [node], session))[0];
    });
    res.status(201).json(result);
  });

  router.patch('/workspaces/:wid/nodes/:nid', async (req, res) => {
    const input = bodyObject(req.body, ['name', 'parentId', 'version']);
    if (!('name' in input) && !('parentId' in input)) throw invalid('Ad veya hedef klasör gerekli.');
    const name = 'name' in input ? validateNodeName(input.name) : undefined;
    const parent = 'parentId' in input ? parentId(input.parentId) : undefined;
    if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) throw invalid('Sürüm geçersiz.');
    const nodeId = id(req.params.nid);
    const result = await mutate(req, 'content:update', async ({ workspace }, session) => {
      const node = await visibleNode(models, workspace._id, nodeId, session);
      if (input.version !== undefined && input.version !== node.version) throw conflict('İçerik değişmiş. Listeyi yenileyip tekrar dene.');
      if (parent !== undefined) {
        const ancestors = await activeChain(models, workspace._id, parent, { session, forbiddenId: nodeId });
        const descendants = node.kind === 'folder' ? await tree(models, workspace._id, node, { session }) : [{ depth: 1 }];
        const height = Math.max(...descendants.map(item => item.depth));
        if (ancestors.length + height > MAX_DEPTH) throw conflict('Taşıma klasör derinliği sınırını aşar.');
      }
      const update = { ...(name === undefined ? {} : { name }), ...(parent === undefined ? {} : { parentId: parent }) };
      const updated = await models.DriveNode.findOneAndUpdate({ _id: nodeId, workspaceId: workspace._id, status: 'active', version: node.version }, { $set: update, $inc: { version: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!updated) throw conflict('İçerik değişmiş. Listeyi yenileyip tekrar dene.');
      await audit({ models, workspaceId: workspace._id, actorId: actor(req), action: 'node.updated', targetId: nodeId, session });
      return (await nodeDtos(models, [updated], session))[0];
    });
    res.json(result);
  });

  router.delete('/workspaces/:wid/nodes/:nid', async (req, res) => {
    const nodeId = id(req.params.nid);
    await mutate(req, 'content:delete', async ({ workspace }, session) => {
      await visibleNode(models, workspace._id, nodeId, session);
      await models.DriveNode.updateOne({ _id: nodeId, workspaceId: workspace._id, status: 'active' }, { $set: { status: 'deleting' }, $inc: { version: 1 } }, { session });
      await models.Job.create([{ _id: randomUUID(), workspaceId: workspace._id, type: 'node-cleanup', targetId: nodeId, status: 'pending', attempts: 0 }], { session });
      await audit({ models, workspaceId: workspace._id, actorId: actor(req), action: 'node.delete-requested', targetId: nodeId, session });
    });
    res.status(204).end();
  });

  router.post('/workspaces/:wid/files/uploads', async (req, res) => {
    const input = bodyObject(req.body, ['name', 'parentId', 'size', 'mimeType'], ['name', 'parentId', 'size', 'mimeType']);
    const name = validateNodeName(input.name);
    const parent = parentId(input.parentId);
    const type = mimeType(input.mimeType);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > (config.maxUploadBytes || 25 * 1024 * 1024)) throw tooLarge('Dosya boyutu yükleme sınırını aşıyor.');
    const uploadId = randomUUID();
    const nodeId = randomUUID();
    const expiresInSeconds = Math.min(config.uploadTtlSeconds || 300, 900);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const upload = await mutate(req, 'content:create', async ({ workspace }, session) => {
      const chain = await activeChain(models, workspace._id, parent, { session });
      if (chain.length >= MAX_DEPTH) throw conflict('En fazla 64 içerik derinliği destekleniyor.');
      if ((workspace.storageUsed || 0) + (workspace.storageReserved || 0) + input.size > workspace.storageLimit) throw tooLarge('Çalışma alanı depolama kotası dolu.');
      const objectKey = `workspaces/${workspace._id}/objects/${nodeId}/${uploadId}`;
      await models.DriveNode.create([{ _id: nodeId, workspaceId: workspace._id, parentId: parent, name, kind: 'file', mimeType: type, size: input.size, createdBy: actor(req), version: 1, status: 'pending-upload', storageState: 'pending', objectKey }], { session });
      const [created] = await models.Upload.create([{ _id: uploadId, workspaceId: workspace._id, nodeId, initiatedBy: actor(req), objectKey, expiresAt, state: 'initiated', size: input.size, mimeType: type }], { session });
      await models.Workspace.updateOne({ _id: workspace._id, status: 'active' }, { $inc: { storageReserved: input.size } }, { session });
      await models.Job.create([{ _id: randomUUID(), workspaceId: workspace._id, type: 'upload-expiry', targetId: uploadId, status: 'pending', attempts: 0, availableAt: expiresAt }], { session });
      await audit({ models, workspaceId: workspace._id, actorId: actor(req), action: 'file.upload-initiated', targetId: nodeId, session });
      return created.toObject();
    });
    const signed = await storage.createUpload({ upload, expiresInSeconds });
    res.status(201).json({ uploadId, ...signed });
  });

  router.post('/workspaces/:wid/files/uploads/:uploadId/complete', async (req, res) => {
    const workspaceId = id(req.params.wid);
    const uploadId = id(req.params.uploadId);
    await resolveWorkspace({ ...scope(req), permission: 'content:create' });
    const pending = await models.Upload.findOne({ _id: uploadId, workspaceId, initiatedBy: actor(req) }).lean();
    if (!pending) throw missing();
    if (pending.state === 'completed') {
      const node = await visibleNode(models, workspaceId, pending.nodeId);
      return res.json((await nodeDtos(models, [node]))[0]);
    }
    if (pending.state !== 'initiated' || new Date(pending.expiresAt).getTime() <= Date.now()) throw conflict('Yükleme süresi dolmuş veya yükleme iptal edilmiş.');
    const pendingNode = await models.DriveNode.findOne({ _id: pending.nodeId, workspaceId, status: 'pending-upload' }).lean();
    if (!pendingNode) throw missing();
    const pendingAncestors = await activeChain(models, workspaceId, pendingNode.parentId);
    if (pendingAncestors.length >= MAX_DEPTH) throw conflict('Dosyanın yeni konumu derinlik sınırını aşıyor.');
    const head = await storage.head(pending.objectKey);
    if (!head) throw conflict('Dosya henüz yüklenmedi.');
    if (head.size !== pending.size || head.mimeType !== pending.mimeType) throw invalid('Yüklenen dosyanın boyutu veya türü uyuşmuyor.');
    // A replayable signed PUT must never alter bytes of an already finalized file.
    // promoteUpload is idempotent and copies/renames into a separate immutable key.
    const sealed = await storage.promoteUpload(pending);
    if (!sealed || sealed.size !== pending.size || sealed.mimeType !== pending.mimeType || sealed.objectKey !== `${pending.objectKey}.sealed`) throw new HttpError(503, 'STORAGE_INTEGRITY_ERROR', 'Dosya güvenle tamamlanamadı.');
    const result = await mutate(req, 'content:create', async ({ workspace }, session) => {
      const upload = await withSession(models.Upload.findOne({ _id: uploadId, workspaceId: workspace._id, initiatedBy: actor(req) }), session).lean();
      if (!upload) throw missing();
      if (upload.state === 'completed') return (await nodeDtos(models, [await visibleNode(models, workspace._id, upload.nodeId, session)], session))[0];
      if (upload.state !== 'initiated' || new Date(upload.expiresAt).getTime() <= Date.now()) throw conflict('Yükleme süresi dolmuş veya yükleme iptal edilmiş.');
      const node = await withSession(models.DriveNode.findOne({ _id: upload.nodeId, workspaceId: workspace._id, status: 'pending-upload' }), session).lean();
      if (!node) throw missing();
      const ancestors = await activeChain(models, workspace._id, node.parentId, { session });
      if (ancestors.length >= MAX_DEPTH) throw conflict('Dosyanın yeni konumu derinlik sınırını aşıyor.');
      const updated = await models.DriveNode.findOneAndUpdate({ _id: node._id, workspaceId: workspace._id, status: 'pending-upload' }, { $set: { status: 'active', objectKey: sealed.objectKey, storageState: 'ready' }, $inc: { version: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!updated) throw conflict('Yükleme değişmiş.');
      await models.Upload.updateOne({ _id: uploadId, workspaceId: workspace._id, state: 'initiated' }, { $set: { state: 'completed' } }, { session });
      await models.Workspace.updateOne({ _id: workspace._id, status: 'active' }, { $inc: { storageReserved: -upload.size, storageUsed: upload.size } }, { session });
      await audit({ models, workspaceId: workspace._id, actorId: actor(req), action: 'file.upload-completed', targetId: node._id, session });
      return (await nodeDtos(models, [updated], session))[0];
    });
    res.json(result);
  });

  router.get('/workspaces/:wid/files/:fid/content', async (req, res) => {
    await readScope(req);
    const node = await visibleNode(models, id(req.params.wid), id(req.params.fid));
    if (node.kind !== 'file' || node.storageState !== 'ready') throw missing();
    const objectKey = nodeObjectKey(node);
    const head = await storage.head(objectKey);
    if (!head || head.size !== node.size) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Dosya şu anda indirilemiyor.');
    const etag = `"${node._id}-${node.version}"`;
    let range;
    try { range = parseByteRange(req.headers['if-range'] && req.headers['if-range'] !== etag ? undefined : req.headers.range, node.size); }
    catch (error) { res.set('Content-Range', `bytes */${node.size}`); throw error; }
    res.set({ 'Content-Type': node.mimeType || 'application/octet-stream', 'Content-Disposition': disposition(node.name), 'Content-Length': String(range ? range.end - range.start + 1 : node.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', ETag: etag });
    if (range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${node.size}`);
    if (req.method === 'HEAD') return res.end();
    const controller = new AbortController();
    let source;
    const disconnected = () => { controller.abort(); source?.destroy(); };
    const monitor=createStreamAccessMonitor({models,req,workspaceId:node.workspaceId,nodeId:node._id,nodeKind:'file',objectKey,signal:controller.signal,onRevoke:()=>{disconnected();res.destroy();}});
    res.once('close', disconnected);
    try {
      if (res.destroyed) return;
      await monitor.start();
      if (res.destroyed) return;
      source = await storage.read(objectKey, { ...(range || {}), signal: controller.signal });
      if (res.destroyed) { source.destroy(); return; }
      await pipeline(source, res);
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) throw error;
      res.destroy(error);
    } finally {
      monitor.stop();
      res.off('close', disconnected);
      controller.abort();
      source?.destroy();
    }
  });

  router.get('/workspaces/:wid/folders/:nid/archive', async (req, res) => {
    const context=await readScope(req);
    const workspaceId = id(req.params.wid);
    const folder = await visibleNode(models, workspaceId, id(req.params.nid));
    if (folder.kind !== 'folder') throw missing();
    const entries = await tree(models, workspaceId, folder, { maxNodes: config.maxArchiveNodes || 1000, maxBytes: config.maxArchiveBytes || 100 * 1024 * 1024 });
    const used = new Set();
    const paths = new Map();
    const prepared = [];
    for (const item of entries) {
      const parentPath = item.node._id === folder._id ? '' : paths.get(item.node.parentId);
      if (parentPath === undefined) throw conflict('Klasör ağacı geçersiz.');
      let leaf = archiveSegment(item.node.name);
      let path = parentPath ? `${parentPath}/${leaf}` : leaf;
      let duplicate = 0;
      while (used.has(path.toLocaleLowerCase('en-US'))) {
        leaf = `${archiveSegment(item.node.name).slice(0, 130)}_${item.node._id}${duplicate ? `_${duplicate}` : ''}`;
        path = parentPath ? `${parentPath}/${leaf}` : leaf;
        duplicate++;
      }
      used.add(path.toLocaleLowerCase('en-US'));
      paths.set(item.node._id, path);
      if (item.node.kind === 'folder') prepared.push({ path, folder: true });
      else {
        if (item.node.storageState !== 'ready') throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Arşivdeki dosyalardan biri hazır değil.');
        prepared.push({ path, key: nodeObjectKey(item.node), date: new Date(item.node.updatedAt) });
      }
    }
    // Validate the whole bounded manifest before starting any storage streams.
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': disposition(`${folder.name}.zip`), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    const archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: false });
    const controller = new AbortController();
    const sources = new Set();
    const cancel = () => {
      controller.abort();
      for (const source of sources) source.destroy();
      archive.abort();
      archive.destroy();
    };
    const monitor=createStreamAccessMonitor({models,req,workspaceId,nodeId:folder._id,nodeKind:'folder',contentVersion:context.workspace.contentVersion ?? 0,signal:controller.signal,onRevoke:()=>{cancel();res.destroy();}});
    for (const item of prepared) {
      if (item.folder) archive.append('', { name: `${item.path}/`, type: 'directory' });
      else {
        const source = Readable.from((async function* () {
          if (controller.signal.aborted) return;
          let input;
          try {
            input = await storage.read(item.key, { signal: controller.signal });
            sources.add(input);
            if (controller.signal.aborted) return;
            yield* input;
          } finally {
            if (input) { sources.delete(input); input.destroy(); }
          }
        })());
        sources.add(source);
        source.once('close', () => sources.delete(source));
        archive.append(source, { name: item.path, date: item.date });
      }
    }
    const disconnected = () => { if (!res.writableFinished) cancel(); };
    res.once('close', disconnected);
    try {
      if (res.destroyed) { cancel(); return; }
      await monitor.start();
      if (res.destroyed) return;
      await Promise.all([archive.finalize(), pipeline(archive, res)]);
    } catch (error) {
      cancel();
      if (res.destroyed) return;
      if (!res.headersSent) throw error;
      res.destroy(error);
    } finally {
      monitor.stop();
      res.off('close', disconnected);
      cancel();
    }
  });

  return router;
}
