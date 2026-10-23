import { randomBytes } from 'node:crypto'
import { parseEnv } from 'node:util'
import { readFile, mkdir, lstat, realpath, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConfig } from '../src/config.mjs'

function checkedOrigin(value, suffix) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.origin !== value || !url.hostname.endsWith(suffix) || url.username || url.password) throw new Error('INVALID_ORIGIN')
  return value
}
export function createDeploymentSettings({ source, publicOrigin, upstreamOrigin, reuseCurrentData = false, edgeKey = randomBytes(32).toString('hex') }) {
  if (!reuseCurrentData) throw new Error('DATA_REUSE_CONFIRMATION_REQUIRED')
  checkedOrigin(publicOrigin, '.pages.dev')
  checkedOrigin(upstreamOrigin, '.code.run')
  if (!/^[a-z0-9-]+\.pages\.dev$/.test(new URL(publicOrigin).hostname)) throw new Error('PREVIEW_ORIGIN_NOT_ALLOWED')
  const backend = {}
  for (const name of ['MONGODB_URI', 'OUTBOX_ENCRYPTION_KEY', 'UPLOAD_SIGNING_KEY', 'PAGINATION_SIGNING_KEY', 'OPERATIONS_TOKEN', 'BACKUP_ENCRYPTION_KEY', 'STORAGE_DRIVER', 'S3_REGION', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    if (source[name]) backend[name] = source[name]
  }
  Object.assign(backend, { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '4100', FRONTEND_ORIGIN: publicOrigin, API_ORIGIN: publicOrigin, TRUSTED_PROXY_CIDRS: '', EDGE_PROXY_TOKEN: edgeKey })
  const config = createConfig(backend)
  if (!backend.S3_ACCESS_KEY_ID || !backend.S3_SECRET_ACCESS_KEY || !backend.SMTP_USER || !backend.SMTP_PASSWORD || !backend.MAIL_FROM || !backend.GOOGLE_CLIENT_ID || !backend.GOOGLE_CLIENT_SECRET) throw new Error('PROVIDER_SETUP_REQUIRED')
  backend.PAGINATION_SIGNING_KEY = config.paginationSigningKey
  backend.OPERATIONS_TOKEN = config.operationsToken
  backend.BACKUP_ENCRYPTION_KEY ||= randomBytes(32).toString('hex')
  const cloudflare = { PUBLIC_APP_ORIGIN: publicOrigin, UPSTREAM_API_ORIGIN: upstreamOrigin, EDGE_PROXY_TOKEN: edgeKey }
  return { backend, cloudflare }
}
export function serializeSettings(settings) {
  const output = Object.entries(settings).map(([name, raw]) => {
    const value = String(raw)
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value)) throw new Error('INVALID_SETTING')
    const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : null
    if (!quote) throw new Error('SETTING_QUOTING_UNSUPPORTED')
    return `${name}=${quote}${value}${quote}`
  }).join('\n') + '\n'
  const restored = parseEnv(output)
  for (const [name, value] of Object.entries(settings)) if (restored[name] !== String(value)) throw new Error('SETTING_ROUNDTRIP_FAILED')
  return output
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2), options = {}
    for (let index = 0; index < args.length; index++) {
      const name = args[index]
      if (name === '--reuse-current-data') { if (options.reuseCurrentData) throw new Error('INVALID_ARGUMENT'); options.reuseCurrentData = true }
      else if (['--public-origin', '--upstream-origin'].includes(name)) {
        const key = name === '--public-origin' ? 'publicOrigin' : 'upstreamOrigin'
        if (options[key] || !args[index + 1]) throw new Error('INVALID_ARGUMENT')
        options[key] = args[++index]
      } else throw new Error('INVALID_ARGUMENT')
    }
    const root = fileURLToPath(new URL('..', import.meta.url))
    const sourcePath = path.join(root, '.env')
    const sourceStat = await lstat(sourcePath)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('REGULAR_ENV_REQUIRED')
    const source = parseEnv(await readFile(sourcePath, 'utf8'))
    const settings = createDeploymentSettings({ source, ...options })
    const payloads = [serializeSettings(settings.backend), serializeSettings(settings.cloudflare)]
    for (const directory of [path.join(root, '.data'), path.join(root, '.data/deployment')]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('REGULAR_DIRECTORY_REQUIRED')
    }
    const files = ['northflank.env', 'cloudflare.env'].map(name => path.join(root, '.data/deployment', name))
    for (const file of files) {
      try { await lstat(file); throw new Error('EXPORT_ALREADY_EXISTS') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const created = []
    try {
      for (let index = 0; index < files.length; index++) { await writeFile(files[index], payloads[index], { flag: 'wx', mode: 0o600 }); created.push(files[index]) }
    } catch (error) { for (const file of created) await unlink(file); throw error }
    console.log('Northflank ve Cloudflare ayarlari Git disindaki .data/deployment klasorune hazirlandi.')
    console.log('Yerel .env degismedi. Mevcut veritabani, R2 deposu ve sifreleme anahtari birlikte korunuyor.')
    console.log('Degerler yazdirilmadi; dis servise ayar gonderilmedi ve yayin baslatilmadi.')
  } catch {
    console.error('Yayin ayarlari hazirlanamadi. HTTPS pages.dev/code.run adreslerini, mevcut servis ayarlarini ve daha once aktarim dosyasi olusturulmadigini kontrol et. Gizli ayrintilar yazdirilmadi.')
    process.exitCode = 1
  }
}
