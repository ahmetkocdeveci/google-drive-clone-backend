import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
const secrets=['OUTBOX_ENCRYPTION_KEY','UPLOAD_SIGNING_KEY','PAGINATION_SIGNING_KEY','OPERATIONS_TOKEN','BACKUP_ENCRYPTION_KEY']
try {
  let source=await readFile('.env','utf8'),changed=false
  for(const name of secrets){
    const expression=new RegExp(`^${name}=(.*)$`,'m'),match=source.match(expression)
    if(match?.[1]?.trim())continue
    const setting=`${name}=${randomBytes(32).toString('hex')}`
    source=match?source.replace(expression,setting):`${source.trimEnd()}\n${setting}\n`;changed=true
  }
  if(changed)await writeFile('.env',source,{mode:0o600})
  console.log('Mevcut ayarlar korundu; eksik bağımsız sırlar tamamlandı. Sırlar terminale yazılmadı.')
}
catch (error) {
  if (error.code !== 'ENOENT') throw error
  let source = await readFile('.env.example', 'utf8')
  for (const name of secrets) source = source.replace(`${name}=`, `${name}=${randomBytes(32).toString('hex')}`)
  await writeFile('.env', source, { flag: 'wx', mode: 0o600 })
  console.log('.env oluşturuldu. Sırlar terminale yazılmadı.')
}
