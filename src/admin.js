import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, PermissionsBitField
} from 'discord.js';
import {
  addModel, deleteProvider, getSetting, listModels, listProviders,
  setSetting, toggleModel, setModelEnabled, setAllModelsEnabled, upsertProvider
} from './db.js';
import { mask } from './crypto.js';
import { PROVIDERS, listRemoteModels, suggestedModels, testProvider } from './providers.js';

let interactionHandlerRegistered=false;
const csv=v=>String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
const adminAllowed=i=>{const roles=i.member?.roles?.cache?[...i.member.roles.cache.keys()]:Array.isArray(i.member?.roles)?i.member.roles:[];return Boolean(i.memberPermissions?.has(PermissionsBitField.Flags.Administrator))||csv(process.env.ADMIN_USER_IDS).includes(i.user.id)||csv(process.env.ADMIN_ROLE_IDS).some(r=>roles.includes(r));};
const info=p=>PROVIDERS[String(p||'').toLowerCase()]||{label:p,description:'Provider tùy chỉnh.',baseUrl:''};
const e=(title,desc='')=>new EmbedBuilder().setTitle(`🤖 ${title}`).setDescription(desc||'\u200b');
const back=(id='adm_reload',label='↩️ Bảng chính')=>new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary));

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

async function dashboard(i){
  const [allPs,allMs,ff,lock,auto,council]=await Promise.all([
    listProviders(),listModels(),getSetting('free_first'),getSetting('channel_lock_enabled'),
    getSetting('auto_route_enabled'),getSetting('council_enabled')
  ]);
  const ps=allPs.filter(x=>String(x.name).toLowerCase()==='motapis');const ms=allMs.filter(x=>String(x.provider).toLowerCase()==='motapis');
  const text=`Bảng điều khiển quản trị tập trung.\n\n💬 **Quản trị bằng câu chat bình thường:** admin có thể yêu cầu khóa/mở kênh, tạo/xóa kênh, tạo/gán/gỡ role, timeout/kick/ban, cảnh cáo, dọn tin nhắn, xem audit log… Không cần slash command. Hành động nguy hiểm sẽ yêu cầu xác nhận.\n\n🔑 **Gateway:** Motapis · ${process.env.MOTAPIS_API_KEY?'🟢 Render key đã đặt':'🔴 Thiếu Render key'}\n🧠 **Model:** ${ms.length} · 🟢 ${ms.filter(x=>x.enabled).length} bật\n🆓 **Ưu tiên miễn phí:** ${String(ff??'true')==='true'?'Bật':'Tắt'}\n🧭 **Tự định tuyến:** ${String(auto??'true')==='true'?'Bật':'Tắt'}\n🧠 **Hội đồng khi @bot/reply:** ${String(council??'true')==='true'?'Bật':'Tắt'}\n🔒 **Khóa kênh:** ${String(lock??'false')==='true'?'Bật':'Tắt'}\n\nAPI key chỉ lấy từ Render Environment; không nhập hoặc lưu API key qua /admin.`;
  return i.editReply({embeds:[e('BẢNG QUẢN TRỊ AI COUNCIL',text)],components:mainRows()});
}

function providerButtonRows(prefix){
  const names=Object.keys(PROVIDERS).filter(n=>n==='motapis');const rows=[];
  for(let i=0;i<names.length;i+=5){
    rows.push(new ActionRowBuilder().addComponents(...names.slice(i,i+5).map(p=>
      new ButtonBuilder().setCustomId(`${prefix}${p}`).setLabel(PROVIDERS[p].label.slice(0,80)).setStyle(ButtonStyle.Primary)
    )));
  }
  return rows;
}

async function apiPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ps=await listProviders();
  const p=ps.find(x=>x.name==='motapis');
  const configured=Boolean(process.env.MOTAPIS_API_KEY && process.env.MOTAPIS_API_KEY.trim());
  return i.editReply({embeds:[e('🔑 MOTAPIS API',`${configured?'🟢':'🔴'} **MOTAPIS_API_KEY:** ${configured?'đã có trong Render Environment':'chưa được đặt'}

**Base URL cố định:** https://motapis.com/v1
**API key không nhập trong /admin.** Đặt biến \`MOTAPIS_API_KEY\` trong Render → Web Service → Environment rồi redeploy.

${p?.last_error?`⚠️ Lỗi gần nhất: ${String(p.last_error).slice(0,300)}`:'Không hiển thị hoặc lưu API key trong Discord.'}`)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_test').setLabel('🩺 Kiểm tra Motapis').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)
  )]});
}

async function modelProviderPanel(i,p,page=0){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  let remote=[];let remoteError='';
  try{remote=await listRemoteModels(p);}catch(err){remoteError=err?.message||String(err);}
  const saved=await listModels(p);const map=new Map();
  for(const m of remote)map.set(m.id,{...m,name:m.id});
  for(const m of saved)if(!map.has(m.name))map.set(m.name,{id:m.name,name:m.name,description:m.description,free:m.free,tier:m.tier,context:m.context_length,saved:true});
  if(!map.size)for(const m of suggestedModels(p))map.set(m.name,{id:m.name,name:m.name,description:m.description,free:m.free,tier:m.tier,suggested:true});
  const all=[...map.values()];
  const pages=Math.max(1,Math.ceil(all.length/25));const current=Math.min(Math.max(Number(page)||0,0),pages-1);
  const arr=all.slice(current*25,current*25+25);
  const options=arr.map(m=>({
    label:String(m.name).slice(0,100),
    description:`${m.free?'🆓':'💳'} · T${m.tier||2} · ${(m.description||'Model khả dụng').replace(/\s+/g,' ').slice(0,70)}`,
    value:`${p}::${m.id}`
  }));
  const note=remoteError?`\n\n⚠️ **Không lấy được catalog trực tiếp:** ${remoteError}\nĐang dùng model đã lưu/gợi ý.`:`\n\n🟢 **Catalog API:** ${remote.length} model chat sau khi lọc.\n📄 Trang ${current+1}/${pages}`;
  const rows=[];
  if(options.length)rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_pick').setPlaceholder(`Chọn model của ${info(p).label}`).addOptions(options)));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`adm_models_page:${p}:${Math.max(0,current-1)}`).setLabel('⬅️ Trang trước').setStyle(ButtonStyle.Secondary).setDisabled(current===0),
    new ButtonBuilder().setCustomId(`adm_models_page:${p}:${Math.min(pages-1,current+1)}`).setLabel('Trang sau ➡️').setStyle(ButtonStyle.Secondary).setDisabled(current>=pages-1),
    new ButtonBuilder().setCustomId(`adm_models_refresh:${p}`).setLabel('🔄 Tải lại').setStyle(ButtonStyle.Success)
  ));
  rows.push(back('adm_ai','↩️ Chọn AI khác'));
  return i.editReply({embeds:[e(`🧠 MODEL — ${info(p).label}`,`${info(p).description}${note}\n\nChọn model để lưu. Không cần tự nhập Model ID.`)],components:rows});
}

async function modelPicked(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const [p,...parts]=String(i.values[0]).split('::');const n=parts.join('::');
  const suggestions=suggestedModels(p);let meta=null;
  try{meta=(await listRemoteModels(p)).find(x=>x.id===n)||null;}catch{}
  const fallback=suggestions.find(x=>x.name===n);
  const free=meta?.free??fallback?.free??false;
  const tier=meta?.tier??fallback?.tier??2;
  const contextLength=meta?.context??null;
  const description=meta?.description||fallback?.description||`Model ${n} của ${info(p).label}.`;
  const saved=await addModel({provider:p,name:n,free,description,tier,contextLength,capabilities:meta?.capabilities||''});
  const savedEnabled=await setModelEnabled(saved.id,true);
  await setSetting('default_provider',p);await setSetting('default_model',n);
  return i.editReply({embeds:[e('✅ MODEL ĐÃ LƯU',`🤖 **AI:** ${info(p).label}\n🧠 **Model:** \`${n}\`\n${free?'🆓 Free/zero-cost theo metadata':'💳 Theo API account/provider'} · T${tier}\n\n**Mô tả:** ${description}\n\nTrạng thái: ${savedEnabled?.enabled?'🟢 Bật':'⚪ Tắt'}\n\n**Lưu ý:** bot sẽ tự fallback sang model khác nếu model này hết quyền, 429, timeout hoặc lỗi server.`)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`adm_models_provider:${p}`).setLabel('🔄 Chọn model khác').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI').setStyle(ButtonStyle.Secondary)
  )]});
}

async function aiPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ms=await listModels('motapis',true);
  const enabled=ms.filter(m=>m.enabled&&!m.hidden).length;
  const [provider,model]=await Promise.all([getSetting('default_provider'),getSetting('default_model')]);
  const description=`**Gateway:** Motapis · https://motapis.com/v1\n**Model đã khai báo:** ${ms.length} · **Đang bật:** ${enabled}\n**Model mặc định:** \`${provider||'motapis'} / ${model||'tự chọn'}\`\n\nBật/tắt từng model bằng menu quản lý bên dưới. Model tắt sẽ không được Auto Router sử dụng; model mặc định được chọn sẽ tự bật lại nếu bạn chọn nó.`;
  return i.editReply({embeds:[e('🧠 AI & MODEL',description)],components:[
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_models_provider:motapis:0').setLabel('📋 Danh sách/chọn model').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('adm_model_manage_page:motapis:0').setLabel('⚙️ Bật/tắt model').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm_suggest').setLabel('💡 Thông tin model').setStyle(ButtonStyle.Secondary)
    ), back()
  ]});
}

async function modelManagePanel(i,provider='motapis',page=0){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ms=await listModels(provider,true);
  if(!ms.length)return i.editReply({embeds:[e('🧠 MODEL','Chưa có model đã lưu. Đảm bảo MOTAPIS_API_KEY được đặt trong Render rồi redeploy.')],components:[back('adm_ai','↩️ AI & MODEL')]});
  const pages=Math.max(1,Math.ceil(ms.length/25));
  const current=Math.max(0,Math.min(Number(page)||0,pages-1));
  const shown=ms.slice(current*25,current*25+25);
  const options=shown.map(m=>({
    label:`${m.enabled?'🟢':'⚪'} ${m.name}`.slice(0,100),
    description:`${m.enabled?'Đang bật':'Đang tắt'} · T${m.tier||2} · ${m.free?'Free metadata':'theo quyền API'}`.slice(0,100),
    value:String(m.id)
  }));
  const desc=ms.map(m=>`${m.enabled?'🟢':'⚪'} \`${m.name}\` — ${m.enabled?'BẬT':'TẮT'}`).join('\n');
  return i.editReply({embeds:[e('⚙️ BẬT / TẮT MODEL',`Chọn một model để đổi trạng thái. Mặc định: ${current+1}/${pages}.\n🟢 bật = có thể được router chọn · ⚪ tắt = không dùng.\n\n${desc.slice(0,3500)}`)],components:[
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_select').setPlaceholder('Chọn model để bật/tắt').addOptions(options)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`adm_model_bulk_on:${provider}`).setLabel('✅ Bật tất cả').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`adm_model_bulk_off:${provider}`).setLabel('⏸️ Tắt tất cả').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`adm_model_manage_page:${provider}:${Math.max(0,current-1)}`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(current===0),
      new ButtonBuilder().setCustomId(`adm_model_manage_page:${provider}:${Math.min(pages-1,current+1)}`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(current>=pages-1)
    ), back('adm_ai','↩️ AI & MODEL')
  ]});
}

async function channelPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const enabled=String(await getSetting('channel_lock_enabled')??'false')==='true';
  let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}
  const names=ids.map(id=>i.guild?.channels?.cache?.get(id)?`• <#${id}>`:`• \`${id}\``);
  return i.editReply({embeds:[e('🔒 KHÓA KÊNH BOT',`${enabled?'🔒 **ĐANG BẬT:** bot chỉ phản hồi trong các kênh được chọn.':'🔓 **ĐANG TẮT:** bot không giới hạn kênh.'}\n\n**${ids.length} kênh đang chọn**\n${names.length?names.join('\n'):'Chưa chọn.'}\n\nMenu cho phép chọn thêm nhiều kênh; lựa chọn mới sẽ **cộng thêm**, không ghi đè.`)],components:[
    new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId('adm_channel_select').setPlaceholder('Chọn nhiều kênh được phép').setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(25)),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(enabled?'adm_channel_disable':'adm_channel_enable').setLabel(enabled?'🔓 Tắt khóa':'🔒 Bật khóa').setStyle(enabled?ButtonStyle.Success:ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('adm_channel_clear').setLabel('🗑️ Xóa tất cả').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)
    )
  ]});
}

async function channelSelected(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}
  const merged=[...new Set([...ids.map(String),...(i.values||[]).map(String)])];
  await setSetting('allowed_channel_ids',JSON.stringify(merged));
  return channelPanel(i);
}
async function channelLock(i,on){if(!i.deferred&&!i.replied)await i.deferUpdate();await setSetting('channel_lock_enabled',on?'true':'false');return channelPanel(i);}
async function channelClear(i){if(!i.deferred&&!i.replied)await i.deferUpdate();await setSetting('allowed_channel_ids','[]');await setSetting('channel_lock_enabled','true');return channelPanel(i);}
export async function isChannelAllowed(channelId){const on=String(await getSetting('channel_lock_enabled')??'false')==='true';if(!on)return true;let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}return ids.includes(String(channelId));}

async function routePanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const [p,m,f,a,c]=await Promise.all([getSetting('default_provider'),getSetting('default_model'),getSetting('free_first'),getSetting('auto_route_enabled'),getSetting('council_enabled')]);
  return i.editReply({embeds:[e('🧭 ĐỊNH TUYẾN',`**AI mặc định:** \`${p||'auto'}\`\n**Model mặc định:** \`${m||'auto'}\`\n🆓 **Ưu tiên miễn phí:** ${String(f??'true')==='true'?'🟢 Bật':'⚪ Tắt'}\n🧭 **Tự phân tích độ khó:** ${String(a??'true')==='true'?'🟢 Bật':'⚪ Tắt'}\n🧠 **@bot / reply = Hội đồng nhiều AI:** ${String(c??'true')==='true'?'🟢 Bật':'⚪ Tắt'}\n\n**Cách chạy:** nhắn bình thường trong kênh được phép → tự chọn tuyến/model theo độ khó. @bot hoặc reply vào bot → gọi nhiều AI đã cấu hình song song.`)],components:[
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('adm_route_auto').setLabel(String(a??'true')==='true'?'🧭 Tắt Auto Route':'🧭 Bật Auto Route').setStyle(String(a??'true')==='true'?ButtonStyle.Danger:ButtonStyle.Success),
      new ButtonBuilder().setCustomId('adm_route_free').setLabel(String(f??'true')==='true'?'🆓 Tắt Free First':'🆓 Bật Free First').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('adm_route_council').setLabel(String(c??'true')==='true'?'🧠 Tắt Council':'🧠 Bật Council').setStyle(ButtonStyle.Primary)
    ),back()
  ]});
}
async function routeToggle(i,key){if(!i.deferred&&!i.replied)await i.deferUpdate();const old=String(await getSetting(key)??'true')==='true';await setSetting(key,old?'false':'true');return routePanel(i);}

async function healthPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ps=await listProviders();
  if(!ps.length)return i.editReply({embeds:[e('🩺 KIỂM TRA API','Chưa có API.')],components:[back()]});
  const results=await Promise.allSettled(ps.map(async p=>({p,r:await testProvider(p.name)})));
  const out=results.map(x=>x.status==='fulfilled'?`🟢 **${info(x.value.p.name).label}** — ${x.value.r.message}`:`🔴 API lỗi — ${String(x.reason?.message||x.reason).slice(0,220)}`);
  return i.editReply({embeds:[e('🩺 KIỂM TRA API',out.join('\n'))],components:[back()]});
}

async function statsPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const [p,m]=await Promise.all([listProviders(),listModels()]);
  return i.editReply({embeds:[e('📊 THỐNG KÊ',`🔑 **API:** ${p.length}\n🧠 **Model:** ${m.length}\n🟢 **Model bật:** ${m.filter(x=>x.enabled).length}\n🆓 **Model free/zero-cost metadata:** ${m.filter(x=>x.free).length}\n🧭 **Provider đang cooldown:** ${p.filter(x=>x.cooldown_until&&new Date(x.cooldown_until)>new Date()).length}\n🗄️ **Database:** PostgreSQL\n🔐 **API key:** AES-256-GCM`)],components:[back()]});
}

async function suggestionPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const s=suggestedModels();
  const text=s.slice(0,40).map(m=>`**${m.provider}/${m.name}** ${m.free?'🆓':'💳'} · T${m.tier}\n${m.description}`).join('\n\n');
  return i.editReply({embeds:[e('💡 MODEL ĐỀ XUẤT',text)],components:[back('adm_ai','↩️ AI & MODEL')]});
}

async function testAll(i){
  if(!i.deferred&&!i.replied)await i.deferReply({ephemeral:true});
  const ps=await listProviders();if(!ps.length)return i.editReply('⚠️ Chưa cấu hình API nào.');
  const results=await Promise.allSettled(ps.map(async p=>({p,r:await testProvider(p.name)})));
  return i.editReply(results.map(x=>x.status==='fulfilled'?`🟢 ${info(x.value.p.name).label}: ${x.value.r.message}`:`🔴 ${String(x.reason?.message||x.reason).slice(0,300)}`).join('\n'));
}

export async function registerAdmin(client){
  if(!client.isReady()||!client.application)throw new Error('Discord client chưa ready.');
  await client.application.commands.set([{name:'admin',description:'Mở bảng điều khiển AI Council'}]);
  if(interactionHandlerRegistered)return;
  interactionHandlerRegistered=true;
  client.on('interactionCreate',async i=>{
    try{
      if(i.isChatInputCommand()&&i.commandName==='admin'){
        if(!adminAllowed(i))return i.reply({content:'⛔ Bạn không có quyền dùng /admin.',ephemeral:true});
        await i.deferReply({ephemeral:true});return dashboard(i);
      }
      if(!i.isButton()&&!i.isStringSelectMenu()&&!i.isChannelSelectMenu()&&!i.isModalSubmit())return;
      if(!adminAllowed(i))return i.reply({content:'⛔ Không có quyền sử dụng bảng quản trị.',ephemeral:true});
      if(i.isModalSubmit())return;
      if(i.customId==='adm_close')return i.update({content:'Đã đóng bảng quản trị.',embeds:[],components:[]});
      if(i.customId==='adm_reload'){if(!i.deferred&&!i.replied)await i.deferUpdate();return dashboard(i);}
      if(i.customId==='adm_ai')return aiPanel(i);if(i.customId==='adm_api')return apiPanel(i);if(i.customId==='adm_channel')return channelPanel(i);
      if(i.customId==='adm_route')return routePanel(i);if(i.customId==='adm_route_auto')return routeToggle(i,'auto_route_enabled');if(i.customId==='adm_route_free')return routeToggle(i,'free_first');if(i.customId==='adm_route_council')return routeToggle(i,'council_enabled');
      if(i.customId==='adm_health')return healthPanel(i);if(i.customId==='adm_stats')return statsPanel(i);if(i.customId==='adm_test')return testAll(i);if(i.customId==='adm_suggest')return suggestionPanel(i);
      if(i.customId==='adm_model_manage')return modelManagePanel(i);
      if(i.customId==='adm_model_select'&&i.isStringSelectMenu()){if(!i.deferred&&!i.replied)await i.deferUpdate();const m=await toggleModel(Number(i.values[0]));if(m && !m.enabled && String(await getSetting('default_model')||'')===m.name){const next=(await listModels(m.provider,true)).find(x=>x.enabled&&!x.hidden);await setSetting('default_provider',next?.provider||'motapis');await setSetting('default_model',next?.name||'');}return modelManagePanel(i,m?.provider||'motapis',0);}
      if(i.customId.startsWith('adm_model_manage_page:')){const [,p,page]=i.customId.split(':');return modelManagePanel(i,p,Number(page||0));}
      if(i.customId.startsWith('adm_model_bulk_on:')||i.customId.startsWith('adm_model_bulk_off:')){if(!i.deferred&&!i.replied)await i.deferUpdate();const [action,p]=i.customId.split(':');const count=await setAllModelsEnabled(p,action==='adm_model_bulk_on');if(action==='adm_model_bulk_off')await setSetting('default_model','');return modelManagePanel(i,p,0);}
      if(i.customId==='adm_model_pick'&&i.isStringSelectMenu())return modelPicked(i);
      if(i.customId==='adm_channel_select'&&i.isChannelSelectMenu())return channelSelected(i);
      if(i.customId==='adm_channel_enable')return channelLock(i,true);if(i.customId==='adm_channel_disable')return channelLock(i,false);if(i.customId==='adm_channel_clear')return channelClear(i);
      if(i.customId.startsWith('adm_api_provider:'))return apiPanel(i);
      if(i.customId.startsWith('adm_models_provider:')){const [,p,page]=i.customId.split(':');return modelProviderPanel(i,p,Number(page||0));}
      if(i.customId.startsWith('adm_models_page:')){const [,p,page]=i.customId.split(':');return modelProviderPanel(i,p,Number(page||0));}
      if(i.customId.startsWith('adm_models_refresh:'))return modelProviderPanel(i,i.customId.split(':')[1],0);
      if(i.customId.startsWith('adm_api_delete:')){
        if(!i.deferred&&!i.replied)await i.deferUpdate();
        await deleteProvider(i.customId.split(':')[1]);
        return i.editReply({content:'🗑️ Đã xóa API và model của provider.',embeds:[],components:[]});
      }
    }catch(err){
      const msg=`❌ ${err?.message||err}`;
      if(i.deferred||i.replied)await i.followUp({content:msg,ephemeral:true}).catch(()=>{});
      else await i.reply({content:msg,ephemeral:true}).catch(()=>{});
    }
  });
}
