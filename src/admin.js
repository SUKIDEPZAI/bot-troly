import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import {
  addModel, deleteProvider, getSetting, listModels, listProviders,
  setSetting, toggleModel, upsertProvider
} from './db.js';
import { mask } from './crypto.js';
import { PROVIDERS, listRemoteModels, suggestedModels, testProvider } from './providers.js';

let interactionHandlerRegistered=false;
const csv=v=>String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
const adminAllowed=i=>i.memberPermissions?.has('Administrator') || csv(process.env.ADMIN_USER_IDS).includes(i.user.id) || Boolean(i.member?.roles?.cache && csv(process.env.ADMIN_ROLE_IDS).some(r=>i.member.roles.cache.has(r)));
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
  const [ps,ms,ff,lock,auto,council]=await Promise.all([
    listProviders(),listModels(),getSetting('free_first'),getSetting('channel_lock_enabled'),
    getSetting('auto_route_enabled'),getSetting('council_enabled')
  ]);
  const text=`Bảng điều khiển quản trị tập trung.\n\n🔑 **API:** ${ps.length}\n🧠 **Model:** ${ms.length} · 🟢 ${ms.filter(x=>x.enabled).length} bật\n🆓 **Ưu tiên miễn phí:** ${String(ff??'true')==='true'?'Bật':'Tắt'}\n🧭 **Tự định tuyến:** ${String(auto??'true')==='true'?'Bật':'Tắt'}\n🧠 **Hội đồng khi @bot/reply:** ${String(council??'true')==='true'?'Bật':'Tắt'}\n🔒 **Khóa kênh:** ${String(lock??'false')==='true'?'Bật':'Tắt'}\n\nAPI key được mã hóa trước khi lưu PostgreSQL.`;
  return i.editReply({embeds:[e('BẢNG QUẢN TRỊ AI COUNCIL',text)],components:mainRows()});
}

function providerButtonRows(prefix){
  const names=Object.keys(PROVIDERS);const rows=[];
  for(let i=0;i<names.length;i+=5){
    rows.push(new ActionRowBuilder().addComponents(...names.slice(i,i+5).map(p=>
      new ButtonBuilder().setCustomId(`${prefix}${p}`).setLabel(PROVIDERS[p].label.slice(0,80)).setStyle(ButtonStyle.Primary)
    )));
  }
  return rows;
}

async function apiPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ps=await listProviders();const configured=new Set(ps.map(p=>p.name.toLowerCase()));
  const lines=Object.entries(PROVIDERS).map(([id,p])=>`${configured.has(id)?'🟢':'⚪'} **${p.label}** — ${p.description}`).join('\n');
  const saved=ps.length?`\n\n### API đã cấu hình\n${ps.map(p=>`• **${PROVIDERS[p.name]?.label||p.name}** · 🔐 ${mask(p.api_key)}${p.last_error?' · ⚠️ lỗi gần nhất':''}`).join('\n')}`:'';
  return i.editReply({embeds:[e('🔑 QUẢN LÝ API',`Chọn nhà cung cấp. **Chỉ API key cần nhập**; Base URL được tự động chọn.\n\n${lines}${saved}`)],components:[...providerButtonRows('adm_api_provider:'),new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_test').setLabel('🩺 Kiểm tra tất cả API').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)
  )]});
}

async function apiProviderModal(i,p){
  const cfg=info(p);
  const m=new ModalBuilder().setCustomId(`adm_api_modal:${p}`).setTitle(`🔑 API — ${cfg.label}`);
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('api_key').setLabel('API KEY').setPlaceholder('Dán API key tại đây').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)
  ));
  return i.showModal(m);
}

async function saveApi(i,p){
  if(!i.deferred&&!i.replied)await i.deferReply({ephemeral:true});
  const key=i.fields.getTextInputValue('api_key').trim();const cfg=info(p);
  if(key.length<8)return i.editReply({content:'❌ API key quá ngắn. Hãy kiểm tra lại.'});
  await upsertProvider({name:p,apiKey:key,baseUrl:cfg.baseUrl});
  let check='';
  try{const r=await testProvider(p);check=`\n🟢 Kết nối OK · ${r.models.length} model chat khả dụng.`;}
  catch(err){check=`\n🟠 Đã lưu API. Kiểm tra model chưa thành công: ${String(err?.message||err).slice(0,500)}`;}
  return i.editReply({content:`✅ **Đã lưu ${cfg.label}**\n🔐 API key: ${mask(key)}${check}`});
}

async function aiPanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const [ps,ms]=await Promise.all([listProviders(),listModels()]);
  const rows=ps.length?providerButtonRows('adm_models_provider:'):[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('adm_api').setLabel('🔑 Cấu hình API trước').setStyle(ButtonStyle.Primary))];
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('adm_model_manage').setLabel('🧠 Model đã lưu').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_suggest').setLabel('💡 Gợi ý').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('adm_reload').setLabel('↩️ Bảng chính').setStyle(ButtonStyle.Secondary)
  ));
  return i.editReply({embeds:[e('🧠 AI & MODEL',`Chọn AI → bot lấy **model thật từ API** → chọn model.\n\n🔑 AI đã cấu hình: **${ps.length}**\n🧠 Model đã lưu: **${ms.length}**\n\nModel bị đánh dấu cần gói consumer/Plus/Pro hoặc chỉ dành cho subscription sẽ bị **ẩn khỏi danh sách**. Model trả về trực tiếp từ API vẫn được ưu tiên.`)],components:rows});
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
  await setSetting('default_provider',p);await setSetting('default_model',n);
  return i.editReply({embeds:[e('✅ MODEL ĐÃ LƯU',`🤖 **AI:** ${info(p).label}\n🧠 **Model:** \`${n}\`\n${free?'🆓 Free/zero-cost theo metadata':'💳 Theo API account/provider'} · T${tier}\n\n**Mô tả:** ${description}\n\nTrạng thái: ${saved.enabled?'🟢 Bật':'⚪ Tắt'}\n\n**Lưu ý:** bot sẽ tự fallback sang model khác nếu model này hết quyền, 429, timeout hoặc lỗi server.`)],components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`adm_models_provider:${p}`).setLabel('🔄 Chọn model khác').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('adm_ai').setLabel('↩️ Chọn AI').setStyle(ButtonStyle.Secondary)
  )]});
}

async function modelManagePanel(i){
  if(!i.deferred&&!i.replied)await i.deferUpdate();
  const ms=await listModels();
  if(!ms.length)return i.editReply({embeds:[e('🧠 MODEL','Chưa có model đã lưu.')],components:[back()]});
  const options=ms.slice(0,25).map(m=>({label:`${m.provider}/${m.name}`.slice(0,100),description:`${m.enabled?'🟢 Bật':'⚪ Tắt'} · T${m.tier||2} · ${m.free?'🆓':'💳'}`.slice(0,100),value:String(m.id)}));
  return i.editReply({embeds:[e('🧠 MODEL ĐÃ LƯU','Chọn model để bật/tắt. Model hidden/subscription-only không xuất hiện.')],components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('adm_model_select').setPlaceholder('Chọn model').addOptions(options)),back('adm_ai','↩️ AI & MODEL')]});
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
      if(i.isModalSubmit()){if(i.customId.startsWith('adm_api_modal:'))return saveApi(i,i.customId.split(':')[1]);return;}
      if(i.customId==='adm_close')return i.update({content:'Đã đóng bảng quản trị.',embeds:[],components:[]});
      if(i.customId==='adm_reload'){if(!i.deferred&&!i.replied)await i.deferUpdate();return dashboard(i);}
      if(i.customId==='adm_ai')return aiPanel(i);if(i.customId==='adm_api')return apiPanel(i);if(i.customId==='adm_channel')return channelPanel(i);
      if(i.customId==='adm_route')return routePanel(i);if(i.customId==='adm_route_auto')return routeToggle(i,'auto_route_enabled');if(i.customId==='adm_route_free')return routeToggle(i,'free_first');if(i.customId==='adm_route_council')return routeToggle(i,'council_enabled');
      if(i.customId==='adm_health')return healthPanel(i);if(i.customId==='adm_stats')return statsPanel(i);if(i.customId==='adm_test')return testAll(i);if(i.customId==='adm_suggest')return suggestionPanel(i);
      if(i.customId==='adm_model_manage')return modelManagePanel(i);
      if(i.customId==='adm_model_select'&&i.isStringSelectMenu()){if(!i.deferred&&!i.replied)await i.deferUpdate();const m=await toggleModel(Number(i.values[0]));return i.editReply({content:`✅ ${m?.provider||''}/${m?.name||'Model'}: ${m?.enabled?'🟢 BẬT':'⚪ TẮT'}`,embeds:[],components:[]});}
      if(i.customId==='adm_model_pick'&&i.isStringSelectMenu())return modelPicked(i);
      if(i.customId==='adm_channel_select'&&i.isChannelSelectMenu())return channelSelected(i);
      if(i.customId==='adm_channel_enable')return channelLock(i,true);if(i.customId==='adm_channel_disable')return channelLock(i,false);if(i.customId==='adm_channel_clear')return channelClear(i);
      if(i.customId.startsWith('adm_api_provider:'))return apiProviderModal(i,i.customId.split(':')[1]);
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
