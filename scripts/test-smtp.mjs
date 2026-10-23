import { pathToFileURL, fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'

/** Sending is opt-in and the recipient is always the configured sender itself. */
export async function testSmtp({ config, transport, sendToSelf = false }) {
  const email = String(config.smtp.auth?.user || '').trim().toLowerCase()
  if (sendToSelf && !/^[a-z0-9][a-z0-9._%+-]*@(gmail|googlemail)\.com$/.test(email)) throw new Error('SENDER_REQUIRED')
  await transport.verify()
  if (!sendToSelf) return { verified: true, submitted: false }
  const result = await transport.sendMail({
    from: { name: 'Ortak Drive', address: email },
    to: email,
    subject: 'Ortak Drive — e-posta testi',
    text: 'Bu mesaj, Ortak Drive uygulamasinin Gmail SMTP baglantisini denemek icin kendi adresine gonderildi.\n\nBu mesaji gelen kutunda goruyorsan test e-postasi sana ulasti. Bu mesaj sifre veya davet baglantisi icermez.',
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  if (!result.accepted?.some(address => String(address).toLowerCase() === email) || result.rejected?.length) throw new Error('SMTP_NOT_ACCEPTED')
  return { verified: true, submitted: true }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let transport
  try {
    const args = process.argv.slice(2)
    if (args.some(arg => arg !== '--send-to-self') || args.length > 1) throw new Error('INVALID_ARGUMENT')
    process.chdir(fileURLToPath(new URL('../', import.meta.url)))
    const { createConfig } = await import('../src/config.mjs')
    const config = createConfig()
    transport = nodemailer.createTransport(config.smtp)
    const result = await testSmtp({ config, transport, sendToSelf: args.includes('--send-to-self') })
    console.log(result.submitted
      ? 'Test e-postasi kendi gonderici adresin icin SMTP sunucusuna teslim edildi. Gmail Gelen Kutusu ve Spam klasorunu kontrol et.'
      : 'SMTP baglantisi dogrulandi. E-posta gonderilmedi. Kendi adresine bir test mesaji icin --send-to-self kullan.')
  } catch (error) {
    const allowed = new Set(['EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'SENDER_REQUIRED', 'SMTP_NOT_ACCEPTED', 'INVALID_ARGUMENT'])
    console.error('SMTP testi tamamlanamadi. Kod:', allowed.has(error.code) ? error.code : allowed.has(error.message) ? error.message : 'SMTP_CHECK_FAILED')
    process.exitCode = 1
  } finally { transport?.close() }
}
