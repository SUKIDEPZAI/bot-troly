import crypto from 'node:crypto';

function key() {
  if (!process.env.AI_SECRET_KEY) throw new Error('Thiếu AI_SECRET_KEY.');
  return crypto.createHash('sha256').update(process.env.AI_SECRET_KEY).digest();
}

export function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(value) {
  if (!value) return '';
  const [ivB64, tagB64, dataB64] = String(value).split('.');
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

/** Chuỗi có đúng định dạng mã hóa của bot: iv(12B).tag(16B).data */
export function looksEncrypted(value) {
  return /^[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/=]+$/.test(String(value || ''));
}
