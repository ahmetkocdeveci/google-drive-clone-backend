import { existsSync } from 'node:fs'
import path from 'node:path'
import { isIP, BlockList } from 'node:net'
import {createHmac} from 'node:crypto'
import { z } from 'zod'
if (existsSync('.env')) process.loadEnvFile('.env')
function trustedProxyCidrs(value) {
  if (value === undefined || value === '') return Object.freeze([])
  const invalid = () => new Error('TRUSTED_PROXY_CIDRS must contain at most 32 explicit IP addresses or CIDRs; global networks and aliases are forbidden.')
  if (typeof value !== 'string' || value.length > 4096) throw invalid()
  const entries = value.split(',').map(entry => entry.trim())
  if (entries.length > 32) throw invalid()
  for (const entry of entries) {
    const parts = entry.split('/')
    const address = parts[0]
    const family = isIP(address)
    if (!family || address.includes('%') || parts.length > 2) throw invalid()
    const maximum = family === 4 ? 32 : 128
    const prefix = parts.length === 1 ? maximum : Number(parts[1])
    if ((parts.length === 2 && !/^[0-9]{1,3}$/.test(parts[1])) || !Number.isInteger(prefix) || prefix < 1 || prefix > maximum) throw invalid()
    if (family === 6) {
      // An IPv6 network can also encompass every IPv4-mapped peer (e.g. ::ffff:0:0/96).
      const network = new BlockList()
      network.addSubnet(address, prefix, 'ipv6')
      if (network.check('::ffff:0.0.0.0', 'ipv6') && network.check('::ffff:255.255.255.255', 'ipv6')) throw invalid()
    }
  }
  return Object.freeze([...new Set(entries)])
}
export function createConfig(env = process.env) {
  const production = env.NODE_ENV === 'production'
  const origin = value => {
    const result = z.url().parse(value).replace(/\/$/, '')
    if (!['http:', 'https:'].includes(new URL(result).protocol)) throw new Error('Origins must use HTTP or HTTPS.')
    return result
  }
  const frontendOrigin = origin(env.FRONTEND_ORIGIN || 'http://127.0.0.1:4179')
  const apiOrigin = origin(env.API_ORIGIN || 'http://127.0.0.1:4100')
  for (const value of [frontendOrigin, apiOrigin]) if (new URL(value).origin !== value) throw new Error('Origins must not contain a path, query or credentials.')
  const secret = name => z.string().regex(/^[a-f0-9]{64}$/i, `${name}: run npm run setup`).parse(env[name])
  const googleClientId = z.string().trim().parse(env.GOOGLE_CLIENT_ID || '')
  const googleClientSecret = z.string().trim().parse(env.GOOGLE_CLIENT_SECRET || '')
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.')
  const config = {
    production, host: env.HOST || '127.0.0.1', port: Number(env.PORT || 4100),
    trustedProxyCidrs: trustedProxyCidrs(env.TRUSTED_PROXY_CIDRS),
    frontendOrigin, apiOrigin, mongodbUri: z.string().min(1).parse(env.MONGODB_URI),
    cookieName: production ? '__Host-drive-session' : 'drive-session', sessionTtlMs: 7 * 86400000,
    invitationTtlMs: 72 * 3600000, workspaceStorageLimit: 5 * 1024 ** 3,
    maxUploadBytes: 25 * 1024 ** 2, maxArchiveBytes: 100 * 1024 ** 2, maxArchiveNodes: 1000,
    outboxEncryptionKey: secret('OUTBOX_ENCRYPTION_KEY'), uploadSigningKey: secret('UPLOAD_SIGNING_KEY'),
    paginationSigningKey: env.PAGINATION_SIGNING_KEY ? secret('PAGINATION_SIGNING_KEY') : createHmac('sha256',secret('UPLOAD_SIGNING_KEY')).update('ortak-drive/pagination/v1').digest('hex'),
    operationsToken: env.OPERATIONS_TOKEN ? secret('OPERATIONS_TOKEN') : createHmac('sha256',secret('UPLOAD_SIGNING_KEY')).update('ortak-drive/operations/v1').digest('hex'),
    maxAsyncArchiveBytes:1024**3,maxAsyncArchiveNodes:100000,archiveTtlMs:3600000,
    storageDriver: env.STORAGE_DRIVER || 'local', localStoragePath: path.resolve(env.LOCAL_STORAGE_PATH || '.data/objects'),
    smtp: { host: env.SMTP_HOST || '127.0.0.1', port: Number(env.SMTP_PORT || 1025), secure: env.SMTP_SECURE === 'true', requireTLS:production, connectionTimeout:10000,greetingTimeout:10000,socketTimeout:30000, ...(env.SMTP_USER ? {auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD}} : {}) },
    mailFrom: env.MAIL_FROM || 'Ortak Drive <noreply@ortak-drive.local>',
    googleClientId, googleClientSecret,
    s3: { region: env.S3_REGION || 'auto', endpoint: env.S3_ENDPOINT || undefined, bucket: env.S3_BUCKET || '', forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', credentials: env.S3_ACCESS_KEY_ID ? {accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY} : undefined },
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT')
  if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535) throw new Error('Invalid SMTP_PORT')
  if (!['local','s3'].includes(config.storageDriver)) throw new Error('Unknown STORAGE_DRIVER')
  if (config.storageDriver === 's3' && !config.s3.bucket) throw new Error('S3_BUCKET is required')
  if (production && config.s3.endpoint && !config.s3.endpoint.startsWith('https://')) throw new Error('Production S3 endpoint requires HTTPS.')
  if (production && (!apiOrigin.startsWith('https://') || !frontendOrigin.startsWith('https://') || config.storageDriver !== 's3' || !env.SMTP_HOST)) throw new Error('Production requires HTTPS origins, private S3 storage and SMTP configuration.')
  if (!production && !['127.0.0.1','localhost','::1'].includes(config.host)) throw new Error('Development API must listen on loopback.')
  return Object.freeze(config)
}
