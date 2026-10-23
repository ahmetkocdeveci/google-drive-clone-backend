import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { HttpError } from './errors.mjs';
import { requireAuth, requireVerified } from './auth.mjs';
import { resolveWorkspace, mutateWorkspace, permissions } from './tenant.mjs';
import { visibleNode, archiveSegment, nodeObjectKey, disposition, parseByteRange } from './files.mjs';
import {createArchiveTemporary,removeArchiveTemporary} from './archive-temporary.mjs';
import {createStreamAccessMonitor} from './stream-access.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const missing = () => new HttpError(404, 'ARCHIVE_NOT_FOUND', 'Arşiv bulunamadı.');
const fail = (code, message = 'Arşiv hazırlanamadı. Tekrar dene.') => new HttpError(409, code, message);
const keyFor = archive => `workspaces/${archive.workspaceId}/archives/${archive._id}-${archive.buildAttempt || 0}.zip`;
const dto = row => ({ id: row._id, workspaceId: row.workspaceId, nodeId: row.nodeId, status: row.expiresAt <= new Date() ? 'expired' : row.status, filename: row.filename, processedFiles: row.processedFiles, totalFiles: row.totalFiles, bytes: row.bytes, ...(row.errorCode ? { errorCode: row.errorCode } : {}), expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() });

export function createArchivesRouter({ models, config, storage }) {
  const router = Router();
  router.use('/workspaces/:wid/archives', requireAuth, requireVerified);
  const identity = req => ({ models, workspaceId: req.params.wid, userId: req.auth.user._id, permission: 'content:read' });
  async function own(req) {
    if (!uuid(req.params.wid) || !uuid(req.params.aid)) throw missing();
    const context = await resolveWorkspace(identity(req));
    const archive = await models.Archive.findOne({ _id: req.params.aid, workspaceId: req.params.wid, requestedBy: req.auth.user._id });
    if (!archive) throw missing();
    return { archive, context };
  }
  router.post('/workspaces/:wid/archives', async (req, res) => {
    if (!uuid(req.params.wid) || !req.body || Object.keys(req.body).length !== 1 || !uuid(req.body.nodeId)) throw new HttpError(400, 'INVALID_INPUT', 'Klasör kimliği gerekli.');
    const archive = await mutateWorkspace(identity(req), async ({ workspace }, session) => {
      const folder = await visibleNode(models, workspace._id, req.body.nodeId, session);
      if (folder.kind !== 'folder') throw missing();
      const active = await models.Archive.find({ workspaceId: workspace._id, status: { $in: ['pending', 'running', 'ready'] }, expiresAt: { $gt: new Date() } }).select('requestedBy').limit(6).session(session);
      if (active.length >= 5 || active.filter(item => item.requestedBy === req.auth.user._id).length >= 2) throw new HttpError(429, 'ARCHIVE_LIMIT', 'Önce önceki arşivlerini indirip kapat veya iptal et.');
      const expiresAt = new Date(Date.now() + (config.archiveTtlMs || 3600000));
      const [created] = await models.Archive.create([{ _id: randomUUID(), workspaceId: workspace._id, nodeId: folder._id, requestedBy: req.auth.user._id, filename: `${folder.name}.zip`, sourceMutationSequence: workspace.contentVersion || 0, expiresAt }], { session });
      await models.Job.create([{ workspaceId: workspace._id, type: 'archive-build', targetId: created._id }, { workspaceId: workspace._id, type: 'archive-expiry', targetId: created._id, availableAt: expiresAt }], { session,ordered:true });
      return created;
    });
    res.status(202).json(dto(archive));
  });
  router.get('/workspaces/:wid/archives/:aid', async (req, res) => {
    const { archive, context } = await own(req);
    const result = dto(archive);
    if (result.status === 'ready' && (context.workspace.contentVersion || 0) !== archive.sourceMutationSequence) {
      result.status = 'failed'; result.errorCode = 'ARCHIVE_SOURCE_CHANGED';
      await models.Archive.updateOne({_id:archive._id,workspaceId:archive.workspaceId,status:'ready',buildAttempt:archive.buildAttempt},{$set:{status:'failed',errorCode:result.errorCode}});
    }
    res.json(result);
  });
  router.delete('/workspaces/:wid/archives/:aid', async (req, res) => {
    await own(req);
    await mutateWorkspace(identity(req), async ({ workspace }, session) => {
      const changed=await models.Archive.updateOne({ _id: req.params.aid, workspaceId: workspace._id, requestedBy: req.auth.user._id, status:{$ne:'cancelled'} }, { $set: { status: 'cancelled', errorCode: 'ARCHIVE_CANCELLED' } }, { session });
      if(changed.modifiedCount)await models.Job.updateOne({workspaceId:workspace._id,type:'archive-expiry',targetId:req.params.aid,status:'pending'},{$set:{availableAt:new Date()}},{session});
    });
    res.status(204).end();
  });
  router.get('/workspaces/:wid/archives/:aid/content', async (req, res) => {
    const { archive, context } = await own(req);
    if (archive.expiresAt <= new Date()) throw new HttpError(410, 'ARCHIVE_EXPIRED', 'Arşivin süresi dolmuş. Yeni arşiv hazırla.');
    if (archive.status !== 'ready') throw fail('ARCHIVE_NOT_READY');
    if ((context.workspace.contentVersion || 0) !== archive.sourceMutationSequence) throw fail('ARCHIVE_SOURCE_CHANGED', 'İçerik değişti. Yeni arşiv hazırla.');
    await visibleNode(models, archive.workspaceId, archive.nodeId);
    const key = keyFor(archive);
    if (archive.objectKey !== key) throw new HttpError(503, 'STORAGE_INTEGRITY_ERROR', 'Arşiv okunamıyor.');
    const info = await storage.head(key);
    if (!info || info.size !== archive.bytes) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Arşiv şu anda indirilemiyor.');
    let range;
    try { range = parseByteRange(req.headers.range, info.size); } catch (error) { res.set('Content-Range', `bytes */${info.size}`); throw error; }
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': disposition(archive.filename), 'Content-Length': String(range ? range.end - range.start + 1 : info.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    if (range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    if (req.method === 'HEAD') return res.end();
    const controller = new AbortController();
    let source;
    const cancel = () => { controller.abort(); source?.destroy(); };
    const monitor=createStreamAccessMonitor({models,req,workspaceId:archive.workspaceId,nodeId:archive.nodeId,nodeKind:'folder',contentVersion:archive.sourceMutationSequence,signal:controller.signal,onRevoke:()=>{cancel();res.destroy();},validateExtra:async({options,userId})=>{
      const current=await models.Archive.collection.findOne({_id:archive._id,workspaceId:archive.workspaceId,requestedBy:userId,status:'ready',buildAttempt:archive.buildAttempt,objectKey:key,expiresAt:{$gt:new Date()}},options);
      if(!current)throw fail('ARCHIVE_UNAVAILABLE');
    }});
    res.once('close', cancel);
    try { if (res.destroyed) return; await monitor.start(); if(res.destroyed)return; source = await storage.read(key, { ...(range || {}), signal: controller.signal }); if (res.destroyed) {source.destroy();return;} await pipeline(source, res); }
    catch (error) { if (!res.destroyed) throw error; }
    finally { monitor.stop();res.off('close', cancel); cancel(); }
  });
  return router;
}

/** Stream a disk-backed manifest and private ZIP; no list of file contents is buffered. */
export function createArchiveProcessor({ models, config, storage }) {
  async function check(archive, job) {
    const current = await models.Archive.findOne({ _id: archive._id, workspaceId: archive.workspaceId, status: 'running', buildAttempt:archive.buildAttempt }).lean();
    if (!current) throw fail('ARCHIVE_CANCELLED');
    if (current.expiresAt <= new Date()) throw fail('ARCHIVE_EXPIRED');
    const user = await models.User.findOne({ _id: archive.requestedBy, status: 'active', emailVerifiedAt: { $ne: null } }).select('_id').lean();
    if (!user) throw fail('ARCHIVE_ACCESS_REVOKED');
    const { workspace, membership } = await resolveWorkspace({ models, workspaceId: archive.workspaceId, userId: archive.requestedBy, permission: 'content:read' });
    if (!permissions[membership.role].includes('content:read')) throw fail('ARCHIVE_ACCESS_REVOKED');
    if ((workspace.contentVersion || 0) !== archive.sourceMutationSequence) throw fail('ARCHIVE_SOURCE_CHANGED');
    if (job && !await models.Job.exists({ _id: job._id, workspaceId: archive.workspaceId, status: 'running', attempts: job.attempts })) throw fail('ARCHIVE_LEASE_LOST');
    await visibleNode(models, archive.workspaceId, archive.nodeId);
    return current;
  }
  async function build(job) {
    const claim={_id:job._id,workspaceId:job.workspaceId,status:'running',attempts:job.attempts};
    const archive=await models.Workspace.db.transaction(async session=>{
      const valid=await models.Job.updateOne(claim,{$set:{leaseUntil:new Date(Date.now()+120000)}},{session});
      if(!valid.matchedCount)return null;
      return models.Archive.findOneAndUpdate({_id:job.targetId,workspaceId:job.workspaceId,status:{$in:['pending','running']},$or:[{buildAttempt:{$lt:job.attempts}},{buildAttempt:{$exists:false}}]},{$set:{status:'running',buildAttempt:job.attempts,processedFiles:0,totalFiles:0,bytes:0}},{returnDocument:'after',session}).lean();
    });
    if (!archive) return;
    const directory = await createArchiveTemporary('manifest');
    const controller = new AbortController();
    const inputs = new Set();
    let zip;
    let monitor;
    const stop = reason => { if(!controller.signal.aborted)controller.abort(reason || fail('ARCHIVE_CANCELLED')); for (const input of inputs) input.destroy(); zip?.abort(); zip?.destroy(); };
    const owned={_id:archive._id,workspaceId:archive.workspaceId,status:'running',buildAttempt:archive.buildAttempt};
    const abortable=promise=>{
      if(controller.signal.aborted)return Promise.reject(controller.signal.reason);
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(controller.signal.reason);
        controller.signal.addEventListener('abort',abort,{once:true});
        Promise.resolve(promise).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
      });
    };
    let publication;
    let totalFiles = 0, entries = 0, bytes = 0, manifestBytes = 0;
    try {
      await check(archive, job);
      const manifestPath = path.join(directory, 'manifest.jsonl');
      const writer = createWriteStream(manifestPath, { flags: 'wx', mode: 0o600 });
      const finished = once(writer, 'finish');
      finished.catch(()=>{});
      const append = async value => { const line = `${JSON.stringify(value)}\n`; manifestBytes += Buffer.byteLength(line); if (manifestBytes > 64 * 1024 ** 2) throw fail('ARCHIVE_TOO_LARGE'); if (!writer.write(line)) await once(writer, 'drain'); };
      async function walk(node, name, depth) {
        if (depth > 64 || ++entries > (config.maxAsyncArchiveNodes || 100000)) throw fail('ARCHIVE_TOO_LARGE');
        if (node.kind === 'file') {
          bytes += node.size; totalFiles++;
          if (bytes > (config.maxAsyncArchiveBytes || 1024 ** 3) || node.storageState !== 'ready') throw fail('ARCHIVE_TOO_LARGE');
          await append({ path: name, key: nodeObjectKey(node), size: node.size, date: node.updatedAt });
          return;
        }
        await append({ path: `${name}/`, directory: true });
        const names = new Set();
        const children = models.DriveNode.find({ workspaceId: archive.workspaceId, parentId: node._id, status: 'active' }).sort({ name: 1, _id: 1 }).cursor({ batchSize: 100 });
        try {
          for await (const child of children) {
            if (controller.signal.aborted) throw fail('ARCHIVE_CANCELLED');
            let leaf = archiveSegment(child.name), duplicate = 0;
            while (names.has(leaf.toLowerCase())) leaf = `${archiveSegment(child.name).slice(0, 130)}_${child._id}${duplicate++ ? `_${duplicate}` : ''}`;
            names.add(leaf.toLowerCase());
            await walk(child, `${name}/${leaf}`, depth + 1);
            if (entries % 100 === 0) await check(archive, job);
          }
        } finally { await children.close(); }
      }
      try { const folder = await visibleNode(models, archive.workspaceId, archive.nodeId); await walk(folder, archiveSegment(folder.name), 1); writer.end(); await finished; }
      catch (error) { writer.destroy(error); await finished.catch(() => {}); throw error; }
      await check(archive, job);
      await models.Archive.updateOne(owned, { $set: { totalFiles } });
      zip = new ZipArchive({ zlib: { level: 6 } });
      publication = storage.writeArchive(keyFor(archive), zip, { signal: controller.signal });
      publication.catch(error => stop(error));
      let monitoring = false;
      monitor = setInterval(() => { if (!monitoring) { monitoring = true; void check(archive, job).catch(error => stop(error)).finally(() => { monitoring = false; }); } }, 250);
      const lines = createInterface({ input: createReadStream(manifestPath), crlfDelay: Infinity });
      let processedFiles = 0;
      try {
        for await (const line of lines) {
          const item = JSON.parse(line);
          if (controller.signal.aborted) throw fail('ARCHIVE_CANCELLED');
          await check(archive, job);
          const entry = once(zip, 'entry',{signal:controller.signal});
          entry.catch(()=>{});
          if (item.directory) zip.append('', { name: item.path, type: 'directory' });
          else {
            const source = Readable.from((async function* () {
              let input, read = 0;
              try {
                input = await storage.read(item.key, { signal: controller.signal }); inputs.add(input);
                if (controller.signal.aborted) return;
                for await (const chunk of input) { read += chunk.length; if (read > item.size) throw fail('ARCHIVE_SOURCE_CHANGED'); yield chunk; }
                if (read !== item.size) throw fail('ARCHIVE_SOURCE_CHANGED');
              } finally { if (input) { inputs.delete(input); input.destroy(); } }
            })());
            inputs.add(source); source.once('close', () => inputs.delete(source));
            zip.append(source, { name: item.path, date: new Date(item.date) });
          }
          await abortable(entry);
          if (!item.directory) { processedFiles++; await models.Archive.updateOne(owned, { $set: { processedFiles } }); }
        }
      } finally { lines.close(); }
      await abortable(zip.finalize());
      const info = await publication;
      await check(archive, job);
      await models.Workspace.db.transaction(async session => {
        const valid=await models.Job.updateOne(claim,{$set:{leaseUntil:new Date(Date.now()+120000)}},{session});
        if(!valid.matchedCount)throw fail('ARCHIVE_LEASE_LOST');
        const contentVersion=archive.sourceMutationSequence===0?{$or:[{contentVersion:0},{contentVersion:{$exists:false}}]}:{contentVersion:archive.sourceMutationSequence};
        const workspace = await models.Workspace.findOneAndUpdate({ _id: archive.workspaceId, status: 'active', ...contentVersion }, { $inc: { mutationSequence: 1 } }, { session, returnDocument: 'after' });
        if (!workspace) throw fail('ARCHIVE_SOURCE_CHANGED');
        await resolveWorkspace({ models, workspaceId: archive.workspaceId, userId: archive.requestedBy, permission: 'content:read', session });
        const changed = await models.Archive.updateOne({ ...owned, expiresAt: { $gt: new Date() } }, { $set: { status: 'ready', objectKey: keyFor(archive), bytes: info.size, processedFiles: totalFiles } }, { session });
        if (!changed.modifiedCount) throw fail('ARCHIVE_CANCELLED');
      });
    } catch (error) {
      stop(error);
      const cause=controller.signal.reason instanceof HttpError?controller.signal.reason:error;
      const code = cause instanceof HttpError ? (['FORBIDDEN', 'NOT_FOUND'].includes(cause.code) ? 'ARCHIVE_ACCESS_REVOKED' : cause.code) : 'ARCHIVE_BUILD_FAILED';
      await models.Archive.updateOne(owned, { $set: { status: code === 'ARCHIVE_EXPIRED' ? 'expired' : 'failed', errorCode: code } });
      await publication?.catch(()=>{});
      await storage.delete(keyFor(archive)).catch(() => {});
    } finally { clearInterval(monitor); stop(); await removeArchiveTemporary(directory); }
  }
  async function sweepOldAttempts(archive,{includeCurrent=false}={}) {
    const current=archive.buildAttempt || 0;
    if(!Number.isSafeInteger(current) || current<0 || current>9999999999)throw new Error('Invalid archive attempt');
    if(includeCurrent)await storage.delete(keyFor(archive));
    // Reclaimed leases are not limited to ten claims. Sweep in bounded batches,
    // and wrap the cursor so a delayed old worker publication is collected too.
    const rawStart=archive.cleanupNextAttempt || 0;
    const start=Number.isSafeInteger(rawStart) && rawStart>=0 && rawStart<current?rawStart:0;
    const end=Math.min(current,start+20);
    for(let attempt=start;attempt<end;attempt++)await storage.delete(keyFor({...archive,buildAttempt:attempt}));
    await models.Archive.updateOne({_id:archive._id,workspaceId:archive.workspaceId,buildAttempt:current},{$set:{cleanupNextAttempt:end>=current?0:end}});
  }
  async function expire(job) {
    const archive = await models.Archive.findOne({ _id: job.targetId, workspaceId: job.workspaceId });
    if (!archive) return;
    if (!['cancelled', 'failed', 'expired'].includes(archive.status) && archive.expiresAt > new Date()) return;
    await models.Archive.updateOne({ _id: archive._id, workspaceId: archive.workspaceId, status: { $nin: ['cancelled', 'failed'] } }, { $set: { status: 'expired' } });
    await sweepOldAttempts(archive.toObject(),{includeCurrent:true});
  }
  async function collect(limit = 20) {
    const archives = await models.Archive.find({}).sort({ updatedAt: 1 }).limit(limit).lean();
    for (const archive of archives) { try {
      if(['cancelled','failed','expired'].includes(archive.status) || archive.expiresAt<=new Date())await expire({ targetId: archive._id, workspaceId: archive.workspaceId });
      else await sweepOldAttempts(archive);
      await models.Archive.updateOne({ _id: archive._id, workspaceId: archive.workspaceId }, { $set: { updatedAt: new Date() } });
    } catch { /* Retry on the next pass. */ } }
  }
  async function cancelWorkspace(workspaceId) { await models.Archive.updateMany({ workspaceId, status: { $nin: ['expired', 'cancelled'] } }, { $set: { status: 'cancelled' } }); const rows = models.Archive.find({ workspaceId }).cursor(); try { for await (const row of rows) await expire({targetId:row._id,workspaceId}); } finally { await rows.close(); } }
  return { build, expire, collect, cancelWorkspace };
}
