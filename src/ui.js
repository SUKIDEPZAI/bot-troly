// Giao diện: theme chung, embed câu trả lời, nút thao tác, helper cho bảng /admin.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { PROVIDERS } from './providers.js';
import { chunkText, fmtMs, truncate } from './utils.js';

export const VERSION = '13.0';
export const COLORS = { primary: 0x5865F2, ok: 0x57F287, warn: 0xFEE75C, orange: 0xFAA61A, danger: 0xED4245, council: 0x9B59B6, dark: 0x2B2D31 };
export const FOOTER = `AI Council v${VERSION} · /admin`;
export const providerLabel = p => PROVIDERS[String(p || '').toLowerCase()]?.label || p;
export const onOff = v => (v ? '🟢 Bật' : '⚪ Tắt');
export const shortModel = m => truncate(String(m || '').split('/').pop(), 36);

/** Thanh tiến trình ▰▰▰▱▱ */
export function bar(value, max, len = 10) {
  const filled = max > 0 ? Math.round(clamp01(value / max) * len) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}
const clamp01 = n => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export function providerStatus(p, now = Date.now()) {
  if (!p.api_key) return { icon: '🔴', text: 'Chưa giải mã được key' };
  const cooling = p.cooldown_until && new Date(p.cooldown_until).getTime() > now;
  if (cooling) return { icon: '🟠', text: `Tạm nghỉ ${Math.ceil((new Date(p.cooldown_until).getTime() - now) / 1000)}s` };
  if (p.last_error) return { icon: '🟡', text: 'Có lỗi gần đây' };
  if (p.last_ok_at) return { icon: '🟢', text: p.avg_latency_ms ? `OK · ~${fmtMs(p.avg_latency_ms)}` : 'OK' };
  return { icon: '🟢', text: 'Đã lưu key' };
}

export function panel({ title, description = '', color = COLORS.primary, fields = [], footer = FOOTER, thumbnail = null }) {
  const e = new EmbedBuilder().setColor(color).setTitle(truncate(title, 250)).setDescription(truncate(description, 4000) || '\u200b')
    .setFooter({ text: truncate(footer, 200) }).setTimestamp();
  if (fields.length) e.addFields(fields.slice(0, 25).map(f => ({ name: truncate(f.name, 250), value: truncate(f.value, 1000) || '\u200b', inline: Boolean(f.inline) })));
  if (thumbnail) e.setThumbnail(thumbnail);
  return e;
}

// ───────────── Câu trả lời của bot ─────────────

const DIFF_COLOR = { 'DỄ': COLORS.ok, 'TRUNG BÌNH': COLORS.primary, 'KHÓ': COLORS.orange };
const TRUNC_NOTE = '\n\n*⚠️ Câu trả lời bị cắt do giới hạn độ dài — nhắn "tiếp tục" để nhận phần còn lại.*';

export function answerMeta(result, elapsedMs) {
  const diff = result.difficulty?.name || 'DỄ';
  if (result.mode === 'council' && result.council) {
    const c = result.council;
    return {
      color: COLORS.council,
      author: '🧠 Hội đồng AI',
      footer: `${c.members.length}/${c.total} AI${c.judged ? ' · ✍️ đã tổng hợp' : ''} · ⏱ ${fmtMs(elapsedMs)}`,
      detail: c.members.join(' · ')
    };
  }
  return {
    color: DIFF_COLOR[diff] || COLORS.primary,
    author: `🤖 ${diff}`,
    footer: `${providerLabel(result.provider)} · ${shortModel(result.model)} · ⏱ ${fmtMs(elapsedMs)}`,
    detail: ''
  };
}

export function answerButtons({ requesterId, token, council }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ans_regen:${token}`).setLabel(council ? 'Làm lại' : 'Hỏi Hội đồng').setEmoji(council ? '🔄' : '🧠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ans_del:${requesterId}`).setLabel('Xóa').setEmoji('🗑️').setStyle(ButtonStyle.Secondary)
  );
}

/** Trả về mảng payload (mỗi phần ≤ giới hạn Discord). Nút gắn vào phần cuối. */
export function renderAnswer({ result, elapsedMs, canEmbed = true, requesterId, token }) {
  const meta = answerMeta(result, elapsedMs);
  const body = result.truncated ? `${result.text}${TRUNC_NOTE}` : result.text;
  const buttons = [answerButtons({ requesterId, token, council: result.mode === 'council' })];
  if (!canEmbed) {
    const parts = chunkText(body, 1850);
    parts[0] = `**${meta.author}** · *${meta.footer}*\n${parts[0]}`;
    return parts.map((c, i) => ({ content: c.slice(0, 2000), components: i === parts.length - 1 ? buttons : [] }));
  }
  const parts = chunkText(body, 3900);
  return parts.map((c, i) => {
    const e = new EmbedBuilder().setColor(meta.color).setDescription(c);
    if (i === 0) e.setAuthor({ name: meta.author });
    if (i === parts.length - 1) {
      e.setFooter({ text: meta.footer });
      if (meta.detail) e.addFields({ name: 'Đã tham khảo', value: truncate(meta.detail, 1000) });
    }
    return { embeds: [e], components: i === parts.length - 1 ? buttons : [] };
  });
}

/** Lỗi gửi cho NGƯỜI DÙNG trong kênh công khai → không lộ tên provider/model/HTTP; chi tiết chỉ ghi log + /admin. */
export function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (err?.code === 'BUSY' || /chưa có ai khả dụng|chưa cấu hình/i.test(msg)) return msg;
  return 'Các tuyến AI đang bận hoặc gặp lỗi. Mình đã tự thử tuyến dự phòng — bạn thử lại sau vài giây nhé.';
}

export function errorPayload(err, { canEmbed = true } = {}) {
  const text = friendlyError(err);
  if (!canEmbed) return { content: `⚠️ ${text}`.slice(0, 2000) };
  return { embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle('⚠️ AI chưa trả lời được').setDescription(text).setFooter({ text: 'Quản trị viên: /admin → 🩺 KIỂM TRA' })] };
}
