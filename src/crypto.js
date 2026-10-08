import crypto from 'node:crypto';

let legacyKey = null;
let v2Key = null;
const secret = () => {
  if (!process.env.AI_SECRET_KEY) throw new Error('Thiếu AI_SECRET_KEY.');
  return process.env.AI_SECRET_KEY;
};
// Định dạng cũ (không còn dùng để ghi): SHA-256 trực tiếp. Chỉ giữ để ĐỌC dữ liệu đã lưu.
const keyLegacy = () => (legacyKey ??= crypto.createHash('sha256').update(secret()).digest());
// v2: scrypt (KDF có work factor). Có thể thêm AI_SECRET_SALT để salt riêng cho từng deployment.
const keyV2 = () => (v2Key ??= crypto.scryptSync(secret(), `discord-ai-council/v2/${process.env.AI_SECRET_SALT || ''}`, 32, { N: 2 ** 14, r: 8, p: 1 }));

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyV2(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v2.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(value) {
  if (!value) return '';
  let raw = String(value);
  let key = keyLegacy;
  if (raw.startsWith('v2.')) { raw = raw.slice(3); key = keyV2; }
  const [ivB64, tagB64, dataB64] = raw.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('API key trong database có định dạng không hợp lệ.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function mask(value) {
  const s = String(value || '');
  if (!s) return 'Chưa có';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/** Chuỗi có đúng định dạng mã hóa của bot: [v2.]iv(12B).tag(16B).data */
export function looksEncrypted(value) {
  return /^(?:v2\.)?[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/=]+$/.test(String(value || ''));
}
export const isLegacyCiphertext = value => looksEncrypted(value) && !String(value).startsWith('v2.');
