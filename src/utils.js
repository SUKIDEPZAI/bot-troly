// Tiện ích dùng chung (không phụ thuộc package ngoài → dễ test).

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const truncate = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
};
export const fmtMs = ms => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
export const fmtDuration = sec => {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
};
export const csv = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
export const envInt = (key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};

/** Bỏ khối <think>…</think> mà một số model reasoning trả về. */
export function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}

/** Xóa API key khỏi chuỗi lỗi trước khi log/hiển thị. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && String(s).length >= 8) out = out.split(String(s)).join('***');
  return out;
}

/**
 * Chia văn bản thành các đoạn ≤ max ký tự, ưu tiên ngắt ở xuống dòng/khoảng trắng,
 * và đóng/mở lại code fence (```) để Markdown không bị vỡ giữa các tin nhắn.
 */
export function chunkText(text, max = 1900) {
  const out = [];
  let rest = String(text || '').trim();
  if (!rest) return [''];
  let carry = null; // ngôn ngữ của code fence đang mở từ đoạn trước (null = không mở)
  while (rest.length) {
    const prefix = carry === null ? '' : `\`\`\`${carry}\n`;
    const room = max - prefix.length - 4; // chừa chỗ cho "\n```"
    if (rest.length <= room) { out.push(prefix + rest); break; }
    let cut = rest.lastIndexOf('\n', room);
    if (cut < room * 0.5) cut = rest.lastIndexOf(' ', room);
    if (cut < room * 0.3) cut = room;
    let piece = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^[ \t]*\n?/, '');
    let state = carry;
    for (const m of piece.matchAll(/```([^\n`]*)/g)) state = state === null ? m[1].trim() : null;
    if (state !== null) piece += '\n```';
    out.push(prefix + piece);
    carry = state;
  }
  return out;
}

/** Giới hạn đồng thời + hàng đợi (tránh bắn quá nhiều request AI cùng lúc). */
export function createLimiter(max, maxQueue = 50) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return {
    run: fn => new Promise((resolve, reject) => {
      if (queue.length >= maxQueue) return reject(Object.assign(new Error('Bot đang quá tải, thử lại sau ít giây.'), { code: 'BUSY' }));
      queue.push({ fn, resolve, reject });
      pump();
    }),
    get active() { return active; },
    get waiting() { return queue.length; }
  };
}

/** Cooldown theo khóa (user/channel). hit() trả về số ms còn phải chờ (0 = được phép, đồng thời bắt đầu cooldown mới). */
export class Cooldowns {
  constructor(maxSize = 5000) { this.map = new Map(); this.maxSize = maxSize; }
  hit(key, ms, now = Date.now()) {
    const until = this.map.get(key) || 0;
    if (until > now) return until - now;
    this.map.set(key, now + ms);
    if (this.map.size > this.maxSize) this.sweep(now);
    return 0;
  }
  sweep(now = Date.now()) { for (const [k, v] of this.map) if (v <= now) this.map.delete(k); }
}

/** Gom kết quả của nhiều promise: dừng khi hết hạn, hoặc khi đã đủ `enough` kết quả + thêm `graceMs`. */
export function collectAnswers(tasks, { deadlineMs = 14000, enough = 3, graceMs = 1500 } = {}) {
  return new Promise(resolve => {
    const answers = [];
    let pending = tasks.length, done = false, grace = null;
    let deadline = null;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(deadline); clearTimeout(grace);
      resolve(answers.slice());
    };
    if (!tasks.length) return finish();
    deadline = setTimeout(finish, deadlineMs);
    for (const t of tasks) {
      Promise.resolve(t).then(v => {
        if (done) return;
        answers.push(v);
        if (answers.length >= enough && !grace) grace = setTimeout(finish, graceMs);
      }, () => {}).finally(() => { if (--pending === 0) finish(); });
    }
  });
}

export const stats = { startedAt: Date.now(), messages: 0, councils: 0, errors: 0, ratelimited: 0 };
