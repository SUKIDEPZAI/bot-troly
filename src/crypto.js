import crypto from 'node:crypto';
const alg='aes-256-gcm';
function key(){const raw=process.env.AI_SECRET_KEY||'';if(!raw) throw new Error('AI_SECRET_KEY is required');return crypto.createHash('sha256').update(raw).digest();}
export function encrypt(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv(alg,key(),iv);const enc=Buffer.concat([c.update(String(value),'utf8'),c.final()]);return [iv.toString('base64url'),c.getAuthTag().toString('base64url'),enc.toString('base64url')].join('.');}
export function decrypt(value){const [iv,tag,data]=String(value).split('.');const d=crypto.createDecipheriv(alg,key(),Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8');}
export function mask(value){const s=String(value||'');return s.length<8?'••••••••':`${s.slice(0,3)}••••••••${s.slice(-4)}`;}
