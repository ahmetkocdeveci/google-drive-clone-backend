import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Only parse the checked-in templates. Do not load or create production secrets.
const directory = fileURLToPath(new URL('..', import.meta.url))
const result = spawnSync(process.env.DOCKER_BIN || 'docker', [
  'compose', '--env-file', 'deploy/.env.example', '-f', 'deploy/compose.yaml',
  'config', '--no-env-resolution', '--quiet',
], {
  cwd: directory,
  env: { ...process.env, DRIVE_API_ENV_FILE: '.env.production.example' },
  stdio: 'inherit',
  shell: false,
})
if (result.error) {
  console.error('Docker Compose çalıştırılamadı; Docker kurulumunu veya DOCKER_BIN yolunu kontrol et.')
  process.exit(1)
}
if (result.status !== 0) process.exit(result.status || 1)
console.log('Üretim Compose şablonu örnek ayarlarla doğrulandı; servis başlatılmadı.')
