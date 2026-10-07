import 'dotenv/config';
import http from 'node:http';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { initDb, getSetting, setSetting } from './db.js';
import { registerAdmin, isChannelAllowed } from './admin.js';
import { chat, suggestedModels } from './providers.js';

const PORT=Number(process.env.PORT||10000);
if(!process.env.DISCORD_TOKEN)throw new Error('Thiếu DISCORD_TOKEN');
if(!process.env.DATABASE_URL)throw new Error('Thiếu DATABASE_URL');
if(!process.env.AI_SECRET_KEY)throw new Error('Thiếu AI_SECRET_KEY');

const client=new Client({
  intents:[
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials:[Partials.Channel,Partials.Message]
});

let settingsCache={lockEnabled:false,allowed:new Set(),provider:null,model:null,loadedAt:0};
let refreshPromise=null;
async function refreshChatSettings(force=false){
  if(!force && Date.now()-settingsCache.loadedAt<5000)return settingsCache;
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{
    const lock=String(await getSetting('channel_lock_enabled')??'false')==='true';
    let ids=[];try{ids=JSON.parse(await getSetting('allowed_channel_ids')||'[]')}catch{}
    const provider=await getSetting('default_provider')||process.env.DEFAULT_PROVIDER||null;
    const model=await getSetting('default_model')||process.env.DEFAULT_MODEL||null;
    settingsCache={lockEnabled:lock,allowed:new Set(ids.map(String)),provider,model,loadedAt:Date.now()};
    return settingsCache;
  })().finally(()=>{refreshPromise=null});
  return refreshPromise;
}

async function chatAllowed(channelId){
  const s=await refreshChatSettings();
  return !s.lockEnabled || s.allowed.has(String(channelId));
}

function cleanPrompt(message){
  let text=message.content||'';
  if(client.user)text=text.replace(new RegExp(`<@!?${client.user.id}>`,'g'),'');
  return text.trim();
}

async function handleMessage(message){
  if(message.author.bot||!message.guild)return;
  const mentioned=client.user ? message.mentions.users.has(client.user.id) : false;
  const repliedToBot=message.reference?.messageId ? await message.fetchReference().then(m=>m.author?.id===client.user.id).catch(()=>false) : false;
  if(!mentioned&&!repliedToBot)return;
  if(!(await chatAllowed(message.channelId)))return;

  const prompt=cleanPrompt(message);
  if(!prompt){await message.reply('👋 Hãy nhập nội dung bạn muốn mình trả lời.');return;}

  const s=await refreshChatSettings();
  if(!s.provider||!s.model){
    await message.reply('⚠️ Bot chưa được cấu hình AI/model. Hãy dùng `/admin` → **AI & MODEL** để chọn model.');
    return;
  }

  await message.channel.sendTyping().catch(()=>{});
  const started=Date.now();
  try{
    const answer=await chat({
      provider:s.provider,
      model:s.model,
      messages:[
        {role:'system',content:'Bạn là trợ lý Discord thân thiện. Trả lời bằng tiếng Việt khi người dùng viết tiếng Việt. Trả lời ngắn gọn, rõ ràng và hữu ích.'},
        {role:'user',content:prompt}
      ],
      temperature:.7,
      maxTokens:1200
    });
    const text=String(answer||'').trim()||'⚠️ AI không trả về nội dung.';
    // Discord giới hạn 2000 ký tự mỗi message.
    for(let i=0;i<text.length;i+=1900){
      await message.reply({content:text.slice(i,i+1900),allowedMentions:{repliedUser:false}}).catch(async()=>message.channel.send(text.slice(i,i+1900)));
    }
    console.log(`🤖 AI reply ${message.guild.name} #${message.channel.name} · ${Date.now()-started}ms`);
  }catch(err){
    console.error('❌ AI chat error:',err?.stack||err);
    await message.reply({content:`❌ Không thể trả lời lúc này: ${err?.message||err}`,allowedMentions:{repliedUser:false}}).catch(()=>{});
  }
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({ok:true,botReady:client.isReady(),uptime:Math.round(process.uptime())}));return;}
  if(req.url==='/ready'){const ok=client.isReady();res.writeHead(ok?200:503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({ok,botReady:ok}));return;}
  res.writeHead(404,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'Not found'}));
});

client.on('error',err=>console.error('❌ Discord client error:',err?.stack||err));
client.on('warn',msg=>console.warn('⚠️ Discord warning:',msg));
client.on('messageCreate',message=>handleMessage(message).catch(err=>console.error('❌ messageCreate:',err?.stack||err)));
process.on('unhandledRejection',err=>console.error('❌ Unhandled promise rejection:',err?.stack||err));
process.on('uncaughtException',err=>console.error('❌ Uncaught exception:',err?.stack||err));

client.once('clientReady',async()=>{
  console.log(`✅ Bot online: ${client.user.tag}`);
  await refreshChatSettings(true).catch(err=>console.error('❌ Không tải được cấu hình chat:',err));
  try{await registerAdmin(client);console.log('✅ /admin đã sẵn sàng');}
  catch(err){console.error('❌ Đăng ký /admin thất bại:',err);}
});

await initDb();
server.listen(PORT,'0.0.0.0',()=>console.log(`🌐 Health server listening on ${PORT}`));
try{await client.login(process.env.DISCORD_TOKEN);}catch(err){console.error('❌ Discord login failed:',err);process.exit(1);}

export { client, isChannelAllowed };
