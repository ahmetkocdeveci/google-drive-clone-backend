import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.mjs';

const stale = () => new HttpError(409, 'PAGINATION_STALE', 'Liste değişmiş. Listeyi yenileyip tekrar dene.');
const invalid = () => new HttpError(400, 'INVALID_CURSOR', 'Sayfalama bilgisi geçersiz.');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = binding => createHash('sha256').update(JSON.stringify(canonical(binding))).digest('hex');
const mac = (config, value) => createHmac('sha256', Buffer.from(config.paginationSigningKey, 'hex')).update(`drive-page-v1:${value}`).digest();
export function parsePageQuery(query, { defaultLimit = 50, maxLimit = 100 } = {}) {
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))) throw invalid();
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  if (limit < 1 || limit > maxLimit || (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 4096))) throw invalid();
  return { limit, cursor: query.cursor || null };
}
export function encodeCursor({ config, binding, position }) {
  const value = Buffer.from(JSON.stringify({ v: 1, b: digest(binding), p: position, exp: Date.now() + 15 * 60000 })).toString('base64url');
  return `${value}.${mac(config, value).toString('base64url')}`;
}
export function decodeCursor({ config, binding, cursor }) {
  if (!cursor) return null;
  if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) throw invalid();
  const [value, signature] = cursor.split('.');
  const supplied = Buffer.from(signature, 'base64url');
  if (!timingSafeEqual(supplied, mac(config, value))) throw invalid();
  let payload;
  try { payload = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { throw invalid(); }
  if (payload.v !== 1 || !payload.p || !Number.isSafeInteger(payload.exp)) throw invalid();
  if (payload.exp < Date.now() || payload.b !== digest(binding)) throw stale();
  return payload.p;
}
export function keysetAfter({ field, direction = 'asc', position, valueType = 'string' }) {
  if (!position) return {};
  if (typeof position.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(position.id)) throw invalid();
  let value = position.value;
  if (valueType === 'date') { value = new Date(value); if (Number.isNaN(value.getTime())) throw invalid(); }
  else if (valueType === 'number') { if (!Number.isSafeInteger(value)) throw invalid(); }
  else if (typeof value !== 'string') throw invalid();
  return { $or: [{ [field]: { [direction === 'desc' ? '$lt' : '$gt']: value } }, { [field]: value, _id: { $gt: position.id } }] };
}
