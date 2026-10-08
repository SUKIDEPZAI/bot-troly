import 'dotenv/config';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  ActivityType, ApplicationCommandOptionType, Client, GatewayIntentBits, InteractionContextType,
  MessageFlags, Partials, PermissionFlagsBits
} from 'discord.js';
import { closeDb, initDb, listProviders, pingDb } from './db.js';
import { handleAdmin } from './admin.js';
import { answer, limiterState } from './chat.js';
import { syncAllProviders } from './catalog.js';
import { clearHistory } from './history.js';
import { isAdmin, interactionIsAdmin } from './permissions.js';
import { channelAllowedBy, getSettings } from './settings.js';
import { COLORS, VERSION, errorPayload, panel, plainPayload, providerLabel, providerStatus, renderAnswer } from './ui.js';
import { Cooldowns, csv, envInt, fmtDuration, fmtMs, stats, truncate } from './utils.js';

for (const k of ['DISCORD_TOKEN', 'DATABASE_URL', 'AI_SECRET_KEY']) if (!process.env[k]) throw new Error(`Thiếu ${k}`);

const PORT = envInt('PORT', 10000, 1, 65535);
const BOT_NAME = process.env.BOT_NAME || 'AI Council';
const USER_CD = envInt('USER_COOLDOWN_MS', 4000, 0);
const COUNCIL_CD = envInt('COUNCIL_COOLDOWN_MS', 12000, 0);
const IGNORE_PREFIXES = process.env.IGNORE_PREFIXES === undefined ? ['!', '$'] : csv(process.env.IGNORE_PREFIXES);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
  // Chặn mọi ping do AI sinh ra (@everyone/@here/role/user) — chống mention injection.
  allowedMentions: { parse: [], repliedUser: false },
  sweepers: { messages: { interval: 300, lifetime: 900 } }
});

const cooldowns = new Cooldowns();
const guildOnly = [InteractionContextType.Guild];
const COMMANDS = [
  { name: 'admin', description: 'Mở bảng điều khiển AI Council (quản trị viên)', contexts: guildOnly },
  {
    name: 'ask', description: 'Hỏi AI một câu', contexts: guildOnly,
    options: [
      { type: ApplicationCommandOptionType.String, name: 'cau_hoi', description: 'Nội dung câu hỏi', required: true, max_length: 2000 },
      { type: ApplicationCommandOptionType.Boolean, name: 'hoi_dong', description: 'Dùng Hội đồng nhiều AI (chậm hơn, chất lượng hơn)' }
    ]
  },
  { name: 'status', description: 'Xem tình trạng bot và các AI', contexts: guildOnly },
  { name: 'clear', description: 'Xóa trí nhớ hội thoại của kênh này', contexts: guildOnly }
];

// ── Lưu tạm câu hỏi để nút "Hỏi Hội đồng / Làm lại" dùng lại (RAM, TTL 30 phút) ──
const pending = new Map();
function remember(data) {
  const token = crypto.randomBytes(5).toString('hex');
  pending.set(token, { ...data, at: Date.now() });
  if (pending.size > 300) for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000 || pending.size > 300) pending.delete(k);
  return token;
}

const displayName = (member, user) => truncate(member?.displayName || user.globalName || user.username, 32);
const canEmbedIn = channel => channel?.permissionsFor?.(client.user)?.has(PermissionFlagsBits.EmbedLinks) ?? true;
// Quyền thực của bot trong kênh nơi lệnh được dùng (interaction cung cấp sẵn appPermissions).
const canEmbedInteraction = i => i.appPermissions?.has?.(PermissionFlagsBits.EmbedLinks) ?? true;
const errId = () => crypto.randomBytes(3).toString('hex');

/** editReply/followUp có fallback: nếu embed bị từ chối thì gửi lại dạng văn bản thường; lỗi cuối cùng được log (không nuốt). */
async function safeSend(i, method, payload) {
  try { return await i[method](payload); }
  catch (err) {
    console.warn(`⚠️ ${method} với embed thất bại (${err?.message || err}) → thử văn bản thường`);
    try { return await i[method](plainPayload(payload)); }
    catch (err2) { console.error(`❌ ${method} dạng văn bản cũng thất bại:`, err2?.message || err2); throw err2; }
  }
}
async function failInteraction(i, err, canEmbed) {
  stats.errors++;
  console.error(`❌ /${i.commandName || 'button'} lỗi:`, err?.message || err);
  await safeSend(i, 'editReply', errorPayload(err, { canEmbed })).catch(() => {});
}
const cleanPrompt = content => String(content || '').replace(new RegExp(`<@!?${client.user.id}>`, 'g'), ' ').replace(/\s+/g, ' ').trim();

// Gửi: reply → (message gốc bị xóa) channel.send → (embed bị từ chối) văn bản thường. Lỗi cuối cùng được ném ra để log.
async function sendToChannel(message, payload, asReply) {
  const attempts = [
    ...(asReply ? [p => message.reply(p)] : []),
    p => message.channel.send(p)
  ];
  let lastErr;
  for (const variant of [payload, plainPayload(payload)]) {
    for (const send of attempts) {
      try { return await send(variant); } catch (err) { lastErr = err; }
    }
  }
  throw lastErr;
}

// ───────────────────────── Tin nhắn thường ─────────────────────────
async function handleMessage(message) {
  let notifyOnError = false;
  try { await handleMessageInner(message, v => { notifyOnError = v; }); }
  catch (err) {
    stats.errors++;
    console.error('❌ messageCreate:', err?.stack || err);
    // Chỉ báo lỗi cho người đang gọi bot trực tiếp (@bot/reply) để không spam khi DB chập chờn.
    if (notifyOnError) await message.reply(errorPayload(err, { canEmbed: canEmbedIn(message.channel) })).catch(() => {});
  }
}

async function handleMessageInner(message, markDirect) {
  if (message.author.bot || message.webhookId || message.system || !message.guild) return;
  const raw = message.content || '';
  if (IGNORE_PREFIXES.some(p => raw.startsWith(p))) return;
  const mentioned = message.mentions.users.has(client.user.id);
  markDirect(mentioned);
  const settings = await getSettings();
  if (!channelAllowedBy(settings, message.channel)) return;

  const refMsg = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  const repliedToBot = refMsg?.author?.id === client.user.id;
  if (repliedToBot) markDirect(true);
  const prompt = cleanPrompt(raw);
  const canEmbed = canEmbedIn(message.channel);
  if (!prompt) {
    if (mentioned || repliedToBot) await message.reply({ content: '👋 Hãy nhập nội dung bạn muốn mình trả lời nhé.' }).catch(() => {});
    return;
  }

  const council = mentioned || repliedToBot;
  if (!isAdmin({ member: message.member, userId: message.author.id })) {
    if (cooldowns.hit(message.author.id, council ? COUNCIL_CD : USER_CD)) {
      stats.ratelimited++;
      await message.react('⏳').catch(() => {});
      return;
    }
  }

  stats.messages++;
  const started = Date.now();
  const sendTyping = () => message.channel.sendTyping().catch(() => {});
  sendTyping();
  const typing = setInterval(sendTyping, 8000); // typing chỉ kéo dài ~10s, AI có thể lâu hơn
  const userName = displayName(message.member, message.author);
  const referenced = refMsg ? (refMsg.content || refMsg.embeds?.[0]?.description || '') : '';
  try {
    const result = await answer({ channelId: message.channelId, userId: message.author.id, userName, text: prompt, referenced, council, settings, botName: BOT_NAME });
    const token = remember({ text: prompt, referenced, userId: message.author.id, userName, channelId: message.channelId });
    const payloads = renderAnswer({ result, elapsedMs: Date.now() - started, canEmbed, requesterId: message.author.id, token });
    for (let n = 0; n < payloads.length; n++) await sendToChannel(message, payloads[n], n === 0);
    console.log(`✅ ${result.mode.toUpperCase()} · ${message.guild.name} #${message.channel.name} · ${result.provider}/${result.model} · ${Date.now() - started}ms`);
  } catch (err) {
    stats.errors++;
    console.error('❌ AI chat error:', err?.message || err);
    await sendToChannel(message, errorPayload(err, { canEmbed }), true).catch(e => console.error('❌ Không gửi được cả thông báo lỗi:', e?.message || e));
  } finally { clearInterval(typing); }
}

// ───────────────────────── Slash commands ─────────────────────────
async function sendInteractionPayloads(i, payloads) {
  await safeSend(i, 'editReply', payloads[0]);
  for (const p of payloads.slice(1)) await safeSend(i, 'followUp', p);
}

async function slashAsk(i) {
  const settings = await getSettings();
  if (!channelAllowedBy(settings, i.channel)) return i.reply({ content: '🔒 Bot không được bật trong kênh này.', flags: MessageFlags.Ephemeral });
  const council = Boolean(i.options.getBoolean('hoi_dong')); // phải đọc TRƯỚC khi áp cooldown để dùng đúng COUNCIL_CD
  if (!interactionIsAdmin(i)) {
    const wait = cooldowns.hit(i.user.id, council ? COUNCIL_CD : USER_CD);
    if (wait) { stats.ratelimited++; return i.reply({ content: `⏳ Chờ ${fmtMs(wait)} rồi hỏi tiếp nhé.`, flags: MessageFlags.Ephemeral }); }
  }
  await i.deferReply();
  stats.messages++;
  const started = Date.now();
  const text = i.options.getString('cau_hoi', true);
  const canEmbed = canEmbedInteraction(i);
  const userName = displayName(i.member, i.user);
  try {
    const result = await answer({ channelId: i.channelId, userId: i.user.id, userName, text, council, settings, botName: BOT_NAME });
    const token = remember({ text, referenced: '', userId: i.user.id, userName, channelId: i.channelId });
    await sendInteractionPayloads(i, renderAnswer({ result, elapsedMs: Date.now() - started, canEmbed, requesterId: i.user.id, token }));
  } catch (err) {
    await failInteraction(i, err, canEmbed);
  }
}

async function slashStatus(i) {
  const canEmbed = canEmbedInteraction(i);
  let payload;
  try {
    const ps = await listProviders();
    const lim = limiterState();
    const lines = ps.length
      ? ps.map(p => { const st = providerStatus(p); return `${st.icon} **${providerLabel(p.name)}** — ${st.text}`; }).join('\n')
      : '_Chưa cấu hình AI nào._';
    payload = { embeds: [panel({
      title: `📡 TÌNH TRẠNG ${BOT_NAME.toUpperCase()}`, description: lines, color: COLORS.primary,
      fields: [
        { name: '⏱ Uptime', value: fmtDuration((Date.now() - stats.startedAt) / 1000), inline: true },
        { name: '🏓 Ping', value: `${Math.round(client.ws.ping)}ms`, inline: true },
        { name: '⚙️ Hàng đợi', value: `${lim.active} chạy · ${lim.waiting} chờ`, inline: true },
        { name: '🗄 Cơ sở dữ liệu', value: health.db ? '🟢 Kết nối tốt' : '🔴 Mất kết nối', inline: true }
      ],
      footer: `v${VERSION} · nhắn bình thường để trò chuyện · @bot để hỏi Hội đồng`
    })] };
  } catch (err) {
    console.error('❌ /status — DB lỗi:', err?.message || err);
    payload = { embeds: [panel({ title: '📡 TÌNH TRẠNG', color: COLORS.danger, description: '🔴 **Không đọc được cơ sở dữ liệu.** Bot vẫn chạy nhưng cấu hình AI tạm thời không truy cập được — quản trị viên hãy kiểm tra PostgreSQL.' })] };
  }
  if (!canEmbed) payload = plainPayload(payload);
  return safeSend(i, 'reply', payload);
}

async function handleChatInput(i) {
  switch (i.commandName) {
    case 'admin': return handleAdmin(i);
    case 'ask': return slashAsk(i);
    case 'status': return slashStatus(i);
    case 'clear': {
      clearHistory(i.channelId, i.user.id);
      return i.reply({ content: '🧹 Đã xóa trí nhớ hội thoại của kênh này.', flags: MessageFlags.Ephemeral });
    }
    default: return undefined;
  }
}

// ───────────────────────── Nút dưới câu trả lời ─────────────────────────
async function handleAnswerButton(i) {
  const [kind, arg] = i.customId.split(':');
  const privileged = interactionIsAdmin(i);
  if (kind === 'ans_del') {
    if (i.user.id !== arg && !privileged) return i.reply({ content: '⛔ Chỉ người đã hỏi hoặc quản trị viên mới xóa được.', flags: MessageFlags.Ephemeral });
    await i.deferUpdate().catch(() => {});
    return i.message.delete().catch(() => {});
  }
  if (kind === 'ans_regen') {
    const data = pending.get(arg);
    if (!data) return i.reply({ content: '⌛ Câu hỏi này đã hết hạn, hãy hỏi lại.', flags: MessageFlags.Ephemeral });
    if (i.user.id !== data.userId && !privileged) return i.reply({ content: '⛔ Chỉ người đã hỏi mới dùng được nút này.', flags: MessageFlags.Ephemeral });
    if (!privileged) {
      const wait = cooldowns.hit(i.user.id, COUNCIL_CD);
      if (wait) { stats.ratelimited++; return i.reply({ content: `⏳ Chờ ${fmtMs(wait)} nhé.`, flags: MessageFlags.Ephemeral }); }
    }
    await i.deferReply();
    const started = Date.now();
    const canEmbed = canEmbedInteraction(i);
    try {
      const settings = await getSettings();
      const result = await answer({ channelId: data.channelId, userId: data.userId, userName: data.userName, text: data.text, referenced: data.referenced, council: true, settings, botName: BOT_NAME, skipHistory: true });
      const token = remember(data);
      await sendInteractionPayloads(i, renderAnswer({ result, elapsedMs: Date.now() - started, canEmbed, requesterId: data.userId, token }));
    } catch (err) {
      await failInteraction(i, err, canEmbed);
    }
    return;
  }
  // customId ans_* không nhận diện được (nút cũ/phiên bản khác) → luôn phản hồi để Discord không báo "interaction failed".
  return i.reply({ content: '⌛ Nút này không còn hiệu lực.', flags: MessageFlags.Ephemeral });
}

client.on('interactionCreate', async i => {
  try {
    if (i.isChatInputCommand()) return await handleChatInput(i);
    const id = String(i.customId || '');
    if (id.startsWith('adm_')) return await handleAdmin(i);
    if (i.isButton() && id.startsWith('ans_')) return await handleAnswerButton(i);
  } catch (err) {
    const id = errId();
    console.error(`❌ interactionCreate [${id}] ${i.commandName || i.customId || ''}:`, err?.stack || err);
    const msg = { content: `❌ Có lỗi xảy ra, thử lại sau nhé. (mã lỗi: \`${id}\` — quản trị viên tra log theo mã này)`, flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

client.on('error', err => console.error('❌ Discord client error:', err?.stack || err));
client.on('warn', msg => console.warn('⚠️ Discord warning:', msg));
client.on('messageCreate', m => { handleMessage(m); });

client.once('clientReady', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'trò chuyện cùng bạn · /ask', type: ActivityType.Playing }], status: 'online' });
  try { await client.application.commands.set(COMMANDS); console.log('✅ Slash commands: /admin /ask /status /clear'); }
  catch (err) { console.error('❌ Đăng ký slash command thất bại:', err); }
  getSettings(true).catch(err => console.error('❌ Không tải được cấu hình:', err));
  syncAllProviders().then(n => console.log(n ? `✅ Đã đồng bộ ${n} model từ API` : 'ℹ️ Không có model mới để đồng bộ (chưa có API hoặc provider đang lỗi).')).catch(err => console.error('❌ Đồng bộ catalog khi khởi động thất bại:', err?.message || err));
});

// ───────────────────────── Health server + vòng đời ─────────────────────────
const health = { db: false, dbFails: 0 };
async function checkDb() {
  try { await pingDb(); health.db = true; health.dbFails = 0; }
  catch (err) { health.dbFails++; if (health.dbFails >= 2) health.db = false; console.warn(`⚠️ DB ping lỗi (${health.dbFails}):`, err?.message || err); }
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const path = String(req.url || '').split('?')[0];
  const ready = client.isReady() && health.db;
  const body = { ok: ready, botReady: client.isReady(), db: health.db, uptime: Math.round(process.uptime()), version: VERSION, messages: stats.messages };
  if (path === '/live') return json(res, 200, { ok: true });                // tiến trình còn sống
  if (path === '/health' || path === '/ready') return json(res, ready ? 200 : 503, body); // sẵn sàng thật: Discord + PostgreSQL
  return json(res, 404, { error: 'Not found' });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal}: đang tắt…`);
  setTimeout(() => process.exit(0), 8000).unref();
  server.close();
  await client.destroy();
  await closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', err => console.error('❌ Unhandled rejection:', err?.stack || err));
process.on('uncaughtException', err => { console.error('❌ Uncaught exception:', err?.stack || err); setTimeout(() => process.exit(1), 500); });

// Mở cổng health TRƯỚC khi init DB để Render không đánh dấu deploy thất bại khi DB khởi động chậm.
server.listen(PORT, '0.0.0.0', () => console.log(`🌐 Health server listening on ${PORT}`));
for (let attempt = 1; ; attempt++) {
  try { await initDb(); break; }
  catch (err) {
    console.error(`❌ initDb lần ${attempt}:`, err?.message || err);
    if (attempt >= 5) process.exit(1);
    await new Promise(r => setTimeout(r, 3000 * attempt));
  }
}
await checkDb();
setInterval(checkDb, 30_000).unref();
try { await client.login(process.env.DISCORD_TOKEN); }
catch (err) { console.error('❌ Discord login failed:', err); process.exit(1); }
