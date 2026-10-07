import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import {
  addModel,
  deleteProvider,
  getSetting,
  listModels,
  listProviders,
  setSetting,
  toggleModel,
  upsertProvider
} from './db.js';
import { mask } from './crypto.js';
import { suggestedModels, testProvider } from './providers.js';

let interactionHandlerRegistered = false;

function csv(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function adminAllowed(i) {
  if (i.memberPermissions?.has('Administrator')) return true;
  const users = csv(process.env.ADMIN_USER_IDS);
  const roles = csv(process.env.ADMIN_ROLE_IDS);
  if (users.includes(i.user.id)) return true;
  const memberRoles = i.member?.roles?.cache;
  return Boolean(memberRoles && roles.some(role => memberRoles.has(role)));
}

function baseEmbed(title, description = '') {
  return new EmbedBuilder()
    .setTitle(`🤖 ${title}`)
    .setDescription(description || '\u200b');
}

function mainRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_ai').setLabel('AI / MODEL').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('adm_api').setLabel('API').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('adm_route').setLabel('ROUTING').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_health').setLabel('HEALTH').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm_stats').setLabel('STATS').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('adm_reload').setLabel('RELOAD').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('adm_close').setLabel('CLOSE').setStyle(ButtonStyle.Danger)
    )
  ];
}

async function dashboard(i, edit = false) {
  const providers = await listProviders();
  const models = await listModels();
  const content = `Quản lý AI, API và model.\n\n**API:** ${providers.length}\n**Model:** ${models.length}\n**Free-first:** ${await getSetting('free_first') ?? 'true'}`;
  const payload = { embeds: [baseEmbed('AI Council — Admin', content)], components: mainRows() };
  if (edit) return i.update(payload);
  return i.reply({ ...payload, ephemeral: true });
}

async function dashboardEdit(i) { return dashboard(i, true); }

async function aiPanel(i) {
  const models = await listModels();
  const lines = models.length
    ? models.slice(0, 20).map(m => `${m.enabled ? '🟢' : '⚪'} **${m.provider}/${m.name}**${m.free ? ' · FREE' : ''}`).join('\n')
    : 'Chưa có model.';
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_add_model').setLabel('➕ Thêm model').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm_suggest').setLabel('💡 Gợi ý model').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Quay lại').setStyle(ButtonStyle.Secondary)
    )
  ];
  if (models.length) {
    rows.unshift(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('adm_model_select')
        .setPlaceholder('Chọn model để bật/tắt')
        .addOptions(models.slice(0, 25).map(m => ({
          label: `${m.provider}/${m.name}`.slice(0, 100),
          description: `${m.enabled ? 'Đang bật' : 'Đang tắt'}${m.free ? ' · FREE' : ''}`.slice(0, 100),
          value: String(m.id)
        })))
    ));
  }
  return i.update({ embeds: [baseEmbed('AI / MODEL', lines)], components: rows });
}

async function apiPanel(i) {
  const providers = await listProviders();
  const lines = providers.length
    ? providers.map(p => `🟢 **${p.name}** · ${p.base_url}\n🔑 ${p.api_key ? mask(p.api_key) : 'chưa có API key'}`).join('\n\n')
    : 'Chưa có API provider.';
  const rows = [];
  if (providers.length) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('adm_api_select')
        .setPlaceholder('Chọn API để xóa')
        .addOptions(providers.slice(0, 25).map(p => ({
          label: p.name.slice(0, 100),
          description: 'Xóa provider và API key đã lưu'.slice(0, 100),
          value: p.name
        })))
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_add_api').setLabel('➕ Thêm / cập nhật API').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('adm_test').setLabel('🩺 Test API').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Quay lại').setStyle(ButtonStyle.Secondary)
  ));
  return i.update({ embeds: [baseEmbed('API', lines)], components: rows });
}

async function routePanel(i) {
  const provider = await getSetting('default_provider') || process.env.DEFAULT_PROVIDER || 'gemini';
  const model = await getSetting('default_model') || process.env.DEFAULT_MODEL || 'chưa đặt';
  const freeFirst = await getSetting('free_first') ?? 'true';
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Quay lại').setStyle(ButtonStyle.Secondary)
    )
  ];
  return i.update({
    embeds: [baseEmbed('ROUTING', `**Provider mặc định:** ${provider}\n**Model mặc định:** ${model}\n**Free-first:** ${freeFirst}\n\nCấu hình hiện tại được lưu trong PostgreSQL.`)],
    components: rows
  });
}

async function healthPanel(i) {
  const providers = await listProviders();
  const results = [];
  for (const p of providers.slice(0, 10)) {
    try {
      const result = await testProvider(p.name);
      results.push(`🟢 **${p.name}** — ${result?.message || 'OK'}`);
    } catch (e) {
      results.push(`🔴 **${p.name}** — ${e.message}`);
    }
  }
  return i.update({
    embeds: [baseEmbed('HEALTH', results.length ? results.join('\n') : 'Chưa có provider để kiểm tra.')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Quay lại').setStyle(ButtonStyle.Secondary))]
  });
}

async function statsPanel(i) {
  const providers = await listProviders();
  const models = await listModels();
  const enabled = models.filter(m => m.enabled).length;
  return i.update({
    embeds: [baseEmbed('STATS', `**Providers:** ${providers.length}\n**Models:** ${models.length}\n**Models đang bật:** ${enabled}\n**Database:** PostgreSQL`)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Quay lại').setStyle(ButtonStyle.Secondary))]
  });
}

async function addApiModal(i) {
  const modal = new ModalBuilder().setCustomId('adm_api_modal').setTitle('Thêm / cập nhật API');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('provider').setLabel('Provider').setPlaceholder('gemini / groq / openrouter...').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('api_key').setLabel('API Key').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('base_url').setLabel('Base URL (tùy chọn)').setStyle(TextInputStyle.Short).setRequired(false))
  );
  return i.showModal(modal);
}

async function addModelModal(i) {
  const modal = new ModalBuilder().setCustomId('adm_model_modal').setTitle('Thêm model');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('provider').setLabel('Provider').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Model name').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('free').setLabel('Free? true/false').setStyle(TextInputStyle.Short).setRequired(false))
  );
  return i.showModal(modal);
}

async function saveApi(i) {
  const provider = i.fields.getTextInputValue('provider').trim().toLowerCase();
  const apiKey = i.fields.getTextInputValue('api_key').trim();
  const baseUrl = i.fields.getTextInputValue('base_url').trim() || undefined;
  await upsertProvider({ name: provider, apiKey, baseUrl });
  return i.reply({ content: `✅ Đã lưu API **${provider}** vào PostgreSQL. API key được mã hóa và không hiển thị đầy đủ.`, ephemeral: true });
}

async function saveModel(i) {
  const provider = i.fields.getTextInputValue('provider').trim().toLowerCase();
  const name = i.fields.getTextInputValue('name').trim();
  const free = i.fields.getTextInputValue('free').trim().toLowerCase() !== 'false';
  await addModel({ provider, name, free });
  return i.reply({ content: `✅ Đã lưu model **${provider}/${name}**.`, ephemeral: true });
}

async function apiSelected(i) {
  const provider = i.values[0];
  await deleteProvider(provider);
  return i.update({ content: `🗑️ Đã xóa provider **${provider}**.`, embeds: [], components: [] });
}

async function modelSelected(i) {
  const id = Number(i.values[0]);
  const model = await toggleModel(id);
  return i.update({ content: `✅ Model **${model?.name || id}** đã ${model?.enabled ? 'bật' : 'tắt'}.`, embeds: [], components: [] });
}

async function suggestionPanel(i) {
  const suggestions = suggestedModels();
  const text = suggestions.length
    ? suggestions.map(m => `• **${m.provider}/${m.name}**${m.free ? ' — FREE' : ''}\n  ${m.description || ''}`).join('\n')
    : 'Chưa có gợi ý.';
  return i.update({ embeds: [baseEmbed('GỢI Ý MODEL', text)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ AI / MODEL').setStyle(ButtonStyle.Secondary))] });
}

async function providerSelected(i) {
  return i.reply({ content: `Provider: ${i.values[0]}`, ephemeral: true });
}

async function testSelected(i) {
  const providers = await listProviders();
  if (!providers.length) return i.reply({ content: '⚠️ Chưa có API để test.', ephemeral: true });
  const results = [];
  for (const p of providers.slice(0, 5)) {
    try {
      const r = await testProvider(p.name);
      results.push(`🟢 ${p.name}: ${r?.message || 'OK'}`);
    } catch (e) {
      results.push(`🔴 ${p.name}: ${e.message}`);
    }
  }
  return i.reply({ content: results.join('\n'), ephemeral: true });
}

export async function registerAdmin(client) {
  if (!client.isReady() || !client.application) {
    throw new Error('Discord client chưa ready. registerAdmin phải được gọi sau sự kiện ready.');
  }

  // set() tránh việc command cũ bị trùng và bảo đảm chỉ còn /admin.
  await client.application.commands.set([
    { name: 'admin', description: 'Mở bảng điều khiển AI Council' }
  ]);

  if (interactionHandlerRegistered) return;
  interactionHandlerRegistered = true;

  client.on('interactionCreate', async i => {
    try {
      if (i.isChatInputCommand() && i.commandName === 'admin') {
        if (!adminAllowed(i)) return i.reply({ content: '⛔ Bạn không có quyền dùng /admin.', ephemeral: true });
        return dashboard(i);
      }

      if (!i.isButton() && !i.isStringSelectMenu() && !i.isModalSubmit()) return;
      if (!adminAllowed(i)) return i.reply({ content: '⛔ Không có quyền.', ephemeral: true });

      if (i.isModalSubmit()) {
        if (i.customId === 'adm_api_modal') return saveApi(i);
        if (i.customId === 'adm_model_modal') return saveModel(i);
        return;
      }

      if (i.customId === 'adm_close') return i.update({ content: 'Đã đóng bảng quản trị.', embeds: [], components: [] });
      if (i.customId === 'adm_reload') return dashboardEdit(i);
      if (i.customId === 'adm_ai') return aiPanel(i);
      if (i.customId === 'adm_api') return apiPanel(i);
      if (i.customId === 'adm_route') return routePanel(i);
      if (i.customId === 'adm_health') return healthPanel(i);
      if (i.customId === 'adm_stats') return statsPanel(i);
      if (i.customId === 'adm_add_api') return addApiModal(i);
      if (i.customId === 'adm_add_model') return addModelModal(i);
      if (i.customId === 'adm_api_select' && i.isStringSelectMenu()) return apiSelected(i);
      if (i.customId === 'adm_model_select' && i.isStringSelectMenu()) return modelSelected(i);
      if (i.customId === 'adm_suggest') return suggestionPanel(i);
      if (i.customId === 'adm_provider_select' && i.isStringSelectMenu()) return providerSelected(i);
      if (i.customId === 'adm_test') return testSelected(i);
    } catch (e) {
      const message = `❌ ${e?.message || e}`;
      if (i.deferred || i.replied) await i.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await i.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  });
}
