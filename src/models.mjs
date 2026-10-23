import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
const base = () => ({ _id: {type:String,default:randomUUID} })
const required = type => ({ type, required:true })
const scoped = () => ({...base(),workspaceId:required(String)})
export function createModels(connection) {
  const make = (name, fields, indexes = []) => {
    const schema = new mongoose.Schema(fields, {timestamps:true,strict:'throw',versionKey:false,autoIndex:false})
    for (const [keys, options] of indexes) schema.index(keys,options)
    return connection.model(name,schema)
  }
  return {
    User:make('User',{...base(),name:required(String),emailNormalized:required(String),passwordHash:{type:String,select:false},emailVerifiedAt:{type:Date,default:null},authMutationSequence:{type:Number,default:0},passwordVersion:{type:Number,default:1},status:{type:String,enum:['active','disabled'],default:'active'}},[[{emailNormalized:1},{unique:true}]]),
    Session:make('Session',{...base(),tokenHash:required(String),csrfToken:required(String),userId:{type:String,default:null},passwordVersion:{type:Number,default:1},expiresAt:required(Date),revokedAt:{type:Date,default:null}},[[{tokenHash:1},{unique:true}],[{expiresAt:1},{expireAfterSeconds:0}]]),
    Verification:make('Verification',{...base(),userId:required(String),tokenHash:required(String),expiresAt:required(Date),consumedAt:{type:Date,default:null}},[[{tokenHash:1},{unique:true}],[{expiresAt:1},{expireAfterSeconds:0}]]),
    PasswordReset:make('PasswordReset',{...base(),userId:required(String),tokenHash:required(String),passwordVersion:{type:Number,default:1},expiresAt:required(Date),consumedAt:{type:Date,default:null}},[[{tokenHash:1},{unique:true}],[{expiresAt:1},{expireAfterSeconds:0}],[{userId:1,createdAt:-1},{}]]),
    AuthIdentity:make('AuthIdentity',{...base(),userId:required(String),provider:required(String),subject:required(String)},[[{provider:1,subject:1},{unique:true}],[{userId:1,provider:1},{unique:true}]]),
    OAuthAttempt:make('OAuthAttempt',{...base(),stateHash:required(String),sessionId:required(String),nonce:required(String),codeVerifier:required(String),returnTo:required(String),invitationContext:{type:String,maxLength:512},intent:{type:String,enum:['login','link'],default:'login'},userId:String,passwordVersion:Number,authMutationSequence:Number,expiresAt:required(Date),consumedAt:{type:Date,default:null}},[[{stateHash:1},{unique:true}],[{expiresAt:1},{expireAfterSeconds:0}]]),
    Workspace:make('Workspace',{...base(),name:required(String),description:{type:String,default:''},color:{type:String,default:'#1a73e8'},createdBy:required(String),status:{type:String,enum:['active','deleting','deleted'],default:'active'},ownerCount:{type:Number,default:1},authorizationVersion:{type:Number,default:1},mutationSequence:{type:Number,default:0},contentVersion:{type:Number,default:0},storageUsed:{type:Number,default:0},storageReserved:{type:Number,default:0},storageLimit:{type:Number,default:5*1024**3}}),
    Membership:make('Membership',{...scoped(),userId:required(String),role:{type:String,enum:['owner','editor','viewer'],required:true},status:{type:String,enum:['active','removed'],default:'active'},version:{type:Number,default:1}},[[{workspaceId:1,userId:1},{unique:true}],[{userId:1,status:1,createdAt:1,_id:1},{}],[{workspaceId:1,status:1,createdAt:1,_id:1},{}]]),
    Invitation:make('Invitation',{...scoped(),emailNormalized:required(String),role:{type:String,enum:['editor','viewer'],required:true},status:{type:String,enum:['pending','accepted','revoked'],default:'pending'},tokenHash:required(String),expiresAt:required(Date),invitedBy:required(String),acceptedBy:{type:String,default:null},version:{type:Number,default:1}},[[{workspaceId:1,emailNormalized:1},{unique:true}],[{tokenHash:1},{unique:true}]]),
    DriveNode:make('DriveNode',{...scoped(),parentId:{type:String,default:null},name:required(String),kind:{type:String,enum:['file','folder'],required:true},mimeType:{type:String,default:''},size:{type:Number,default:0},createdBy:required(String),version:{type:Number,default:1},status:{type:String,enum:['pending-upload','active','deleting','deleted'],default:'active'},objectKey:String,storageState:String},[[{workspaceId:1,parentId:1,status:1},{}],[{workspaceId:1,updatedAt:-1},{}]]),
    Upload:make('Upload',{...scoped(),nodeId:required(String),initiatedBy:required(String),objectKey:required(String),expiresAt:required(Date),state:{type:String,enum:['initiated','completed','cancelled','expired'],default:'initiated'},size:required(Number),mimeType:required(String)},[[{workspaceId:1,nodeId:1},{unique:true}],[{state:1,expiresAt:1},{}]]),
    AuditEvent:make('AuditEvent',{...scoped(),actorId:required(String),action:required(String),targetId:String,requestId:String},[[{workspaceId:1,createdAt:-1,_id:1},{}]]),
    Job:make('Job',{...scoped(),type:required(String),targetId:required(String),status:{type:String,enum:['pending','running','done','failed'],default:'pending'},attempts:{type:Number,default:0},availableAt:{type:Date,default:Date.now},leaseUntil:{type:Date,default:null}},[[{status:1,availableAt:1,leaseUntil:1},{}]]),
    Archive:make('Archive',{...scoped(),nodeId:required(String),requestedBy:required(String),status:{type:String,enum:['pending','running','ready','failed','cancelled','expired'],default:'pending'},buildAttempt:{type:Number,default:0},cleanupNextAttempt:{type:Number,default:0},objectKey:String,filename:required(String),processedFiles:{type:Number,default:0},totalFiles:{type:Number,default:0},bytes:{type:Number,default:0},sourceMutationSequence:Number,expiresAt:required(Date),errorCode:String},[[{workspaceId:1,requestedBy:1,createdAt:-1},{}],[{status:1,expiresAt:1},{}]]),
    Outbox:make('Outbox',{...base(),scope:{type:String,enum:['identity','workspace'],required:true},purpose:{type:String,enum:['verification','password-reset','invitation'],default(){return this.scope==='workspace'?'invitation':'verification'}},workspaceId:{type:String,required(){return this.scope==='workspace'}},userId:{type:String,required(){return this.scope==='identity'}},verificationId:{type:String,required(){return this.scope==='identity' && this.purpose!=='password-reset'}},resetId:{type:String,required(){return this.purpose==='password-reset'}},invitationId:{type:String,required(){return this.scope==='workspace'}},invitationVersion:{type:Number,required(){return this.scope==='workspace'}},ciphertext:required(String),status:{type:String,enum:['pending','sending','sent','cancelled','failed'],default:'pending'},attempts:{type:Number,default:0},availableAt:{type:Date,default:Date.now},leaseUntil:{type:Date,default:null}},[[{status:1,availableAt:1,leaseUntil:1},{}]]),
    RateLimit:make('RateLimit',{...base(),key:required(String),count:{type:Number,default:0},expiresAt:required(Date)},[[{key:1},{unique:true}],[{expiresAt:1},{expireAfterSeconds:0}]]),
  }
}
export async function connectDatabase(uri) {
  const connection = mongoose.createConnection(uri,{serverSelectionTimeoutMS:15000,autoIndex:false})
  try {
    await connection.asPromise()
    const topology = await connection.db.admin().command({hello:1})
    if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('MongoDB replica set is required for transactions.')
    const models = createModels(connection)
    for (const model of Object.values(models)) { await model.createCollection(); await model.createIndexes() }
    return {connection,models}
  } catch(error) { await connection.close().catch(()=>{}); throw error }
}
