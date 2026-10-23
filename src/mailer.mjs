import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import nodemailer from 'nodemailer'
export function createMailer({models,config,transport=nodemailer.createTransport(config.smtp)}) {
  const key = Buffer.from(config.outboxEncryptionKey,'hex')
  function encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64')
  }
  function decrypt(value) {
    const bytes = Buffer.from(value,'base64'), cipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12))
    cipher.setAuthTag(bytes.subarray(12,28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'))
  }
  return {
    async enqueuePasswordReset({user,token,reset},session) {
      const record=reset || await models.PasswordReset.findOne({userId:user._id,tokenHash:createHash('sha256').update(token).digest('hex')}).session(session)
      if(!record) throw new Error('Password reset must be saved before enqueuing mail')
      const link=`${config.frontendOrigin}/reset-password#token=${encodeURIComponent(token)}`
      await models.Outbox.create([{scope:'identity',purpose:'password-reset',userId:user._id,resetId:record._id,ciphertext:encrypt({to:user.emailNormalized,subject:'Ortak Drive — şifreni sıfırla',text:`Merhaba ${user.name},\n\nŞifreni sıfırlamak için bağlantıyı aç:\n${link}\n\nBu bağlantı 1 saat geçerlidir. İşlemi sen istemediysen bu mesajı yok sayabilirsin. Şifre değişince tüm oturumların kapatılır.`})}],{session})
    },
    async enqueueVerification({user,token},session) {
      const link = `${config.frontendOrigin}/verify-email#token=${encodeURIComponent(token)}`
      const verification=await models.Verification.findOne({userId:user._id,tokenHash:createHash('sha256').update(token).digest('hex')}).session(session)
      if(!verification) throw new Error('Verification must be saved before enqueuing mail')
      await models.Outbox.create([{scope:'identity',userId:user._id,verificationId:verification._id,ciphertext:encrypt({to:user.emailNormalized,subject:'Ortak Drive — e-posta adresini doğrula',text:`Merhaba ${user.name},\n\nE-posta adresini doğrulamak için bağlantıyı aç:\n${link}\n\nBu bağlantı 1 saat geçerlidir.`})}],{session})
    },
    async enqueueInvitation({invitation,workspace,inviter,token},session) {
      const link = `${config.frontendOrigin}/invitations/accept#token=${encodeURIComponent(token)}`
      await models.Outbox.create([{scope:'workspace',workspaceId:workspace._id,invitationId:invitation._id,invitationVersion:invitation.version,ciphertext:encrypt({to:invitation.emailNormalized,subject:`${workspace.name} çalışma alanına davet`,text:`${inviter.name}, seni ${workspace.name} çalışma alanına ${invitation.role} rolüyle davet etti.\n\n${link}\n\nBağlantıyı açıp davet edilen adresinle giriş yap ve daveti kabul et.`})}],{session})
    },
    async drain(limit=20) {
      let processed=0
      for (;processed<limit;processed++) {
        const now = new Date()
        const item = await models.Outbox.findOneAndUpdate({availableAt:{$lte:now},$or:[{status:'pending'},{status:'sending',leaseUntil:{$lte:now}}]},{$set:{status:'sending',leaseUntil:new Date(Date.now()+120000)},$inc:{attempts:1}},{returnDocument:'after',sort:{createdAt:1}})
        if (!item) break
        const claim={_id:item._id,status:'sending',attempts:item.attempts,...(item.scope==='workspace'?{workspaceId:item.workspaceId}:{userId:item.userId})}
        try {
          let valid = true
          if (item.scope==='workspace') {
            const workspace = await models.Workspace.exists({_id:item.workspaceId,status:'active'})
            const invitation = await models.Invitation.exists({_id:item.invitationId,workspaceId:item.workspaceId,status:'pending',version:item.invitationVersion,expiresAt:{$gt:new Date()}})
            valid = !!workspace && !!invitation
          } else if(item.purpose==='password-reset') valid=!!await models.User.exists({_id:item.userId,status:'active'}) && !!await models.PasswordReset.exists({_id:item.resetId,userId:item.userId,consumedAt:null,expiresAt:{$gt:new Date()}})
          else valid = !!await models.User.exists({_id:item.userId,status:'active',emailVerifiedAt:null}) && !!await models.Verification.exists({_id:item.verificationId,userId:item.userId,consumedAt:null,expiresAt:{$gt:new Date()}})
          if (valid) await transport.sendMail({from:config.mailFrom,...decrypt(item.ciphertext),messageId:`<${item._id}@ortak-drive.local>`})
          await models.Outbox.updateOne(claim,{$set:{status:valid?'sent':'cancelled',leaseUntil:null,ciphertext:'[erased]'}})
        } catch {
          // Error content may contain SMTP credentials or links; never log it.
          await models.Outbox.updateOne(claim,{$set:{status:item.attempts>=10?'failed':'pending',leaseUntil:null,availableAt:new Date(Date.now()+Math.min(3600000,1000*2**item.attempts))}})
        }
      }
      return processed
    },
    close() { transport.close?.() },
  }
}
