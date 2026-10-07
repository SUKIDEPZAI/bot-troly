import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { addModel, deleteProvider, getSetting, listModels, listProviders, setSetting, toggleModel, upsertProvider } from './db.js';
import { mask } from './crypto.js';
import { PROVIDERS, listRemoteModels, suggestedModels, testProvider } from './providers.js';

let interactionHandlerRegistered = false;
const csv = v => String(v || '').split(',').map(x=>x.trim()).filter(Boolean);
const adminAllowed = i => i.memberPermissions?.has('Administrator') || csv(process.env.ADMIN_USER_IDS).includes(i.user.id) || Boolean(i.member?.roles?.cache && csv(process.env.ADMIN_ROLE_IDS).some(r=>i.member.roles.cache.has(r)));
const info = p => PROVIDERS[String(p||'').toLowerCase()] || { label:p, description:'Provider tùy chỉnh.', baseUrl:'' };
const e = (title, desc='') => new EmbedBuilder().setTitle(`🤖 ${title}`).setDescription(desc || '\u200b');
const back = (id='adm_reload', label='↩️ Bảng chính') => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary));

function mainRows(){return [
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_ai').setLabel('🧠 AI & MODEL').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('adm_api').setLabel('🔑 API').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('adm_channel').setLabel('🔒 KÊNH BOT').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('adm_route').setLabel('🧭 ĐỊNH TUYẾN').setStyle(ButtonStyle.Secondary)),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_health').setLabel('🩺 KIỂM TRA').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('adm_stats').setLabel('📊 THỐNG KÊ').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('🔄 LÀM MỚI').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_close').setLabel('✖ ĐÓNG').setStyle(ButtonStyle.Danger))
];}

async function dashboard(i, edit=false){
  const [ps,ms,ff,lock]=await Promise.all([listProviders(),listModels(),getSetting('free_first'),getSetting('channel_lock_enabled')]);
  const text=`Bảng điều khiển quản trị tập trung.\n\n🔑 **API:** ${ps.length}\n🧠 **Model:** ${ms.length} · 🟢 ${ms.filter(x=>x.enabled).length} bật\n🆓 **Ưu tiên miễn phí:** ${String(ff??'true')==='true'?'Bật':'Tắt'}\n🔒 **Khóa kênh:** ${String(lock??'false')==='true'?'Bật':'Tắt'}\n\nAPI key được mã hóa trước khi lưu PostgreSQL.`;
  const payload={embeds:[e('BẢNG QUẢN TRỊ AI COUNCIL',text)],components:mainRows()};
  return edit?i.update(payload):i.reply({...payload,ephemeral:true});
}

function providerButtonRows(prefix){const names=Object.keys(PROVIDERS);const rows=[];for(let i=0;i<names.length;i+=4)rows.push(new ActionRowBuilder().addComponents(...names.slice(i,i+4).map(p=>new ButtonBuilder().setCustomId(`${prefix}${p}`).setLabel(PROVIDERS[p].label.slice(0,80)).setStyle(ButtonStyle.Primary))));return rows;}

async function apiPanel(i){
  const ps=await listProviders();
  const configured=new Set(ps.map(p=>p.name.toLowerCase()));
  const lines=Object.entries(PROVIDERS).map(([id,p])=>`${configured.has(id)?'🟢':'⚪'} **${p.label}** — ${p.description}`).join('\n');
  const saved=ps.length?`\n\n### API đã cấu hình\n${ps.map(p=>`• **${PROVIDERS[p.name]?.label||p.name}** · 🔐 ${mask(p.api_key)}`).join('\n')}`:'';
  return i.update({embeds:[e('🔑 QUẢN LÝ API',`Chọn trực tiếp nhà cung cấp bên dưới. **Chỉ API key cần nhập**; Base URL chuẩn được tự động chọn.\n\n${lines}${saved}`)],components:[...providerButtonRows('adm_api_provider:'),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_test').setLabel('🩺 Kiểm tra tất cả API').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]});
}

async function apiProviderModal(i,p){
  const cfg=info(p);const m=new ModalBuilder().setCustomId(`adm_api_modal:${p}`).setTitle(`🔑 API — ${cfg.label}`);
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('api_key').setLabel('API KEY').setPlaceholder('Dán API key tại đây').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)));
  return i.showModal(m);
}

async function saveApi(i,p){
  const key=i.fields.getTextInputValue('api_key').trim();const cfg=info(p);
  if(key.length<8)return i.reply({content:'❌ API key quá ngắn. Hãy kiểm tra lại.',ephemeral:true});
  await upsertProvider({name:p,apiKey:key,baseUrl:cfg.baseUrl});
  let check='';try{const r=await testProvider(p);check=`\n🟢 Kiểm tra kết nối: ${r.message}`;}catch(err){check=`\n🟠 Đã lưu API nhưng kiểm tra thất bại: ${err.message}`;}
  return i.reply({content:`✅ **Đã lưu ${cfg.label}**\n🔐 API key: [0m${mask(key)}${check}`,ephemeral:true});
}

async function aiPanel(i){
  const ps=await listProviders();const ms=await listModels();
  const rows=[];
  if(ps.length) rows.push(...providerButtonRows('adm_models_provider:'));
  else rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_api').setLabel('🔑 Cấu hình API trước').setStyle(ButtonStyle.Primary)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_suggest').setLabel('💡 Model đề xuất').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)));
  return i.update({embeds:[e('🧠 AI & MODEL',`Luồng mới: **chọn AI → hệ thống gọi API lấy model thật → chọn model**. Không cần nhập Model ID.\n\n🔑 AI đã cấu hình: **${ps.length}**\n🧠 Model đã lưu: **${ms.length}**\n\nModel được lấy trực tiếp từ API của provider, sau đó có thể lưu vào PostgreSQL.`)],components:rows});
}

async function modelProviderPanel(i,p){
  await i.deferUpdate();
  let remote=[];let remoteError='';
  try{remote=await listRemoteModels(p);}catch(err){remoteError=err.message;}
  const saved=await listModels(p);const map=new Map();
  for(const m of remote)map.set(m.id,{...m,name:m.id});
  for(const m of saved)if(!map.has(m.name))map.set(m.name,{id:m.name,name:m.name,description:m.description,free:m.free,saved:true});
  if(!map.size)for(const m of suggestedModels(p))map.set(m.name,{id:m.name,name:m.name,description:m.description,free:m.free,suggested:true});
  const arr=[...map.values()].slice(0,25);
  const options=arr.map(m=>({label:String(m.name).slice(0,100),description:`${m.free?'🆓 Miễn phí':'💳 Theo tài khoản'} · ${(m.description||'Model khả dụng').replace(/\s+/g,' ').slice(0,75)}`,value:`${p}::${m.id}` }));
  const note=remoteError?`\n\n⚠️ **Không lấy được danh sách trực tiếp:** ${remoteError}\nĐang hiển thị model đã lưu/gợi ý.`:`\n\n🟢 **Đã lấy ${remote.length} model trực tiếp từ API.**`;
  const rows=[];if(options.length)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_pick').setPlaceholder(`Chọn model của ${info(p).label}`).addOptions(options)));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm_models_refresh:${p}`).setLabel('🔄 Tải lại model').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI khác').setStyle(ButtonStyle.Secondary)));
  return i.editReply({embeds:[e(`🧠 MODEL — ${info(p).label}`,`${info(p).description}${note}\n\nChọn một model bên dưới để lưu. Không cần tự nhập ID.`)],components:rows});
}

async function refreshModels(i,p){return modelProviderPanel(i,p);}
async function modelPicked(i){
  const [p,n]=String(i.values[0]).split('::');const suggestions=suggestedModels(p);let meta=null;
  try{meta=(await listRemoteModels(p)).find(x=>x.id===n)||null;}catch{}
  const fallback=suggestions.find(x=>x.name===n);const free=meta?.free??fallback?.free??false;const description=meta?.description||fallback?.description||`Model ${n} của ${info(p).label}.`;
  const saved=await addModel({provider:p,name:n,free,description});
  return i.update({embeds:[e('✅ MODEL ĐÃ LƯU',`🤖 **AI:** ${info(p).label}\n🧠 **Model:** \`${n}\`\n${free?'🆓 Miễn phí':'💳 Theo tài khoản/provider'}\n\n**Mô tả:** ${description}\n\nTrạng thái: ${saved.enabled?'🟢 Đang bật':'⚪ Đang tắt'}`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm_models_provider:${p}`).setLabel('🔄 Chọn model khác').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI').setStyle(ButtonStyle.Secondary))]});
}

async function modelManagePanel(i){
  const ms=await listModels();if(!ms.length)return i.update({embeds:[e('🧠 MODEL','Chưa có model đã lưu.')],components:[back()]});
  const options=ms.slice(0,25).map(m=>({label:`${m.provider}/${m.name}`.slice(0,100),description:`${m.enabled?'🟢 Bật':'⚪ Tắt'} · ${m.free?'🆓':'💳'}`.slice(0,100),value:String(m.id)}));
  return i.update({embeds:[e('🧠 MODEL ĐÃ LƯU','Chọn model để bật/tắt.')],components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_select').setPlaceholder('Chọn model').addOptions(options)),back('adm_ai','↩️ AI & MODEL')]});
}

async function channelPanel(i){const enabled=String(await getSetting('channel_lock_enabled')??'false')==='true';let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{};const names=ids.map(id=>i.guild?.channels?.cache?.get(id)?`• <#${id}>`:`• \`${id}\``);return i.update({embeds:[e('🔒 KHÓA KÊNH BOT',`${enabled?'🔒 **ĐANG BẬT:** bot chỉ được phản hồi trong kênh cho phép.':'🔓 **ĐANG TẮT:** bot không giới hạn kênh.'}\n\n**Kênh cho phép:**\n${names.length?names.join('\n'):'Chưa chọn.'}\n\nChọn kênh bằng menu, sau đó bật khóa.`)],components:[new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_channel_select').setPlaceholder('Chọn kênh được phép').setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(10)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(enabled?'adm_channel_disable':'adm_channel_enable').setLabel(enabled?'🔓 Tắt khóa':'🔒 Bật khóa').setStyle(enabled?ButtonStyle.Success:ButtonStyle.Danger),new ButtonBuilder().setCustomId('adm_channel_clear').setLabel('🗑️ Xóa danh sách').setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary))]});}
async function channelSelected(i){await setSetting('allowed_channel_ids',JSON.stringify([...new Set(i.values||[])]));return channelPanel(i);}
async function channelLock(i,on){await setSetting('channel_lock_enabled',on?'true':'false');return channelPanel(i);}
async function channelClear(i){await setSetting('allowed_channel_ids','[]');await setSetting('channel_lock_enabled','true');return channelPanel(i);}
export async function isChannelAllowed(channelId){const on=String(await getSetting('channel_lock_enabled')??'false')==='true';if(!on)return true;let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}return ids.includes(String(channelId));}

async function routePanel(i){const p=await getSetting('default_provider')||process.env.DEFAULT_PROVIDER||'gemini';const m=await getSetting('default_model')||process.env.DEFAULT_MODEL||'Chưa đặt';const f=await getSetting('free_first')??'true';return i.update({embeds:[e('🧭 ĐỊNH TUYẾN',`**AI mặc định:** \`${p}\`\n**Model mặc định:** \`${m}\`\n**Ưu tiên miễn phí:** ${String(f)==='true'?'🟢 Bật':'⚪ Tắt'}\n\nCấu hình được lưu trong PostgreSQL.`)],components:[back()]});}
async function healthPanel(i){await i.deferUpdate();const ps=await listProviders();const out=[];for(const p of ps){try{const r=await testProvider(p.name);out.push(`🟢 **${info(p.name).label}** — ${r.message}`)}catch(err){out.push(`🔴 **${info(p.name).label}** — ${err.message}`)}}return i.editReply({embeds:[e('🩺 KIỂM TRA API',out.length?out.join('\n'):'Chưa có API.')],components:[back()]});}
async function statsPanel(i){const [p,m]=await Promise.all([listProviders(),listModels()]);return i.update({embeds:[e('📊 THỐNG KÊ',`🔑 **API:** ${p.length}\n🧠 **Model:** ${m.length}\n🟢 **Model bật:** ${m.filter(x=>x.enabled).length}\n🆓 **Model miễn phí:** ${m.filter(x=>x.free).length}\n🗄️ **Database:** PostgreSQL\n🔐 **API key:** AES-256-GCM`)],components:[back()]});}
async function suggestionPanel(i){const s=suggestedModels();return i.update({embeds:[e('💡 MODEL ĐỀ XUẤT',s.map(m=>`**${m.provider}/${m.name}** ${m.free?'🆓':'💳'}\n${m.description}`).join('\n\n'))],components:[back('adm_ai','↩️ AI & MODEL')]});}
async function testAll(i){await i.deferReply({ephemeral:true});const ps=await listProviders();if(!ps.length)return i.editReply('⚠️ Chưa cấu hình API nào.');const out=[];for(const p of ps){try{out.push(`🟢 ${info(p.name).label}: ${(await testProvider(p.name)).message}`)}catch(err){out.push(`🔴 ${info(p.name).label}: ${err.message}`)}}return i.editReply(out.join('\n'));}
async function apiDeleteSelect(i){const p=i.values[0];return i.update({embeds:[e('⚠️ XÁC NHẬN XÓA API',`Bạn chọn **${info(p).label}**. Xóa sẽ xóa API key và các model đã lưu của provider.`)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`adm_api_delete:${p}`).setLabel('🗑️ Xác nhận xóa').setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId('adm_api').setLabel('↩️ Hủy').setStyle(ButtonStyle.Secondary))]});}

export async function registerAdmin(client){
  if(!client.isReady()||!client.application)throw new Error('Discord client chưa ready.');
  await client.application.commands.set([{name:'admin',description:'Mở bảng điều khiển AI Council'}]);
  if(interactionHandlerRegistered)return;interactionHandlerRegistered=true;
  client.on('interactionCreate',async i=>{try{
    if(i.isChatInputCommand()&&i.commandName==='admin'){if(!adminAllowed(i))return i.reply({content:'⛔ Bạn không có quyền dùng /admin.',ephemeral:true});return dashboard(i);}
    if(!i.isButton()&&!i.isStringSelectMenu()&&!i.isChannelSelectMenu()&&!i.isModalSubmit())return;
    if(!adminAllowed(i))return i.reply({content:'⛔ Không có quyền sử dụng bảng quản trị.',ephemeral:true});
    if(i.isModalSubmit()){if(i.customId.startsWith('adm_api_modal:'))return saveApi(i,i.customId.split(':')[1]);return;}
    if(i.customId==='adm_close')return i.update({content:'Đã đóng bảng quản trị.',embeds:[],components:[]});
    if(i.customId==='adm_reload')return dashboard(i,true);if(i.customId==='adm_ai')return aiPanel(i);if(i.customId==='adm_api')return apiPanel(i);if(i.customId==='adm_channel')return channelPanel(i);if(i.customId==='adm_route')return routePanel(i);if(i.customId==='adm_health')return healthPanel(i);if(i.customId==='adm_stats')return statsPanel(i);if(i.customId==='adm_test')return testAll(i);if(i.customId==='adm_suggest')return suggestionPanel(i);
    if(i.customId==='adm_model_manage')return modelManagePanel(i);if(i.customId==='adm_model_select'&&i.isStringSelectMenu())return toggleModel(Number(i.values[0])).then(m=>i.update({content:`✅ ${m?.name||'Model'}: ${m?.enabled?'🟢 BẬT':'⚪ TẮT'}`,embeds:[],components:[]}));
    if(i.customId==='adm_model_pick'&&i.isStringSelectMenu())return modelPicked(i);if(i.customId==='adm_channel_select'&&i.isChannelSelectMenu())return channelSelected(i);if(i.customId==='adm_channel_enable')return channelLock(i,true);if(i.customId==='adm_channel_disable')return channelLock(i,false);if(i.customId==='adm_channel_clear')return channelClear(i);
    if(i.customId==='adm_api_select'&&i.isStringSelectMenu())return apiDeleteSelect(i);if(i.customId.startsWith('adm_api_provider:'))return apiProviderModal(i,i.customId.split(':')[1]);if(i.customId.startsWith('adm_models_provider:'))return modelProviderPanel(i,i.customId.split(':')[1]);if(i.customId.startsWith('adm_models_refresh:'))return refreshModels(i,i.customId.split(':')[1]);if(i.customId.startsWith('adm_api_delete:')){await deleteProvider(i.customId.split(':')[1]);return i.update({content:'🗑️ Đã xóa API và model của provider.',embeds:[],components:[]});}
  }catch(err){const msg=`❌ ${err?.message||err}`;if(i.deferred||i.replied)await i.followUp({content:msg,ephemeral:true}).catch(()=>{});else await i.reply({content:msg,ephemeral:true}).catch(()=>{});}});
}
