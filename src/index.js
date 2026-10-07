import 'dotenv/config';
import http from 'node:http';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  addModel, getSetting, initDb, listModels, listProviders, recordProviderFailure,
  recordProviderSuccess, setSetting
} from './db.js';
import { registerAdmin } from './admin.js';
import { PROVIDERS, chat, isTransientError, listRemoteModels, suggestedModels } from './providers.js';

const PORT=Number(process.env.PORT||10000);
if(!process.env.DISCORD_TOKEN)throw new Error('Thiếu DISCORD_TOKEN');
if(!process.env.DATABASE_URL)throw new Error('Thiếu DATABASE_URL');
if(!process.env.AI_SECRET_KEY)throw new Error('Thiếu AI_SECRET_KEY');

const client=new Client({
  intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],
  partials:[Partials.Channel,Partials.Message]
});

const settingsCache={value:null,expiresAt:0,promise:null};
const routeCache={value:null,expiresAt:0,promise:null};
const CACHE_MS=5000;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

async function loadSettings(force=false){
  if(!force && settingsCache.value && settingsCache.expiresAt>Date.now())return settingsCache.value;
  if(settingsCache.promise)return settingsCache.promise;
  settingsCache.promise=(async()=>{
    const [lock,allowed,provider,model,freeFirst,autoRoute,council]=await Promise.all([
      getSetting('channel_lock_enabled'),getSetting('allowed_channel_ids'),getSetting('default_provider'),
      getSetting('default_model'),getSetting('free_first'),getSetting('auto_route_enabled'),getSetting('council_enabled')
    ]);
    let ids=[];try{ids=JSON.parse(allowed||'[]')}catch{}
    settingsCache.value={
      lockEnabled:String(lock??'false')==='true',allowed:new Set(ids.map(String)),
      defaultProvider:provider||process.env.DEFAULT_PROVIDER||null,
      defaultModel:model||process.env.DEFAULT_MODEL||null,
      freeFirst:String(freeFirst??'true')==='true',autoRoute:String(autoRoute??'true')==='true',
      council:String(council??'true')==='true'
    };
    settingsCache.expiresAt=Date.now()+CACHE_MS;
    return settingsCache.value;
  })().finally(()=>{settingsCache.promise=null});
  return settingsCache.promise;
}

async function channelAllowed(channelId){
  const s=await loadSettings();
  return !s.lockEnabled || s.allowed.has(String(channelId));
}

async function loadRoute(force=false){
  if(!force && routeCache.value && routeCache.expiresAt>Date.now())return routeCache.value;
  if(routeCache.promise)return routeCache.promise;
  routeCache.promise=(async()=>{
    const state=await listProvidersAndModels();
    routeCache.value=state;routeCache.expiresAt=Date.now()+CACHE_MS;
    return state;
  })().finally(()=>{routeCache.promise=null});
  return routeCache.promise;
}

async function listProvidersAndModels(){
  const [providers,models]=await Promise.all([listProviders(),listModels()]);
  return {providers,models};
}

function difficulty(prompt){
  const t=String(prompt||'').trim();
  let score=0;
  if(t.length>300)score+=2;if(t.length>900)score+=2;
  if(/```|\b(code|javascript|typescript|python|sql|api|debug|bug|lỗi|fix|source|project|github|render|postgres|discord\.js)\b/i.test(t))score+=2;
  if(/\b(phân tích|so sánh|thiết kế|kiến trúc|đánh giá|suy luận|chứng minh|nghiên cứu|chiến lược|tối ưu|hệ thống)\b/i.test(t))score+=2;
  if(/[?？].*[?？]/s.test(t))score+=1;
  if(/\b(từng bước|chi tiết|toàn bộ|nhiều phần|ít nhất \d+|10 cái|nâng cấp|sửa hàng loạt)\b/i.test(t))score+=2;
  if(/\b(hello|hi|xin chào|cảm ơn|ok|oke|ping)\b/i.test(t) && t.length<80)score-=2;
  if(score<=2)return {name:'DỄ',tier:1,score};
  if(score<=5)return {name:'TRUNG BÌNH',tier:2,score};
  return {name:'KHÓ',tier:3,score};
}

function cooldownActive(p){
  return p?.cooldown_until && new Date(p.cooldown_until).getTime()>Date.now();
}

function modelCandidate(provider,model,settings){
  if(!provider?.api_key || !model?.enabled || model.hidden)return null;
  if(cooldownActive(provider))return null;
  return {
    provider:String(provider.name).toLowerCase(),model:model.name,tier:clamp(Number(model.tier||2),1,3),
    free:Boolean(model.free),contextLength:Number(model.context_length||0),latency:Number(provider.avg_latency_ms||5000),
    failCount:Number(provider.fail_count||0),defaultMatch:settings.defaultProvider===String(provider.name).toLowerCase() && settings.defaultModel===model.name
  };
}

async function discoverProviderModels(providerName){
  try{
    const remote=await listRemoteModels(providerName);
    for(const m of remote.slice(0,60)){
      await addModel({provider:providerName,name:m.name,free:m.free,description:m.description,tier:m.tier,contextLength:m.context,capabilities:m.capabilities,hidden:m.hidden}).catch(()=>{});
    }
    return remote;
  }catch{return [];}
}

async function buildCandidates(settings,{all=false,difficultyTier=2}={}){
  let {providers,models}=await loadRoute();
  const candidates=[];
  const configured=new Map(providers.map(p=>[String(p.name).toLowerCase(),p]));
  const byProvider=new Map();
  for(const m of models)if(m.enabled&&!m.hidden){const p=configured.get(String(m.provider).toLowerCase());const c=p&&modelCandidate(p,m,settings);if(c){if(!byProvider.has(c.provider))byProvider.set(c.provider,[]);byProvider.get(c.provider).push(c);}}

  const providersToUse=all?[...configured.values()]:[...configured.values()];
  // Tự phát hiện model khi provider đã có API nhưng chưa chọn model/đã lỗi model cũ.
  await Promise.all(providersToUse.filter(p=>!byProvider.has(String(p.name).toLowerCase())).map(async p=>{
    const name=String(p.name).toLowerCase();
    const remote=await discoverProviderModels(name);
    for(const m of remote){const c=modelCandidate(p,{...m,enabled:true,hidden:false},settings);if(c){if(!byProvider.has(name))byProvider.set(name,[]);byProvider.get(name).push(c);}}
  }));

  if(all){
    for(const [provider,arr] of byProvider){
      arr.sort((a,b)=>Number(a.tier)-Number(b.tier)||Number(b.free)-Number(a.free)||a.latency-b.latency);
      candidates.push(arr[0]);
    }
    return candidates;
  }

  for(const arr of byProvider.values())candidates.push(...arr);
  candidates.sort((a,b)=>routeScore(a,difficultyTier,settings)-routeScore(b,difficultyTier,settings));
  return candidates;
}

function routeScore(c,targetTier,settings){
  let s=Math.abs(c.tier-targetTier)*5;
  if(settings.freeFirst)s-=c.free?2:0;
  if(c.defaultMatch)s-=3;
  s+=Math.min(c.latency,12000)/6000;
  s+=Math.min(c.failCount,5)*2;
  if(targetTier===3 && c.tier<3)s+=2;
  if(targetTier===1 && c.tier>1)s+=1;
  return s;
}

function cleanPrompt(message){
  let text=message.content||'';
  if(client.user)text=text.replace(new RegExp(`<@!?${client.user.id}>`,'g'),' ');
  return text.trim();
}

function trimForContext(text,max=10000){return String(text||'').length>max?String(text).slice(-max):String(text||'');}

async function oneCall(candidate,prompt,{maxTokens=1000}={}){
  const started=Date.now();
  try{
    const result=await chat({
      provider:candidate.provider,model:candidate.model,
      messages:[
        {role:'system',content:'Bạn là trợ lý Discord. Trả lời bằng tiếng Việt khi người dùng viết tiếng Việt. Tự giải quyết yêu cầu; không yêu cầu người dùng cấu hình API/model nếu hệ thống đã cung cấp model. Không nói mình là bot đang chờ chỉnh kết nối trừ khi API thực sự thất bại.'},
        {role:'user',content:trimForContext(prompt)}
      ],temperature:.65,maxTokens,timeoutMs:10000
    });
    await recordProviderSuccess(candidate.provider,result.latencyMs||Date.now()-started);
    return {...result,provider:candidate.provider,model:candidate.model};
  }catch(err){
    const transient=isTransientError(err);
    const cooldown=transient ? Math.min(120000,15000*Math.max(1,Number(err?.status)===429?2:1)) : 60000;
    await recordProviderFailure(candidate.provider,`${err?.message||err}`,cooldown);
    throw err;
  }
}

function rankAnswer(a,prompt){
  const t=String(a.text||'');let score=0;
  score+=Math.min(t.length,5000)/500;
  if(t.length>80)score+=2;
  if(/```/.test(t)&&/```/.test(prompt))score+=3;
  if(/(không biết|không thể|hãy cấu hình|api key|model)/i.test(t))score-=3;
  if(/[.!?]/.test(t))score+=1;
  return score;
}

async function routedChat(prompt,settings){
  const d=difficulty(prompt);
  const targetTier=settings.autoRoute ? d.tier : 2;
  let candidates=await buildCandidates(settings,{all:false,difficultyTier:targetTier});
  if(!candidates.length){
    await loadRoute(true).catch(()=>{});
    candidates=await buildCandidates(settings,{all:false,difficultyTier:targetTier});
  }
  if(!candidates.length)throw new Error('Chưa có AI API khả dụng. Hãy cấu hình ít nhất một API trong /admin → API.');

  const failures=[];
  for(const candidate of candidates.slice(0,4)){
    try{
      const answer=await oneCall(candidate,prompt,{maxTokens:d.tier===3?1500:1100});
      return {answer,difficulty:d,candidatesTried:failures.length+1};
    }catch(err){
      failures.push(`${PROVIDERS[candidate.provider]?.label||candidate.provider}/${candidate.model}: ${err?.message||err}`);
      // Model có thể đã bị đổi/xóa quyền truy cập: refresh model catalog trước khi fallback tiếp.
      if(Number(err?.status)===400||Number(err?.status)===401||Number(err?.status)===403||Number(err?.status)===404){
        await discoverProviderModels(candidate.provider);
        await loadRoute(true).catch(()=>{});
      }
    }
  }
  throw new Error(`Các tuyến AI hiện đều lỗi. Hệ thống đã tự thử ${failures.length} tuyến. ${failures.slice(0,2).join(' | ')}`);
}

async function councilChat(prompt,settings){
  if(!settings.council)return routedChat(prompt,settings);
  const candidates=await buildCandidates(settings,{all:true,difficultyTier:3});
  if(!candidates.length)return routedChat(prompt,settings);
  const settled=await Promise.allSettled(candidates.slice(0,12).map(c=>oneCall(c,prompt,{maxTokens:850})));
  const answers=settled.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
  if(!answers.length)return routedChat(prompt,settings);
  answers.sort((a,b)=>rankAnswer(b,prompt)-rankAnswer(a,prompt));
  const best=answers[0];
  const used=answers.map(x=>PROVIDERS[x.provider]?.label||x.provider).join(', ');
  return {answer:{...best,text:`${best.text}\n\n_🧠 Hội đồng đã tham khảo: ${used} · chọn câu trả lời tốt nhất._`},difficulty:difficulty(prompt),candidatesTried:answers.length};
}

async function handleMessage(message){
  if(message.author.bot||!message.guild)return;
  if(!(await channelAllowed(message.channelId)))return;
  const mentioned=client.user ? message.mentions.users.has(client.user.id) : false;
  const repliedToBot=message.reference?.messageId ? await message.fetchReference().then(m=>m.author?.id===client.user.id).catch(()=>false) : false;
  // Trong các kênh đã khóa/cho phép: nhắn bình thường là đủ. @bot/reply bot sẽ kích hoạt Council.
  const prompt=cleanPrompt(message);
  if(!prompt){if(mentioned||repliedToBot)await message.reply({content:'👋 Hãy nhập nội dung bạn muốn mình trả lời.',allowedMentions:{repliedUser:false}});return;}

  const settings=await loadSettings();
  await message.channel.sendTyping().catch(()=>{});
  const started=Date.now();
  try{
    const result=(mentioned||repliedToBot) ? await councilChat(prompt,settings) : await routedChat(prompt,settings);
    const label=mentioned||repliedToBot?'🧠':'🤖';
    const header=`${label} ${result.difficulty.name} · ${Date.now()-started}ms`;
    const text=`${header}\n\n${result.answer.text}`.slice(0,1900);
    await message.reply({content:text,allowedMentions:{repliedUser:false}}).catch(()=>message.channel.send(text));
    console.log(`✅ Chat ${mentioned?'COUNCIL':'AUTO'} · ${message.guild.name} #${message.channel.name} · ${Date.now()-started}ms`);
  }catch(err){
    console.error('❌ AI chat error:',err?.stack||err);
    const fallback=`⚠️ Mình đã tự thử tuyến dự phòng nhưng hiện chưa có tuyến AI trả lời được.\n\n${String(err?.message||err).slice(0,900)}`;
    await message.reply({content:fallback,allowedMentions:{repliedUser:false}}).catch(()=>{});
  }
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({ok:true,botReady:client.isReady(),uptime:Math.round(process.uptime()),version:'12.5'}));return;}
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
  await loadSettings(true).catch(err=>console.error('❌ Không tải được cấu hình:',err));
  await loadRoute(true).catch(err=>console.error('❌ Không tải được routing state:',err));
  try{await registerAdmin(client);console.log('✅ /admin đã sẵn sàng');}
  catch(err){console.error('❌ Đăng ký /admin thất bại:',err);}
});

await initDb();
server.listen(PORT,'0.0.0.0',()=>console.log(`🌐 Health server listening on ${PORT}`));
try{await client.login(process.env.DISCORD_TOKEN);}catch(err){console.error('❌ Discord login failed:',err);process.exit(1);}

// Giữ tương thích với code cũ.
export { client, channelAllowed as isChannelAllowed, setSetting };
