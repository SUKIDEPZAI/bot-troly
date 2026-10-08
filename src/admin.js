// Bảng điều khiển /admin (chỉ dành cho quản trị viên). Mọi customId đều có tiền tố `adm_`.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import {
  addModel, deleteProvider, getSetting, listModels, listProviders, setSetting, toggleModel, upsertProvider, usageSummary
} from './db.js';
import { mask } from './crypto.js';
import { PROVIDERS, chat, clearModelCache, listRemoteModels, suggestedModels, testProvider } from './providers.js';
import { syncProviderModels } from './catalog.js';
import { invalidateRoute } from './engine.js';
import { getSettings, invalidateSettings, readAllowedIds, toggleSetting, writeAllowedIds } from './settings.js';
import { interactionIsAdmin } from './permissions.js';
import { PERSONAS } from './personas.js';
import { limiterState } from './chat.js';
import { COLORS, bar, onOff, panel, plainPayload, providerLabel, providerStatus } from './ui.js';
import { createLimiter, fmtDuration, fmtMs, stats, truncate } from './utils.js';

const EPH = { flags: MessageFlags.Ephemeral };
const ack = async i => { if (!i.deferred && !i.replied) await i.deferUpdate(); };
const btn = (id, label, style = ButtonStyle.Secondary, extra = {}) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(truncate(label, 80)).setStyle(style);
  if (extra.emoji) b.setEmoji(extra.emoji);
  if (extra.disabled) b.setDisabled(true);
  return b;
};
const row = (...c) => new ActionRowBuilder().addComponents(...c);
const home = (id = 'adm_reload', label = 'Bảng chính') => row(btn(id, label, ButtonStyle.Secondary, { emoji: '↩️' }));
const info = p => PROVIDERS[String(p || '').toLowerCase()] || { label: p, description: 'Provider tùy chỉnh.', baseUrl: '' };
const PAGE = 25;
const edit = async (i, embed, components = [], content = '') => {
  try { return await i.editReply({ content, embeds: [embed], components }); }
  catch (err) {
    // Nếu embed bị từ chối (vd. thiếu quyền Embed Links): giữ nguyên nút/select, hiển thị nội dung dạng văn bản.
    console.warn('⚠️ Admin: editReply với embed thất bại → dùng văn bản thường:', err?.message || err);
    const plain = plainPayload({ embeds: [embed] });
    return i.editReply({ content: `${content ? `${content}\n` : ''}${plain.content}`.slice(0, 1990), embeds: [], components });
  }
};

// ───────────── Bảng chính ─────────────
function mainRows() {
  return [
    row(
      btn('adm_ai', 'AI & MODEL', ButtonStyle.Primary, { emoji: '🧠' }),
      btn('adm_api', 'API', ButtonStyle.Primary, { emoji: '🔑' }),
      btn('adm_route', 'ĐỊNH TUYẾN', ButtonStyle.Primary, { emoji: '🧭' }),
      btn('adm_channel', 'KÊNH BOT', ButtonStyle.Danger, { emoji: '🔒' })
    ),
    row(
      btn('adm_health', 'KIỂM TRA', ButtonStyle.Success, { emoji: '🩺' }),
      btn('adm_stats', 'THỐNG KÊ', ButtonStyle.Secondary, { emoji: '📊' }),
      btn('adm_reload', 'LÀM MỚI', ButtonStyle.Secondary, { emoji: '🔄' }),
      btn('adm_close', 'ĐÓNG', ButtonStyle.Secondary, { emoji: '✖️' })
    )
  ];
}

async function dashboard(i) {
  await ack(i);
  const [ps, ms, s] = await Promise.all([listProviders(), listModels(), getSettings(true)]);
  const enabled = ms.filter(m => m.enabled).length;
  const cooling = ps.filter(p => providerStatus(p).icon === '🟠').length;
  const list = ps.length
    ? ps.map(p => { const st = providerStatus(p); return `${st.icon} **${providerLabel(p.name)}** — ${st.text}`; }).join('\n')
    : '_Chưa có API nào. Bấm **🔑 API** để bắt đầu._';
  return edit(i, panel({
    title: '🤖 BẢNG QUẢN TRỊ AI COUNCIL',
    description: list,
    color: ps.length ? COLORS.primary : COLORS.warn,
    fields: [
      { name: '🔑 API', value: `**${ps.length}** đã cấu hình${cooling ? ` · 🟠 ${cooling} tạm nghỉ` : ''}`, inline: true },
      { name: '🧠 Model', value: `${bar(enabled, ms.length, 8)}\n**${enabled}/${ms.length}** đang bật`, inline: true },
      { name: '🎭 Persona', value: PERSONAS[s.persona]?.label || PERSONAS.default.label, inline: true },
      { name: '🧭 Tự định tuyến', value: onOff(s.autoRoute), inline: true },
      { name: '🆓 Ưu tiên miễn phí', value: onOff(s.freeFirst), inline: true },
      { name: '🧠 Hội đồng (@bot/reply)', value: `${onOff(s.council)}${s.council ? ` · ✍️ judge ${s.councilJudge ? 'bật' : 'tắt'}` : ''}`, inline: true },
      { name: '🔒 Khóa kênh', value: s.lockEnabled ? `🔒 Bật · ${s.allowed.size} kênh` : '🔓 Tắt (bot trả lời mọi kênh)', inline: false }
    ]
  }), mainRows());
}

// ───────────── API ─────────────
async function apiPanel(i, note = '') {
  await ack(i);
  const ps = await listProviders();
  const byName = new Map(ps.map(p => [p.name.toLowerCase(), p]));
  const lines = Object.entries(PROVIDERS).map(([id, p]) => {
    const saved = byName.get(id);
    const st = saved ? providerStatus(saved) : { icon: '⚪', text: 'Chưa cấu hình' };
    return `${st.icon} **${p.label}** — ${saved ? st.text : p.description}`;
  }).join('\n');
  const options = Object.entries(PROVIDERS).map(([id, p]) => ({
    label: p.label, value: id,
    description: truncate(byName.has(id) ? `${providerStatus(byName.get(id)).text} · 🔐 ${mask(byName.get(id).api_key)}` : p.description, 100),
    emoji: { name: byName.has(id) ? '🟢' : '⚪' }
  }));
  return edit(i, panel({
    title: '🔑 QUẢN LÝ API',
    description: `Chọn nhà cung cấp để nhập/đổi key, kiểm tra hoặc đồng bộ model. **Chỉ cần API key** — Base URL tự chọn.\n\n${lines}`
  }), [
    row(new StringSelectMenuBuilder().setCustomId('adm_api_pick').setPlaceholder('Chọn nhà cung cấp…').addOptions(options)),
    row(
      btn('adm_test', 'Kiểm tra tất cả', ButtonStyle.Success, { emoji: '🩺' }),
      btn('adm_api_del', 'Xóa API', ButtonStyle.Danger, { emoji: '🗑️', disabled: !ps.length }),
      btn('adm_reload', 'Bảng chính', ButtonStyle.Secondary, { emoji: '↩️' })
    )
  ], note);
}

async function providerDetail(i, p, note = '') {
  await ack(i);
  const cfg = info(p);
  const [ps, ms] = await Promise.all([listProviders(), listModels(p)]);
  const saved = ps.find(x => x.name.toLowerCase() === p);
  const st = saved ? providerStatus(saved) : { icon: '⚪', text: 'Chưa cấu hình' };
  const cd = saved?.cooldown_until && new Date(saved.cooldown_until) > new Date() ? `🟠 còn ${Math.ceil((new Date(saved.cooldown_until) - Date.now()) / 1000)}s` : '—';
  return edit(i, panel({
    title: `🔑 ${cfg.label}`,
    description: `${cfg.description}${note ? `\n\n${note}` : ''}`,
    color: saved ? (st.icon === '🟢' ? COLORS.ok : COLORS.warn) : COLORS.dark,
    fields: [
      { name: 'Trạng thái', value: `${st.icon} ${st.text}`, inline: true },
      { name: 'API key', value: saved ? `🔐 \`${mask(saved.api_key)}\`` : 'Chưa có', inline: true },
      { name: 'Model đã lưu', value: `${ms.filter(m => m.enabled).length}/${ms.length} bật`, inline: true },
      { name: 'Độ trễ TB', value: saved?.avg_latency_ms ? fmtMs(saved.avg_latency_ms) : '—', inline: true },
      { name: 'Lỗi liên tiếp', value: String(saved?.fail_count || 0), inline: true },
      { name: 'Cooldown', value: cd, inline: true },
      ...(saved?.last_error ? [{ name: 'Lỗi gần nhất', value: `\`\`\`${truncate(saved.last_error, 300)}\`\`\`` }] : []),
      { name: 'Base URL', value: `\`${cfg.baseUrl}\`` }
    ]
  }), [
    row(
      btn(`adm_api_provider:${p}`, saved ? 'Đổi API key' : 'Nhập API key', ButtonStyle.Primary, { emoji: '🔑' }),
      btn(`adm_prov_test:${p}`, 'Kiểm tra', ButtonStyle.Success, { emoji: '🩺', disabled: !saved }),
      btn(`adm_prov_sync:${p}`, 'Đồng bộ model', ButtonStyle.Secondary, { emoji: '🔄', disabled: !saved }),
      btn(`adm_models_provider:${p}:0`, 'Chọn model', ButtonStyle.Secondary, { emoji: '🧠', disabled: !saved })
    ),
    home('adm_api', 'Danh sách API')
  ]);
}

async function apiProviderModal(i, p) {
  const m = new ModalBuilder().setCustomId(`adm_api_modal:${p}`).setTitle(truncate(`🔑 API — ${info(p).label}`, 45));
  m.addComponents(row(new TextInputBuilder().setCustomId('api_key').setLabel('API KEY').setPlaceholder('Dán API key tại đây').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)));
  return i.showModal(m);
}

async function saveApi(i, p) {
  if (!i.deferred && !i.replied) await i.deferReply(EPH);
  if (!PROVIDERS[p]) return i.editReply({ content: '❌ Provider không hợp lệ.' });
  const key = i.fields.getTextInputValue('api_key').trim();
  if (key.length < 8 || /\s/.test(key)) return i.editReply({ content: '❌ API key không hợp lệ (quá ngắn hoặc chứa khoảng trắng).' });
  await upsertProvider({ name: p, apiKey: key, baseUrl: PROVIDERS[p].baseUrl });
  clearModelCache(p); invalidateRoute();
  let check;
  try {
    const r = await testProvider(p);
    const synced = r.models?.length ? (await syncProviderModels(p, { force: false })).length : 0;
    check = `🟢 **API hoạt động** · ${r.models?.length || 0} model chat${synced ? ` · đã lưu ${synced} model` : ''}.`;
    invalidateRoute();
  } catch (err) { check = `🔴 **Chưa xác thực được:** ${truncate(err?.message || err, 600)}`; }
  return i.editReply({ content: `${check.startsWith('🟢') ? '✅' : '⚠️'} **${info(p).label}** — key đã được mã hóa (AES-256-GCM) và lưu.\n${check}\n\n_Mở \`/admin\` lại để làm mới bảng._` });
}

async function deletePick(i) {
  await ack(i);
  const ps = await listProviders();
  return edit(i, panel({ title: '🗑️ XÓA API', description: 'Chọn provider cần xóa. Toàn bộ API key và model đã lưu của provider đó sẽ bị xóa.', color: COLORS.danger }), [
    row(new StringSelectMenuBuilder().setCustomId('adm_api_delpick').setPlaceholder('Chọn provider để xóa…')
      .addOptions(ps.slice(0, 25).map(p => ({ label: providerLabel(p.name), value: p.name.toLowerCase(), description: `🔐 ${mask(p.api_key)}` })))),
    home('adm_api', 'Hủy')
  ]);
}

async function deleteConfirm(i, p) {
  await ack(i);
  return edit(i, panel({ title: `⚠️ Xóa ${info(p).label}?`, description: 'Thao tác này **không thể hoàn tác**: API key và các model đã lưu của provider sẽ bị xóa.', color: COLORS.danger }), [
    row(btn(`adm_api_delete:${p}`, 'Xác nhận xóa', ButtonStyle.Danger, { emoji: '🗑️' }), btn('adm_api', 'Hủy', ButtonStyle.Secondary))
  ]);
}

async function deleteDo(i, p) {
  await ack(i);
  await deleteProvider(p);
  clearModelCache(p);
  if ((await getSetting('default_provider')) === p) { await setSetting('default_provider', ''); await setSetting('default_model', ''); }
  invalidateSettings(); invalidateRoute();
  return apiPanel(i, `🗑️ Đã xóa **${info(p).label}** (API key + model).`);
}

// ───────────── Model ─────────────
async function aiPanel(i) {
  await ack(i);
  const [ps, ms, s] = await Promise.all([listProviders(), listModels(), getSettings()]);
  const comps = [];
  if (ps.length) comps.push(row(new StringSelectMenuBuilder().setCustomId('adm_ai_pick').setPlaceholder('Chọn AI để xem/chọn model…')
    .addOptions(ps.slice(0, 25).map(p => ({ label: providerLabel(p.name), value: p.name.toLowerCase(), description: truncate(`${providerStatus(p).text} · ${ms.filter(m => m.provider === p.name.toLowerCase()).length} model`, 100) })))));
  comps.push(row(
    btn('adm_model_manage:0', 'Model đã lưu', ButtonStyle.Primary, { emoji: '🧠', disabled: !ms.length }),
    btn('adm_suggest', 'Gợi ý', ButtonStyle.Secondary, { emoji: '💡' }),
    btn(ps.length ? 'adm_reload' : 'adm_api', ps.length ? 'Bảng chính' : 'Cấu hình API trước', ps.length ? ButtonStyle.Secondary : ButtonStyle.Primary, { emoji: ps.length ? '↩️' : '🔑' })
  ));
  return edit(i, panel({
    title: '🧠 AI & MODEL',
    description: 'Chọn AI → bot lấy **model thật từ API** → chọn model mặc định. Model chỉ dành cho gói consumer/Plus/Pro hoặc không phải chat sẽ tự bị ẩn.',
    fields: [
      { name: 'AI đã cấu hình', value: String(ps.length), inline: true },
      { name: 'Model đã lưu', value: String(ms.length), inline: true },
      { name: 'Mặc định', value: s.defaultProvider && s.defaultModel ? `\`${s.defaultProvider}/${truncate(s.defaultModel, 40)}\`` : '`auto`', inline: true }
    ]
  }), comps);
}

async function modelProviderPanel(i, p, page = 0) {
  await ack(i);
  let remote = [], remoteError = '';
  try { remote = await listRemoteModels(p); } catch (err) { remoteError = err?.message || String(err); }
  const saved = await listModels(p);
  const map = new Map();
  for (const m of remote) map.set(m.id, { ...m, name: m.id });
  for (const m of saved) if (!map.has(m.name)) map.set(m.name, { id: m.name, name: m.name, description: m.description, free: m.free, tier: m.tier, context: m.context_length });
  if (!map.size) for (const m of suggestedModels(p)) map.set(m.name, { id: m.name, name: m.name, description: m.description, free: m.free, tier: m.tier });
  const all = [...map.values()].filter(m => `${p}::${m.id}`.length <= 100); // giới hạn value của select = 100 ký tự
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const cur = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const options = all.slice(cur * PAGE, cur * PAGE + PAGE).map(m => ({
    label: truncate(m.name, 100), value: `${p}::${m.id}`,
    description: truncate(`${m.free ? '🆓' : '💳'} · T${m.tier || 2} · ${String(m.description || 'Model khả dụng').replace(/\s+/g, ' ')}`, 100)
  }));
  const note = remoteError
    ? `⚠️ **Không lấy được catalog trực tiếp:** ${truncate(remoteError, 300)}\nĐang dùng model đã lưu/gợi ý.`
    : `🟢 **Catalog API:** ${remote.length} model chat · 📄 Trang ${cur + 1}/${pages}`;
  const comps = [];
  if (options.length) comps.push(row(new StringSelectMenuBuilder().setCustomId('adm_model_pick').setPlaceholder(`Chọn model của ${info(p).label}`).addOptions(options)));
  comps.push(row(
    btn(`adm_models_provider:${p}:${Math.max(0, cur - 1)}`, 'Trước', ButtonStyle.Secondary, { emoji: '⬅️', disabled: cur === 0 }),
    btn(`adm_models_provider:${p}:${Math.min(pages - 1, cur + 1)}`, 'Sau', ButtonStyle.Secondary, { emoji: '➡️', disabled: cur >= pages - 1 }),
    btn(`adm_models_refresh:${p}`, 'Tải lại', ButtonStyle.Success, { emoji: '🔄' }),
    btn('adm_ai', 'Chọn AI khác', ButtonStyle.Secondary, { emoji: '↩️' })
  ));
  return edit(i, panel({ title: `🧠 MODEL — ${info(p).label}`, description: `${info(p).description}\n\n${note}\n\nChọn model để đặt làm **mặc định** (bot vẫn tự fallback khi lỗi).` }), comps);
}

async function modelPicked(i) {
  await ack(i);
  const [p, ...rest] = String(i.values[0]).split('::');
  const n = rest.join('::');
  const fallback = suggestedModels(p).find(x => x.name === n);
  let meta = null;
  try { meta = (await listRemoteModels(p)).find(x => x.id === n) || null; } catch { /* dùng gợi ý */ }
  if (!meta) {
    // Không xác nhận được qua catalog (API /models lỗi) → thử gọi thật 1 lần rất nhỏ; chỉ lưu nếu model hoạt động.
    try { await chat({ provider: p, model: n, messages: [{ role: 'user', content: 'Trả lời đúng một từ: OK' }], temperature: 0, maxTokens: 16, timeoutMs: 9000 }); }
    catch (err) {
      return edit(i, panel({
        title: '❌ CHƯA ĐẶT ĐƯỢC MODEL', color: COLORS.danger,
        description: `**${info(p).label}** · \`${truncate(n, 60)}\`\n\nKhông xác nhận được model này (catalog không khả dụng và gọi thử thất bại):\n\`\`\`${truncate(err?.message || err, 400)}\`\`\`\nModel có thể không tồn tại hoặc tài khoản chưa có quyền. **Mặc định cũ được giữ nguyên.**`
      }), [row(btn(`adm_models_provider:${p}:0`, 'Chọn model khác', ButtonStyle.Primary, { emoji: '🔄' }), btn(`adm_prov_test:${p}`, 'Kiểm tra API', ButtonStyle.Success, { emoji: '🩺' }), btn('adm_ai', 'Chọn AI', ButtonStyle.Secondary, { emoji: '↩️' }))]);
    }
  }
  const free = meta?.free ?? fallback?.free ?? false;
  const tier = meta?.tier ?? fallback?.tier ?? 2;
  const description = meta?.description || fallback?.description || `Model ${n} của ${info(p).label}.`;
  const saved = await addModel({ provider: p, name: n, free, description, tier, contextLength: meta?.context ?? null, capabilities: meta?.capabilities || '' });
  await setSetting('default_provider', p); await setSetting('default_model', n);
  invalidateSettings(); invalidateRoute();
  return edit(i, panel({
    title: '✅ ĐÃ ĐẶT MODEL MẶC ĐỊNH', color: COLORS.ok,
    description: `**${info(p).label}** · \`${n}\`\n${free ? '🆓 Free/zero-cost theo metadata' : '💳 Theo API account/provider'} · T${tier} · ${saved.enabled ? '🟢 Bật' : '⚪ Tắt'}\n\n${truncate(description, 500)}\n\n_Bot sẽ tự fallback sang model khác nếu model này hết quyền, 429, timeout hoặc lỗi server._`
  }), [row(btn(`adm_models_provider:${p}:0`, 'Chọn model khác', ButtonStyle.Primary, { emoji: '🔄' }), btn('adm_ai', 'Chọn AI', ButtonStyle.Secondary, { emoji: '↩️' }))]);
}

async function modelManagePanel(i, page = 0) {
  await ack(i);
  const ms = await listModels();
  if (!ms.length) return edit(i, panel({ title: '🧠 MODEL ĐÃ LƯU', description: 'Chưa có model nào. Hãy thêm API và bấm **🔄 Đồng bộ model**.' }), [home('adm_ai', 'AI & MODEL')]);
  const pages = Math.ceil(ms.length / PAGE);
  const cur = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const slice = ms.slice(cur * PAGE, cur * PAGE + PAGE);
  const lines = slice.map(m => `${m.enabled ? '🟢' : '⚪'} \`${truncate(`${m.provider}/${m.name}`, 48)}\` · T${m.tier} ${m.free ? '🆓' : '💳'}`).join('\n');
  return edit(i, panel({ title: `🧠 MODEL ĐÃ LƯU (${ms.length})`, description: `Chọn một model để **bật/tắt**.\n\n${lines}\n\n📄 Trang ${cur + 1}/${pages}` }), [
    row(new StringSelectMenuBuilder().setCustomId(`adm_model_select:${cur}`).setPlaceholder('Chọn model để bật/tắt')
      .addOptions(slice.map(m => ({ label: truncate(`${m.provider}/${m.name}`, 100), value: String(m.id), description: `${m.enabled ? '🟢 Đang bật' : '⚪ Đang tắt'} · T${m.tier} · ${m.free ? '🆓' : '💳'}` })))),
    row(
      btn(`adm_model_manage:${Math.max(0, cur - 1)}`, 'Trước', ButtonStyle.Secondary, { emoji: '⬅️', disabled: cur === 0 }),
      btn(`adm_model_manage:${Math.min(pages - 1, cur + 1)}`, 'Sau', ButtonStyle.Secondary, { emoji: '➡️', disabled: cur >= pages - 1 }),
      btn('adm_ai', 'AI & MODEL', ButtonStyle.Secondary, { emoji: '↩️' })
    )
  ]);
}

async function suggestionPanel(i) {
  await ack(i);
  const text = suggestedModels().map(m => `**${m.provider}/${truncate(m.name, 40)}** ${m.free ? '🆓' : '💳'} · T${m.tier}\n${m.description}`).join('\n\n');
  return edit(i, panel({ title: '💡 MODEL ĐỀ XUẤT', description: `${truncate(text, 3800)}\n\n_Chỉ là gợi ý khởi đầu; danh sách thật lấy từ API của bạn._` }), [home('adm_ai', 'AI & MODEL')]);
}

// ───────────── Kênh ─────────────
async function channelPanel(i, note = '') {
  await ack(i);
  const [s, ids] = await Promise.all([getSettings(true), readAllowedIds()]);
  const names = ids.map(id => (i.guild?.channels?.cache?.get(id) ? `• <#${id}>` : `• \`${id}\``));
  const comps = [
    row(new ChannelSelectMenuBuilder().setCustomId('adm_channel_select').setPlaceholder('➕ Thêm kênh được phép…')
      .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement]).setMinValues(1).setMaxValues(25))
  ];
  if (ids.length) comps.push(row(new StringSelectMenuBuilder().setCustomId('adm_channel_remove').setPlaceholder('➖ Gỡ kênh khỏi danh sách…')
    .addOptions(ids.slice(0, 25).map(id => ({ label: truncate(`#${i.guild?.channels?.cache?.get(id)?.name || id}`, 100), value: id })))));
  comps.push(row(
    btn(s.lockEnabled ? 'adm_channel_disable' : 'adm_channel_enable', s.lockEnabled ? 'Tắt khóa' : 'Bật khóa', s.lockEnabled ? ButtonStyle.Success : ButtonStyle.Danger, { emoji: s.lockEnabled ? '🔓' : '🔒' }),
    btn('adm_channel_clear', 'Xóa tất cả', ButtonStyle.Secondary, { emoji: '🗑️', disabled: !ids.length }),
    btn('adm_reload', 'Bảng chính', ButtonStyle.Secondary, { emoji: '↩️' })
  ));
  return edit(i, panel({
    title: '🔒 KHÓA KÊNH BOT', color: s.lockEnabled ? COLORS.danger : COLORS.ok,
    description: `${s.lockEnabled ? '🔒 **ĐANG BẬT** — bot chỉ phản hồi trong các kênh (và thread của kênh) bên dưới.' : '🔓 **ĐANG TẮT** — bot phản hồi ở **mọi kênh** nó đọc được.'}\n\n**${ids.length} kênh đang chọn**\n${names.join('\n') || '_Chưa chọn._'}${note ? `\n\n${note}` : ''}`
  }), comps);
}

async function channelSelected(i) {
  await ack(i);
  await writeAllowedIds([...(await readAllowedIds()), ...(i.values || [])]);
  return channelPanel(i);
}
async function channelRemoved(i) {
  await ack(i);
  const drop = new Set(i.values.map(String));
  await writeAllowedIds((await readAllowedIds()).filter(id => !drop.has(id)));
  return channelPanel(i);
}
async function channelLock(i, on) { await ack(i); await setSetting('channel_lock_enabled', on ? 'true' : 'false'); invalidateSettings(); return channelPanel(i); }
async function channelClear(i) {
  await ack(i);
  await writeAllowedIds([]);
  await setSetting('channel_lock_enabled', 'false'); // tránh trạng thái "khóa mà không có kênh nào" khiến bot câm hoàn toàn
  invalidateSettings();
  return channelPanel(i, 'ℹ️ Đã xóa danh sách và **tắt khóa** để bot không bị câm ở mọi kênh.');
}

// ───────────── Định tuyến ─────────────
async function routePanel(i) {
  await ack(i);
  const s = await getSettings(true);
  const tgl = (id, on, label, emoji) => btn(id, `${on ? 'Tắt' : 'Bật'} ${label}`, on ? ButtonStyle.Secondary : ButtonStyle.Success, { emoji });
  return edit(i, panel({
    title: '🧭 ĐỊNH TUYẾN',
    description: 'Nhắn bình thường → bot tự chấm độ khó và chọn tuyến/model. **@bot** hoặc **reply bot** → Hội đồng nhiều AI trả lời song song rồi tổng hợp.',
    fields: [
      { name: 'AI mặc định', value: `\`${s.defaultProvider || 'auto'}\``, inline: true },
      { name: 'Model mặc định', value: `\`${truncate(s.defaultModel || 'auto', 40)}\``, inline: true },
      { name: 'Persona', value: PERSONAS[s.persona]?.label || PERSONAS.default.label, inline: true },
      { name: '🧭 Auto Route', value: onOff(s.autoRoute), inline: true },
      { name: '🆓 Free First', value: onOff(s.freeFirst), inline: true },
      { name: '🧠 Hội đồng', value: onOff(s.council), inline: true },
      { name: '✍️ Judge tổng hợp', value: onOff(s.councilJudge), inline: true }
    ]
  }), [
    row(new StringSelectMenuBuilder().setCustomId('adm_persona').setPlaceholder('🎭 Chọn persona (phong cách trả lời)')
      .addOptions(Object.entries(PERSONAS).map(([k, v]) => ({ label: v.label, value: k, description: truncate(v.prompt, 100), default: k === s.persona })))),
    row(tgl('adm_route_auto', s.autoRoute, 'Route', '🧭'), tgl('adm_route_free', s.freeFirst, 'Free', '🆓'), tgl('adm_route_council', s.council, 'Council', '🧠'), tgl('adm_route_judge', s.councilJudge, 'Judge', '✍️')),
    home()
  ]);
}
async function routeToggle(i, key) { await ack(i); await toggleSetting(key); return routePanel(i); }

// ───────────── Kiểm tra / thống kê ─────────────
const testLimiter = createLimiter(3, 100); // tránh bắn song song cả chục API khi bấm "Kiểm tra tất cả" (dễ dính rate-limit)
async function runTests(ps) {
  return Promise.all(ps.map(p => testLimiter.run(async () => {
    const t0 = Date.now();
    try { const r = await testProvider(p.name); return { p, ok: true, text: r.message, ms: Date.now() - t0 }; }
    catch (err) { return { p, ok: false, text: truncate(err?.message || err, 200), ms: Date.now() - t0 }; }
  })));
}
const fmtTest = r => `${r.ok ? '🟢' : '🔴'} **${providerLabel(r.p.name)}** · ${fmtMs(r.ms)}\n└ ${r.text}`;

async function healthPanel(i) {
  await ack(i);
  const ps = await listProviders();
  if (!ps.length) return edit(i, panel({ title: '🩺 KIỂM TRA API', description: 'Chưa có API.' }), [home()]);
  const res = await runTests(ps);
  invalidateRoute();
  const bad = res.filter(r => !r.ok).length;
  return edit(i, panel({ title: '🩺 KIỂM TRA API', color: bad ? COLORS.warn : COLORS.ok, description: res.map(fmtTest).join('\n\n'), fields: [{ name: 'Kết quả', value: `🟢 ${res.length - bad} OK · 🔴 ${bad} lỗi` }] }), [home()]);
}

async function testAll(i) {
  if (!i.deferred && !i.replied) await i.deferReply(EPH);
  const ps = await listProviders();
  if (!ps.length) return i.editReply('⚠️ Chưa cấu hình API nào.');
  const res = await runTests(ps);
  invalidateRoute();
  return i.editReply(truncate(res.map(fmtTest).join('\n\n'), 1900));
}

async function statsPanel(i) {
  await ack(i);
  const [ps, ms, usage] = await Promise.all([listProviders(), listModels(), usageSummary(7).catch(() => [])]);
  const lim = limiterState();
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const table = usage.length
    ? usage.map(u => `\`${truncate(providerLabel(u.provider), 16).padEnd(16)}\` ✅${u.ok} ❌${u.fail} ${u.avg_ms ? `· ~${fmtMs(u.avg_ms)}` : ''}`).join('\n')
    : '_Chưa có dữ liệu._';
  return edit(i, panel({
    title: '📊 THỐNG KÊ',
    fields: [
      { name: '⏱ Uptime', value: fmtDuration((Date.now() - stats.startedAt) / 1000), inline: true },
      { name: '💾 RAM', value: `${mem} MB`, inline: true },
      { name: '⚙️ Hàng đợi AI', value: `${lim.active} chạy · ${lim.waiting} chờ`, inline: true },
      { name: '💬 Tin đã xử lý (từ lúc khởi động)', value: `${stats.messages} · 🧠 ${stats.councils} hội đồng · ⛔ ${stats.ratelimited} bị giới hạn · ❌ ${stats.errors} lỗi` },
      { name: '🔑 API / 🧠 Model', value: `${ps.length} API · ${ms.filter(m => m.enabled).length}/${ms.length} model bật · 🟠 ${ps.filter(p => providerStatus(p).icon === '🟠').length} tạm nghỉ` },
      { name: '📈 Lượt gọi 7 ngày qua', value: table },
      { name: '🔐 Bảo mật', value: 'API key mã hóa AES-256-GCM trong PostgreSQL' }
    ]
  }), [home()]);
}

// ───────────── Điều phối ─────────────
export async function handleAdmin(i) {
  try {
    if (!interactionIsAdmin(i)) {
      const msg = { content: '⛔ Bạn không có quyền dùng bảng quản trị.', ...EPH };
      return i.deferred || i.replied ? i.followUp(msg) : i.reply(msg);
    }
    if (i.isChatInputCommand()) { await i.deferReply(EPH); return dashboard(i); }
    const id = String(i.customId || '');
    if (i.isModalSubmit()) { if (id.startsWith('adm_api_modal:')) return saveApi(i, id.split(':')[1]); return; }
    if (id === 'adm_close') return i.update({ content: 'Đã đóng bảng quản trị.', embeds: [], components: [] });
    const [head, a, b] = id.split(':');
    switch (head) {
      case 'adm_reload': return dashboard(i);
      case 'adm_ai': return aiPanel(i);
      case 'adm_api': return apiPanel(i);
      case 'adm_channel': return channelPanel(i);
      case 'adm_route': return routePanel(i);
      case 'adm_health': return healthPanel(i);
      case 'adm_stats': return statsPanel(i);
      case 'adm_test': return testAll(i);
      case 'adm_suggest': return suggestionPanel(i);
      case 'adm_route_auto': return routeToggle(i, 'auto_route_enabled');
      case 'adm_route_free': return routeToggle(i, 'free_first');
      case 'adm_route_council': return routeToggle(i, 'council_enabled');
      case 'adm_route_judge': return routeToggle(i, 'council_judge');
      case 'adm_persona': { await ack(i); const v = i.values[0]; if (PERSONAS[v]) { await setSetting('persona', v); invalidateSettings(); } return routePanel(i); }
      case 'adm_api_pick': return providerDetail(i, i.values[0]);
      case 'adm_api_provider': return PROVIDERS[a] ? apiProviderModal(i, a) : undefined;
      case 'adm_prov_test': {
        await ack(i);
        const [r] = await runTests([{ name: a }]); invalidateRoute();
        return providerDetail(i, a, fmtTest({ ...r, p: { name: a } }));
      }
      case 'adm_prov_sync': {
        await ack(i);
        const n = (await syncProviderModels(a, { force: true })).length; invalidateRoute();
        return providerDetail(i, a, n ? `✅ Đã đồng bộ **${n}** model.` : '⚠️ Không đồng bộ được model (xem lỗi gần nhất).');
      }
      case 'adm_api_del': return deletePick(i);
      case 'adm_api_delpick': return deleteConfirm(i, i.values[0]);
      case 'adm_api_delete': return deleteDo(i, a);
      case 'adm_ai_pick': return modelProviderPanel(i, i.values[0], 0);
      case 'adm_models_provider': return modelProviderPanel(i, a, Number(b || 0));
      case 'adm_models_refresh': { await ack(i); clearModelCache(a); return modelProviderPanel(i, a, 0); }
      case 'adm_model_pick': return modelPicked(i);
      case 'adm_model_manage': return modelManagePanel(i, Number(a || 0));
      case 'adm_model_select': { await ack(i); await toggleModel(Number(i.values[0])); invalidateRoute(); return modelManagePanel(i, Number(a || 0)); }
      case 'adm_channel_select': return channelSelected(i);
      case 'adm_channel_remove': return channelRemoved(i);
      case 'adm_channel_enable': return channelLock(i, true);
      case 'adm_channel_disable': return channelLock(i, false);
      case 'adm_channel_clear': return channelClear(i);
      default: return undefined;
    }
  } catch (err) {
    console.error('❌ Admin interaction:', err?.stack || err);
    const msg = { content: `❌ ${truncate(err?.message || err, 500)}`, ...EPH };
    if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
}
