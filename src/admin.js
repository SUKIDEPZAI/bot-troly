import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ChannelType
} from 'discord.js';
import { addModel, deleteProvider, getSetting, listModels, listProviders, setSetting, toggleModel, upsertProvider } from './db.js';
import { mask } from './crypto.js';
import { suggestedModels, testProvider } from './providers.js';

let interactionHandlerRegistered = false;
const PROVIDER_INFO = {
  gemini: { name: 'Google Gemini', desc: 'AI đa năng của Google, phù hợp chat, code, phân tích và suy luận.', url: 'https://generativelanguage.googleapis.com' },
  groq: { name: 'Groq', desc: 'Hạ tầng suy luận tốc độ cao, phù hợp bot cần phản hồi nhanh.', url: 'https://api.groq.com/openai/v1' },
  openrouter: { name: 'OpenRouter', desc: 'Một cổng để truy cập nhiều model AI khác nhau bằng một API.', url: 'https://openrouter.ai/api/v1' },
  deepseek: { name: 'DeepSeek', desc: 'Mạnh về lập trình, chat và suy luận; API tương thích kiểu OpenAI.', url: 'https://api.deepseek.com/v1' },
  openai: { name: 'OpenAI', desc: 'Hệ sinh thái AI tổng quát; model và chi phí phụ thuộc tài khoản/API.', url: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic Claude', desc: 'Mạnh về viết, phân tích, lập luận và nội dung dài.', url: 'https://api.anthropic.com/v1' }
};
const csv = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const adminAllowed = i => i.memberPermissions?.has('Administrator') || csv(process.env.ADMIN_USER_IDS).includes(i.user.id) || Boolean(i.member?.roles?.cache && csv(process.env.ADMIN_ROLE_IDS).some(r => i.member.roles.cache.has(r)));
const info = p => PROVIDER_INFO[String(p || '').toLowerCase()] || { name: p, desc: 'Provider tùy chỉnh.', url: '' };
const embed = (title, desc='') => new EmbedBuilder().setTitle(`🤖 ${title}`).setDescription(desc || '\u200b');
const modelKey = (p,n) => `model_description:${p}:${n}`;

function mainRows(){return [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_ai').setLabel('🧠 AI & MODEL').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_api').setLabel('🔑 API').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_channel').setLabel('🔒 KÊNH BOT').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('adm_route').setLabel('🧭 ĐỊNH TUYẾN').setStyle(ButtonStyle.Secondary)
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_health').setLabel('🩺 KIỂM TRA').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('adm_stats').setLabel('📊 THỐNG KÊ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm_reload').setLabel('🔄 LÀM MỚI').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm_close').setLabel('✖ ĐÓNG').setStyle(ButtonStyle.Danger)
  )
];}
function providerButtons(prefix='adm_api_provider:'){
  const names=Object.keys(PROVIDER_INFO), rows=[];
  for(let i=0;i<names.length;i+=4) rows.push(new ActionRowBuilder().addComponents(...names.slice(i,i+4).map(p=>new ButtonBuilder().setCustomId(`${prefix}${p}`).setLabel(PROVIDER_INFO[p].name.slice(0,80)).setStyle(ButtonStyle.Primary))));
  return rows;
}
async function dashboard(i,edit=false){
  const [ps,ms,ff]=await Promise.all([listProviders(),listModels(),getSetting('free_first')]);
  const text=`Bảng quản trị tập trung cho AI, API, model và quyền hoạt động của bot.\n\n🔑 **API:** ${ps.length}\n🧠 **Model:** ${ms.length} · 🟢 ${ms.filter(m=>m.enabled).length} đang bật\n🆓 **Ưu tiên miễn phí:** ${String(ff??'true')==='true'?'Bật':'Tắt'}\n🔒 **Khóa kênh:** ${String(await getSetting('channel_lock_enabled')??'false')==='true'?'Bật':'Tắt'}\n\nAPI key được mã hóa trong PostgreSQL và không hiển thị đầy đủ.`;
  const payload={embeds:[embed('BẢNG QUẢN TRỊ AI COUNCIL',text)],components:mainRows()};
  return edit?i.update(payload):i.reply({...payload,ephemeral:true});
}
const dashboardEdit=i=>dashboard(i,true);

async function apiPanel(i){
  const ps=await listProviders();
  const lines=ps.length?ps.map(p=>`🟢 **${info(p.name).name}** · API key: \`${p.api_key?mask(p.api_key):'Chưa có'}\``).join('\n'):'Chưa cấu hình API nào.';
  return i.update({embeds:[embed('🔑 QUẢN LÝ API',`Thiết kế mới: **không cần gõ tên AI/provider**. Chỉ nhấn AI → nhập API key. Base URL được tự động lấy theo provider.\n\n${lines}`)],components:[...providerButtons(),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_test').setLabel('🩺 Kiểm tra tất cả API').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]});
}
async function apiProviderModal(i,p){
  const x=info(p),m=new ModalBuilder().setCustomId(`adm_api_modal:${p}`).setTitle(`🔑 API — ${x.name}`);
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('api_key').setLabel('API Key').setPlaceholder('Dán API key đầy đủ').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('base_url').setLabel('Base URL — tùy chọn').setPlaceholder(x.url||'Để trống để dùng mặc định').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(300)));
  return i.showModal(m);
}
async function saveApi(i,p){
  const key=i.fields.getTextInputValue('api_key').trim(), base=i.fields.getTextInputValue('base_url').trim()||info(p).url;
  if(key.length<8)return i.reply({content:'❌ API key quá ngắn. Hãy kiểm tra lại.',ephemeral:true});
  if(base&&!/^https?:\/\//i.test(base))return i.reply({content:'❌ Base URL phải bắt đầu bằng http:// hoặc https://.',ephemeral:true});
  await upsertProvider({name:p,apiKey:key,baseUrl:base});
  return i.reply({content:`✅ **Đã lưu API**\n\n🤖 **AI:** ${info(p).name}\n🔗 **Base URL:** \`${base}\`\n🔐 **API key:** \`${mask(key)}\`\n\nAPI key đã được mã hóa trước khi lưu PostgreSQL.`,ephemeral:true});
}

async function aiPanel(i){
  const ps=await listProviders(),ms=await listModels();
  const rows=[];
  if(ps.length) rows.push(new ActionRowBuilder().addComponents(...ps.slice(0,4).map(p=>new ButtonBuilder().setCustomId(`adm_models_provider:${p.name}`).setLabel(info(p.name).name.slice(0,80)).setStyle(ButtonStyle.Primary))));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_suggest').setLabel('💡 Model đề xuất').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)));
  return i.update({embeds:[embed('🧠 AI & MODEL',`Chọn AI trước, sau đó chọn model. **Không cần nhập Provider hoặc Model ID.**\n\n🔑 AI đã cấu hình: **${ps.length}**\n🧠 Model đã lưu: **${ms.length}** · 🟢 ${ms.filter(m=>m.enabled).length} đang bật\n\n**Bước 1:** Nhấn AI.\n**Bước 2:** Chọn model.\n**Bước 3:** Bot tự lưu model vào PostgreSQL.`)],components:rows});
}
async function modelProviderPanel(i,p){
  const existing=await listModels(), suggestions=suggestedModels().filter(m=>String(m.provider).toLowerCase()===p), merged=[],seen=new Set();
  for(const m of [...suggestions,...existing.filter(m=>String(m.provider).toLowerCase()===p)]){if(seen.has(m.name))continue;seen.add(m.name);merged.push(m);}
  const opts=merged.slice(0,25).map(m=>({label:String(m.name).slice(0,100),description:`${m.free?'🆓 Miễn phí':'💳 Có thể tính phí'} · ${(m.description||'Model AI').slice(0,75)}`,value:`${p}::${m.name}`}));
  const rows=[];if(opts.length)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_pick').setPlaceholder(`Chọn model của ${info(p).name}`).addOptions(opts)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI khác').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('🏠 Bảng chính').setStyle(ButtonStyle.Secondary)));
  return i.update({embeds:[embed('🧠 CHỌN MODEL',`### ${info(p).name}\n${info(p).desc}\n\nChỉ cần **chọn model** bên dưới. Không phải gõ Model ID.`)],components:rows});
}
async function modelPicked(i){
  const [p,n]=String(i.values[0]).split('::'),s=suggestedModels().find(m=>String(m.provider).toLowerCase()===p&&m.name===n),free=s?.free??true;
  await addModel({provider:p,name:n,free});await setSetting(modelKey(p,n),s?.description||`Model ${n} của ${p}.`);
  return i.update({embeds:[embed('✅ ĐÃ THÊM MODEL',`🤖 **AI:** ${info(p).name}\n🧠 **Model:** \`${n}\`\n${free?'🆓 Miễn phí':'💳 Có thể tính phí'}\n\n**Mô tả:** ${s?.description||'Đã lưu model.'}`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm_models_provider:${p}`).setLabel('🔄 Chọn model khác').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI').setStyle(ButtonStyle.Secondary))]});
}

async function channelPanel(i){
  const enabled=String(await getSetting('channel_lock_enabled')??'false')==='true';let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}
  const names=ids.map(id=>i.guild?.channels?.cache?.get(id)?`• <#${id}>`:`• \`${id}\` (không tìm thấy)`);
  const body=`${enabled?'🔒 **ĐANG KHÓA:** bot chỉ được phép hoạt động trong kênh đã chọn.':'🔓 **ĐANG MỞ:** bot chưa giới hạn kênh.'}\n\n**Kênh được phép:**\n${names.length?names.join('\n'):'Chưa chọn kênh nào.'}\n\nChọn kênh bằng menu bên dưới. Khi bật khóa, luồng AI phải kiểm tra danh sách này trước khi phản hồi.`;
  return i.update({embeds:[embed('🔒 KHÓA KÊNH BOT',body)],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_channel_select').setPlaceholder('Chọn kênh bot được phép hoạt động').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(10)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(enabled?'adm_channel_disable':'adm_channel_enable').setLabel(enabled?'🔓 Tắt khóa kênh':'🔒 Bật khóa kênh').setStyle(enabled?ButtonStyle.Success:ButtonStyle.Danger),new ButtonBuilder().setCustomId('adm_channel_clear').setLabel('🗑️ Xóa danh sách').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]});
}
async function channelSelected(i){await setSetting('allowed_channel_ids',JSON.stringify([...new Set(i.values||[])]));return channelPanel(i)}
async function channelLock(i,on){await setSetting('channel_lock_enabled',on?'true':'false');return channelPanel(i)}
async function channelClear(i){await setSetting('allowed_channel_ids','[]');await setSetting('channel_lock_enabled','true');return channelPanel(i)}
export async function isChannelAllowed(channelId){const on=String(await getSetting('channel_lock_enabled')??'false')==='true';if(!on)return true;let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}return ids.includes(String(channelId));}

async function routePanel(i){const p=await getSetting('default_provider')||process.env.DEFAULT_PROVIDER||'gemini',m=await getSetting('default_model')||process.env.DEFAULT_MODEL||'Chưa đặt',f=await getSetting('free_first')??'true';return i.update({embeds:[embed('🧭 ĐỊNH TUYẾN AI',`**Provider mặc định:** \`${p}\`\n**Model mặc định:** \`${m}\`\n**Ưu tiên miễn phí:** ${String(f)==='true'?'🟢 Bật':'⚪ Tắt'}`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]})}
async function healthPanel(i){await i.deferUpdate();const ps=await listProviders(),out=[];for(const p of ps.slice(0,10))try{const r=await testProvider(p.name);out.push(`🟢 **${info(p.name).name}** — ${r?.message||'OK'}`)}catch(e){out.push(`🔴 **${info(p.name).name}** — ${e.message}`)}return i.editReply({embeds:[embed('🩺 KIỂM TRA API',out.length?out.join('\n'):'Chưa có API.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]})}
async function statsPanel(i){const [p,m]=await Promise.all([listProviders(),listModels()]);return i.update({embeds:[embed('📊 THỐNG KÊ',`**API:** ${p.length}\n**Model:** ${m.length}\n**Model bật:** ${m.filter(x=>x.enabled).length}\n**Model miễn phí:** ${m.filter(x=>x.free).length}\n**Database:** PostgreSQL\n**API key:** Mã hóa`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]})}
async function suggestionPanel(i){const s=suggestedModels();return i.update({embeds:[embed('💡 MODEL ĐỀ XUẤT',s.length?s.map(m=>`### ${m.free?'🆓':'💳'} ${m.provider}/${m.name}\n${m.description||'Không có mô tả.'}`).join('\n\n'):'Chưa có danh sách.')],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ AI & MODEL').setStyle(ButtonStyle.Secondary))]})}
async function testSelected(i){await i.deferReply({ephemeral:true});const ps=await listProviders();if(!ps.length)return i.editReply('⚠️ Chưa có API.');const r=[];for(const p of ps.slice(0,10))try{const x=await testProvider(p.name);r.push(`🟢 **${info(p.name).name}** — ${x?.message||'OK'}`)}catch(e){r.push(`🔴 **${info(p.name).name}** — ${e.message}`)}return i.editReply(`🩺 **KẾT QUẢ**\n\n${r.join('\n')}`)}
async function apiDeleteSelect(i){const p=i.values[0];return i.update({embeds:[embed('⚠️ XÁC NHẬN XÓA API',`Bạn chọn **${info(p).name}**. Xóa sẽ loại bỏ cấu hình API key của provider này.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm_api_delete:${p}`).setLabel('🗑️ Xác nhận xóa').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('adm_api').setLabel('↩️ Hủy').setStyle(ButtonStyle.Secondary))]})}
async function apiDelete(i,p){await deleteProvider(p);return i.update({content:`🗑️ Đã xóa API **${info(p).name}**.`,embeds:[],components:[]})}
async function modelToggle(i){const m=await toggleModel(Number(i.values[0]));if(!m)return i.update({content:'❌ Không tìm thấy model.',embeds:[],components:[]});return i.update({embeds:[embed('🧠 MODEL',`**${m.provider}/${m.name}**\nTrạng thái: ${m.enabled?'🟢 BẬT':'⚪ TẮT'}`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ AI & MODEL').setStyle(ButtonStyle.Secondary))]})}

export async function registerAdmin(client){
  if(!client.isReady()||!client.application)throw new Error('Discord client chưa ready.');
  await client.application.commands.set([{name:'admin',description:'Mở bảng điều khiển AI Council'}]);
  if(interactionHandlerRegistered)return;interactionHandlerRegistered=true;
  client.on('interactionCreate',async i=>{try{
    if(i.isChatInputCommand()&&i.commandName==='admin'){if(!adminAllowed(i))return i.reply({content:'⛔ Bạn không có quyền dùng /admin.',ephemeral:true});return dashboard(i)}
    if(!i.isButton()&&!i.isStringSelectMenu()&&!i.isChannelSelectMenu()&&!i.isModalSubmit())return;
    if(!adminAllowed(i))return i.reply({content:'⛔ Không có quyền sử dụng bảng quản trị.',ephemeral:true});
    if(i.isModalSubmit()){if(i.customId.startsWith('adm_api_modal:'))return saveApi(i,i.customId.slice('adm_api_modal:'.length));return}
    if(i.customId==='adm_close')return i.update({content:'Đã đóng bảng quản trị.',embeds:[],components:[]});
    if(i.customId==='adm_reload')return dashboardEdit(i);
    if(i.customId==='adm_ai')return aiPanel(i);
    if(i.customId==='adm_api')return apiPanel(i);
    if(i.customId==='adm_channel')return channelPanel(i);
    if(i.customId==='adm_route')return routePanel(i);
    if(i.customId==='adm_health')return healthPanel(i);
    if(i.customId==='adm_stats')return statsPanel(i);
    if(i.customId==='adm_test')return testSelected(i);
    if(i.customId==='adm_suggest')return suggestionPanel(i);
    if(i.customId==='adm_api_select'&&i.isStringSelectMenu())return apiDeleteSelect(i);
    if(i.customId==='adm_model_select'&&i.isStringSelectMenu())return modelToggle(i);
    if(i.customId==='adm_model_pick'&&i.isStringSelectMenu())return modelPicked(i);
    if(i.customId==='adm_channel_select'&&i.isChannelSelectMenu())return channelSelected(i);
    if(i.customId==='adm_channel_enable')return channelLock(i,true);
    if(i.customId==='adm_channel_disable')return channelLock(i,false);
    if(i.customId==='adm_channel_clear')return channelClear(i);
    if(i.customId.startsWith('adm_api_provider:'))return apiProviderModal(i,i.customId.slice(17));
    if(i.customId.startsWith('adm_models_provider:'))return modelProviderPanel(i,i.customId.slice(20));
    if(i.customId.startsWith('adm_api_delete:'))return apiDelete(i,i.customId.slice(15));
  }catch(e){const msg=`❌ ${e?.message||e}`;if(i.deferred||i.replied)await i.followUp({content:msg,ephemeral:true}).catch(()=>{});else await i.reply({content:msg,ephemeral:true}).catch(()=>{})}});
}
