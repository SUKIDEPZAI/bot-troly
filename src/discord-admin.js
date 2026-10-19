import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
  PermissionsBitField
} from 'discord.js';
import { chat } from './providers.js';
import { clearModerationWarnings, getSetting, listModels, listModerationWarnings, logModerationAction } from './db.js';

const pending = new Map();
const allowUsers = () => String(process.env.ADMIN_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const allowRoles = () => String(process.env.ADMIN_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const adminOf = (member, permissionOverride=null, userIdOverride=null) => {
  const userId=userIdOverride||member?.user?.id||member?.id;
  const roles=member?.roles?.cache ? [...member.roles.cache.keys()] : Array.isArray(member?.roles) ? member.roles : [];
  const perms=permissionOverride||member?.permissions;
  let isAdmin=Boolean(perms?.has?.(PermissionsBitField.Flags.Administrator) || perms?.has?.('Administrator'));
  if(!isAdmin && typeof perms==='string'){try{isAdmin=(BigInt(perms)&PermissionsBitField.Flags.Administrator)!==0n;}catch{}}
  return isAdmin || allowUsers().includes(userId) || allowRoles().some(id=>roles.includes(id));
};
const stripAccents = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
const norm = s => stripAccents(s).replace(/[^a-z0-9@#:_\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
const ALLOWED_ACTIONS = new Set([
  'server_info','server_audit','server_rename','channel_list','role_list','member_info','channel_lock','channel_unlock','channel_rename','channel_topic','channel_slowmode','channel_create','channel_delete','message_purge',
  'role_create','role_delete','role_add','role_remove','member_warn','member_warnings','member_clear_warnings','member_timeout','member_untimeout','member_kick','member_ban','member_unban','member_nickname'
]);
const NAME_ALIASES = {
  lock:'channel_lock', unlock:'channel_unlock', ban:'member_ban', kick:'member_kick', mute:'member_timeout', timeout:'member_timeout',
  unmute:'member_untimeout', untimeout:'member_untimeout', purge:'message_purge', clear:'message_purge', slowmode:'channel_slowmode',
  create_channel:'channel_create', delete_channel:'channel_delete', rename_channel:'channel_rename', create_role:'role_create', delete_role:'role_delete',
  add_role:'role_add', remove_role:'role_remove', serverinfo:'server_info', info:'server_info', nickname:'member_nickname'
};
const TRIGGERS = [
  'khoa kenh','mo khoa kenh','lock channel','unlock channel','chan chat','mo chat','xoa tin nhan','don tin nhan','clear messages','purge messages',
  'tao kenh','tao channel','xoa kenh','xoa channel','doi ten kenh','rename channel','doi topic','mo ta kenh','slowmode','toc do chat','cham tin nhan',
  'tao role','tao vai tro','xoa role','xoa vai tro','them role','gan role','go role','bo role','add role','remove role','kick','da kick','ban thanh vien',
  'unban','cam thanh vien','timeout','mute','mo mute','go timeout','doi biet danh','nickname','doi ten server','doi ten may chu','server info','thong tin server',
  'thong ke server','xem audit log','lich su quan tri','danh sach kenh','liet ke kenh','danh sach role','liet ke role','xem canh cao','lich su canh cao','xoa canh cao','canh cao','warn user','thong tin thanh vien','member info','tao danh muc','tao category','tao voice','tao kenh thoai'
];
const ACTION_VERBS = ['khoa','mo','xoa','tao','doi','them','gan','go','bo','kick','ban','unban','timeout','mute','purge','clear','lock','unlock','rename','slowmode'];
const OBJECT_WORDS = ['kenh','channel','tin','tin nhan','message','server','may chu','role','vai tro','thanh vien','member','user','biet danh','nickname','topic','slowmode','voice','category','danh muc','thoai','canh cao','warning','audit','lich su'];

function levenshtein(a,b){
  if(a===b)return 0;if(Math.abs(a.length-b.length)>2)return 3;
  const dp=Array.from({length:a.length+1},(_,i)=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)dp[i][0]=i;for(let j=0;j<=b.length;j++)dp[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return dp[a.length][b.length];
}
function looksLikeAdminRequest(content){
  const t=norm(content);
  if(TRIGGERS.some(x=>x.includes(' ')&&t.includes(x)))return true;
  const words=t.split(' ');
  const hasVerb=words.some(w=>ACTION_VERBS.some(v=>w===v || (w.length>=4 && levenshtein(w,v)<=1)));
  const hasObject=OBJECT_WORDS.some(o=>t.includes(o)) || /<@!?\d+>|<@&\d+>|<#\d+>|\b\d{17,20}\b/.test(content);
  const standaloneAction=words.some(w=>['kick','ban','unban','timeout','mute','purge','slowmode','warn'].includes(w));
  return (hasVerb && hasObject) || (standaloneAction && hasObject);
}
function parseJson(text){
  let s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a<0||b<=a)return null;
  try{return JSON.parse(s.slice(a,b+1));}catch{return null;}
}
function localIntent(message){
  const raw=message.content||'';const t=norm(raw);
  const number=(raw.match(/\b(\d{1,3})\b/)||[])[1];
  const durationMatch=t.match(/\b(\d{1,3})\s*(s|sec|second|seconds|giay|phut|p|m|min|minute|minutes|h|gio|hour|hours|d|ngay|day|days)\b/i);
  let durationMs=10*60*1000;
  if(durationMatch){const n=Number(durationMatch[1]);const u=stripAccents(durationMatch[2]);durationMs=n*(/^(s|sec|second|seconds|giay)$/.test(u)?1000:/^(h|gio|hour|hours)$/.test(u)?3600000:/^(d|ngay|day|days)$/.test(u)?86400000:60000);}
  const nameAfter=(regex,def='')=>{const plain=stripAccents(raw);const m=plain.match(regex);if(!m)return def;const capture=String(m[1]||def);const offset=m.index+String(m[0]).lastIndexOf(capture);const original=raw.slice(offset,offset+capture.length);return original.replace(/["'`]/g,'').trim().slice(0,90);};
  const finalValue=value=>{const s=String(value||'').trim();const plain=stripAccents(s);const m=plain.match(/\b(?:thanh|to|as)\s+(.+)$/i);if(!m)return s;const offset=m.index+m[0].lastIndexOf(m[1]);return s.slice(offset,offset+m[1].length).trim();};
  const roleTail=value=>String(value||'').replace(/\s+(?:cho|khỏi|khoi|to|for|from)\s+.*$/i,'').trim();
  let action=null, args={};
  if(/(thong tin server|server info|thong ke server|may chu co gi|gioi thieu server)/.test(t))action='server_info';
  else if(/(audit log|lich su quan tri|log quan tri|nhat ky server)/.test(t)){action='server_audit';args.count=Math.max(1,Math.min(25,Number(number)||10));}
  else if(/(danh sach kenh|liet ke kenh|list channels)/.test(t))action='channel_list';
  else if(/(danh sach role|liet ke role|list roles)/.test(t))action='role_list';
  else if(/(thong tin thanh vien|member info|xem thanh vien)/.test(t))action='member_info';
  else if(/(doi ten server|doi ten may chu|rename server|dat ten server)/.test(t)){action='server_rename';args.name=finalValue(nameAfter(/(?:doi ten server|doi ten may chu|rename server|dat ten server)\s+(?:thanh\s+)?(.+)/i));}
  else if(/(mo khoa kenh|unlock channel|mo chat|mo khoa chat)/.test(t)){action='channel_unlock';args.channelName=nameAfter(/(?:mo khoa kenh|unlock channel)\s+(.+)/i);}
  else if(/(khoa kenh|lock channel|chan chat|cam nhan tin|tat chat kenh)/.test(t)){action='channel_lock';args.channelName=nameAfter(/(?:khoa kenh|lock channel)\s+(.+)/i);}
  else if(/(xoa|don|clear|purge).{0,35}(tin nhan|messages|message|tin chat)/.test(t)){action='message_purge';args.count=Math.max(1,Math.min(100,Number(number)||10));}
  else if(/(slowmode|toc do chat|han che toc do|cham tin nhan)/.test(t)){action='channel_slowmode';args.seconds=/(tat slowmode|bo slowmode|xoa slowmode|disable slowmode)/.test(t)?0:Math.max(0,Math.min(21600,Number(number)||5));}
  else if(/(doi ten kenh|rename channel|dat ten kenh)/.test(t)){action='channel_rename';args.name=finalValue(nameAfter(/(?:doi ten kenh|rename channel|dat ten kenh)\s+(.+)/i));}
  else if(/(topic kenh|mo ta kenh|chu de kenh|channel topic)/.test(t)){action='channel_topic';args.value=nameAfter(/(?:topic kenh|mo ta kenh|chu de kenh|channel topic)\s+(?:thanh\s+)?(.+)/i);}
  else if(/(xoa kenh|xoa channel|delete channel|delete this channel)/.test(t)){action='channel_delete';args.channelName=nameAfter(/(?:xoa kenh|xoa channel|delete channel)\s+(.+)/i);}
  else if(/(tao kenh|tao channel|create channel|tao kenh text|tao kenh thoai|tao voice|tao category|tao danh muc)/.test(t)){
    action='channel_create';args.name=nameAfter(/(?:tao kenh(?: text| thoai)?|tao channel|create channel|tao voice|tao category|tao danh muc)\s+(.+)/i,'new-channel');
    args.channel_type=/(voice|thoai)/.test(t)?'voice':/(category|danh muc)/.test(t)?'category':'text';
  }
  else if(/(tao role|tao vai tro|create role|them role moi)/.test(t)){action='role_create';args.name=nameAfter(/(?:tao role|tao vai tro|create role|them role moi)\s+(.+)/i,'New Role');}
  else if(/(xoa role|xoa vai tro|delete role)/.test(t)){action='role_delete';args.roleName=roleTail(nameAfter(/(?:xoa role|xoa vai tro|delete role)\s+(.+)/i));}
  else if(/(go role|bo role|remove role|thu hoi role)/.test(t)){action='role_remove';args.roleName=roleTail(nameAfter(/(?:go role|bo role|remove role|thu hoi role)\s+(.+)/i));}
  else if(/(them role|gan role|add role|cap role)/.test(t)){action='role_add';args.roleName=roleTail(nameAfter(/(?:them role|gan role|add role|cap role)\s+(.+)/i));}
  else if(/(xem canh cao|lich su canh cao|xem warnings|warning history)/.test(t)){action='member_warnings';}
  else if(/(xoa canh cao|clear warnings|xoa warnings)/.test(t)){action='member_clear_warnings';}
  else if(/(canh cao|nhac nho thanh vien|warn user|warn thanh vien|\bwarn\b)/.test(t)){action='member_warn';args.reason=nameAfter(/(?:canh cao|nhac nho|warn)\s+(?:<@!?\d+>\s*)?(.+)/i);}
  else if(/(go timeout|untimeout|bo mute|unmute|tha timeout)/.test(t)){action='member_untimeout';}
  else if(/(timeout|mute|tam khoa chat|cam chat tam thoi)/.test(t)){action='member_timeout';args.durationMs=durationMs;}
  else if(/(kick|duoi thanh vien|kick thanh vien)/.test(t)){action='member_kick';}
  else if(/(?:ban thanh vien|cam thanh vien|ban user|\bban\s+<@!?\d+>|\bban\s+\d{17,20})/i.test(raw)){action='member_ban';}
  else if(/(unban|go cam)/.test(t)){action='member_unban';args.userId=(raw.match(/\b\d{17,20}\b/)||[])[0]||'';}
  else if(/(doi biet danh|nickname|dat nick)/.test(t)){action='member_nickname';args.name=finalValue(nameAfter(/(?:doi biet danh|nickname|dat nick)\s+(.+)/i));}
  return action?{action,...args}:null;
}

async function aiIntent(message){
  const raw=String(message.content||'').slice(0,1800);
  try{
    const configured=(await listModels('motapis')).filter(m=>m.enabled&&!m.hidden);
    const saved=await getSetting('default_model');
    const model=configured.find(m=>m.name===saved)?.name||configured[0]?.name||'deepseek-v4-flash';
    const mentions={
      users:message.mentions.users.map(u=>({id:u.id,name:u.username,displayName:message.guild.members.cache.get(u.id)?.displayName||u.username})),
      roles:message.mentions.roles.map(r=>({id:r.id,name:r.name})),
      channels:message.mentions.channels.map(c=>({id:c.id,name:c.name}))
    };
    const result=await chat({provider:'motapis',model,temperature:0,maxTokens:350,timeoutMs:5000,messages:[
      {role:'system',content:`Bạn là bộ phân loại Ý ĐỊNH QUẢN TRỊ Discord. Đọc tiếng Việt không dấu, viết tắt, lỗi chính tả và tiếng Anh lẫn nhau. Chỉ trả về đúng MỘT JSON object, không Markdown, không giải thích. Chỉ chọn một action trong: ${[...ALLOWED_ACTIONS].join(', ')} hoặc "unknown". Schema: {"action":"...","name":"","value":"","target":"","roleName":"","channelName":"","channel_type":"text|voice|category","count":10,"seconds":0,"durationMs":600000,"reason":"","userId":""}. Không tạo ID giả. Nếu không đủ thông tin cho hành động thì để chuỗi trống. Đây là phân loại, không thực thi lệnh.`},
      {role:'user',content:`Server=${message.guild.name}; currentChannel=${message.channel.name}; mentions=${JSON.stringify(mentions)}; message=${JSON.stringify(raw)}`}
    ]});
    const obj=parseJson(result.text);if(!obj||!ALLOWED_ACTIONS.has(String(obj.action)))return null;
    return { ...obj, action:NAME_ALIASES[obj.action]||obj.action };
  }catch(err){console.warn('⚠️ Admin intent AI unavailable; use local parser:',err?.message||err);return null;}
}

async function botMember(guild){return guild.members.me||await guild.members.fetchMe();}
async function requireBotPermission(guild,flag,label){const me=await botMember(guild);if(!me.permissions.has(flag))throw new Error(`Bot thiếu quyền **${label}**. Mở Server Settings → Roles và cấp quyền cho role của bot.`);return me;}
function sayFor(action){
  const map={server_info:'xem thông tin server',server_rename:'đổi tên server',channel_lock:'khóa gửi tin ở kênh',channel_unlock:'mở khóa kênh',channel_rename:'đổi tên kênh',channel_topic:'đổi mô tả/topic kênh',channel_slowmode:'đặt slowmode',channel_create:'tạo kênh mới',channel_delete:'xóa kênh',message_purge:'xóa tin nhắn',role_create:'tạo role',role_delete:'xóa role',role_add:'gán role cho thành viên',role_remove:'gỡ role khỏi thành viên',member_timeout:'timeout thành viên',member_untimeout:'gỡ timeout',member_kick:'kick thành viên',member_ban:'ban thành viên',member_unban:'gỡ ban',member_nickname:'đổi biệt danh thành viên'};
  return map[action]||action;
}
async function resolveIntent(message,intent){
  const guild=message.guild;const a={...intent};
  const suppliedReason=String(a.reason||'').trim();
  a.reason=String(suppliedReason||'Yêu cầu từ quản trị viên').slice(0,400);
  const mentionedChannel=message.mentions.channels.first();
  const channelName=a.channelName||(['channel_delete','channel_rename','channel_lock','channel_unlock','channel_slowmode','channel_topic'].includes(a.action)?a.target:'');
  const targetChannel=mentionedChannel||guild.channels.cache.find(c=>channelName&&norm(c.name)===norm(channelName))||message.channel;
  a.channelId=targetChannel?.id;
  const mentionedMember=message.mentions.members.first();
  if(['member_info','member_warn','member_warnings','member_clear_warnings','member_timeout','member_untimeout','member_kick','member_ban','role_add','role_remove','member_nickname'].includes(a.action)){
    let member=mentionedMember;
    if(!member&&a.target){member=guild.members.cache.find(m=>norm(m.user.username)===norm(a.target)||norm(m.displayName)===norm(a.target))||null;}
    if(!member&&a.target){try{const found=await guild.members.fetch({query:String(a.target).slice(0,32),limit:5});member=found.find(m=>norm(m.user.username)===norm(a.target)||norm(m.displayName)===norm(a.target))||null;}catch{}}
    if(!member)throw new Error('Không xác định được thành viên. Hãy @mention chính xác người cần quản lý để tránh nhắm nhầm người.');
    a.memberId=member.id;
  }
  if(['role_add','role_remove','role_delete'].includes(a.action)){
    const mentionedRole=message.mentions.roles.first();
    const roleName=a.roleName||a.name||'';
    const role=mentionedRole||guild.roles.cache.find(r=>roleName&&norm(r.name)===norm(roleName));
    if(!role)throw new Error('Không tìm thấy role. Hãy @mention role hoặc ghi đúng tên role.');
    a.roleId=role.id;a.roleName=role.name;
  }
  if(['channel_delete'].includes(a.action))a.channelId=targetChannel.id;
  if(a.action==='member_warn'){
    const raw=(message.content||'').replace(/<@!?\d+>/g,' ').replace(/\b(canh cao|nhac nho thanh vien|nhac nho|warn user|warn thanh vien|warn)\b/ig,' ').trim();
    a.reason=String(suppliedReason||raw||'Vi phạm quy tắc server').slice(0,500);
  }
  if(a.action==='member_unban'){
    a.userId=String(a.userId||'').match(/^\d{17,20}$/)?.[0]||String(message.content.match(/\b\d{17,20}\b/)||[])[0]||'';
    if(!a.userId)throw new Error('Để unban, hãy cung cấp Discord user ID dạng số (17–20 chữ số).');
  }
  if(a.action==='message_purge')a.count=Math.max(1,Math.min(100,Number(a.count)||Number((message.content.match(/\b\d{1,3}\b/)||[])[1])||10));
  if(a.action==='channel_slowmode'){const n=Number(a.seconds);const match=Number((message.content.match(/\b\d{1,5}\b/)||[])[1]);a.seconds=/(tat slowmode|bo slowmode|xoa slowmode|disable slowmode)/i.test(norm(message.content))?0:Math.max(0,Math.min(21600,Number.isFinite(n)&&n>0?n:(match>0?match:5)));}
  if(a.action==='member_timeout')a.durationMs=Math.max(5000,Math.min(28*24*60*60*1000,Number(a.durationMs)||10*60*1000));
  if(['channel_create','role_create','channel_rename','channel_topic','server_rename','member_nickname'].includes(a.action)){
    a.name=String(a.name||a.value||'').trim().slice(0,100);
    if(['channel_create','role_create','channel_rename','server_rename'].includes(a.action)&&!a.name)throw new Error(`Bạn muốn ${sayFor(a.action)} nhưng chưa ghi tên mới.`);
    if(a.action==='channel_topic'&&!a.name)throw new Error('Hãy ghi nội dung topic/mô tả kênh.');
    if(a.action==='member_nickname'&&!a.name)throw new Error('Hãy ghi biệt danh mới. Đặt “clear” để xóa biệt danh.');
  }
  return a;
}
function needsConfirmation(a){return ['channel_delete','message_purge','role_delete','member_clear_warnings','member_kick','member_ban','server_rename'].includes(a.action);}
function summary(a,message){
  const channel=message.guild.channels.cache.get(a.channelId);
  const member=a.memberId?message.guild.members.cache.get(a.memberId):null;
  const role=a.roleId?message.guild.roles.cache.get(a.roleId):null;
  const lines={
    server_info:'Xem thông tin máy chủ',server_audit:`Xem ${a.count||10} mục audit log gần nhất`,channel_list:'Liệt kê kênh trong server',role_list:'Liệt kê role trong server',member_info:`Xem thông tin ${member?.user.username||a.memberId}`,member_warn:`Ghi cảnh cáo cho ${member?.user.username||a.memberId}: ${a.reason}`,member_warnings:`Xem cảnh cáo của ${member?.user.username||a.memberId}`,member_clear_warnings:`XÓA toàn bộ cảnh cáo của ${member?.user.username||a.memberId}`,server_rename:`Đổi tên server thành “${a.name}”`,channel_lock:`Khóa gửi tin trong #${channel?.name||'kênh hiện tại'}`,channel_unlock:`Mở khóa gửi tin trong #${channel?.name||'kênh hiện tại'}`,
    channel_rename:`Đổi tên #${channel?.name||'kênh'} thành “${a.name}”`,channel_topic:`Đặt topic cho #${channel?.name||'kênh'} thành “${a.name}”`,channel_slowmode:`Đặt slowmode #${channel?.name||'kênh'} = ${a.seconds} giây`,
    channel_create:`Tạo ${a.channel_type==='voice'?'kênh thoại':a.channel_type==='category'?'danh mục':'kênh văn bản'} “${a.name}”`,channel_delete:`XÓA kênh #${channel?.name||'kênh'}`,message_purge:`XÓA tối đa ${a.count} tin nhắn ở #${channel?.name||'kênh'}`,
    role_create:`Tạo role “${a.name}”`,role_delete:`XÓA role “${role?.name||a.roleName}”`,role_add:`Gán role “${role?.name}” cho ${member?.user.username||a.memberId}`,role_remove:`Gỡ role “${role?.name}” khỏi ${member?.user.username||a.memberId}`,
    member_timeout:`Timeout ${member?.user.username||a.memberId} trong ${Math.round(a.durationMs/60000)} phút`,member_untimeout:`Gỡ timeout ${member?.user.username||a.memberId}`,member_kick:`KICK ${member?.user.username||a.memberId}`,member_ban:`BAN ${member?.user.username||a.memberId}`,member_unban:`Gỡ ban user ID ${a.userId}`,member_nickname:`Đổi biệt danh ${member?.user.username||a.memberId} thành “${a.name}”`
  };
  return lines[a.action]||sayFor(a.action);
}
async function executeAction(guild,a){
  const getChannel=()=>guild.channels.cache.get(a.channelId);
  const getMember=()=>guild.members.cache.get(a.memberId);
  if(a.action==='server_info'){
    const owner=await guild.fetchOwner().catch(()=>null);
    return `**${guild.name}**\nID: \`${guild.id}\`\nChủ server: ${owner?.user?.tag||'không rõ'}\nThành viên: ${guild.memberCount}\nKênh: ${guild.channels.cache.size}\nRole: ${guild.roles.cache.size}\nTạo ngày: <t:${Math.floor(guild.createdTimestamp/1000)}:D>`;
  }
  if(a.action==='channel_list')return [...guild.channels.cache.values()].slice(0,40).map(c=>`${c.type===ChannelType.GuildCategory?'📁':c.type===ChannelType.GuildVoice?'🔊':'#'} ${c.name} (\`${c.id}\`)`).join('\n').slice(0,1800)||'Server chưa có kênh trong cache.';
  if(a.action==='role_list')return [...guild.roles.cache.values()].sort((x,y)=>y.position-x.position).slice(0,40).map(r=>`${r.id===guild.id?'👑':'🎭'} ${r.name} · ${r.position} · \`${r.id}\``).join('\n').slice(0,1800)||'Server chưa có role trong cache.';
  if(a.action==='server_audit'){
    await requireBotPermission(guild,PermissionsBitField.Flags.ViewAuditLog,'View Audit Log');
    const logs=await guild.fetchAuditLogs({limit:Math.max(1,Math.min(25,Number(a.count)||10))});
    return [...logs.entries.values()].map(x=>`• ${String(x.action)} · ${x.executorId?`<@${x.executorId}>`:'người thực hiện không rõ'} · ${x.target?.id?`ID \`${x.target.id}\``:'không rõ mục tiêu'} · <t:${Math.floor(x.createdTimestamp/1000)}:R>\n  ${String(x.reason||'Không có lý do').slice(0,100)}`).join('\n').slice(0,1800)||'Chưa có audit log khả dụng.';
  }
  if(a.action==='member_info'){const m=getMember();if(!m)throw new Error('Không tìm thấy thành viên.');return `**${m.user.tag}**\nID: \`${m.id}\`\nNickname: ${m.displayName}\nNgày tạo: <t:${Math.floor(m.user.createdTimestamp/1000)}:D>\nTham gia server: ${m.joinedTimestamp?`<t:${Math.floor(m.joinedTimestamp/1000)}:D>`:'không rõ'}\nRole: ${m.roles.cache.filter(r=>r.id!==guild.id).map(r=>r.name).slice(0,15).join(', ')||'Không có'}\nTimeout: ${m.communicationDisabledUntilTimestamp?`đến <t:${Math.floor(m.communicationDisabledUntilTimestamp/1000)}:R>`:'Không'} `;}
  if(a.action==='member_warn'){
    await requireBotPermission(guild,PermissionsBitField.Flags.ManageMessages,'Manage Messages');
    await logModerationAction({guildId:guild.id,userId:a.memberId,moderatorId:a.moderatorId||'unknown',action:'warn',reason:a.reason,metadata:{username:getMember()?.user?.tag||''}});
    return `⚠️ Đã ghi cảnh cáo cho <@${a.memberId}>. Lý do: ${a.reason}`;
  }
  if(a.action==='member_warnings'){const records=await listModerationWarnings(guild.id,a.memberId,10);return records.length?`📋 **${records.length} cảnh cáo gần nhất** cho <@${a.memberId}>\n`+records.map((w,i)=>`${i+1}. <t:${Math.floor(new Date(w.created_at).getTime()/1000)}:D> — ${w.reason} · bởi <@${w.moderator_id}>`).join('\n').slice(0,1700):`✅ <@${a.memberId}> không có cảnh cáo đang lưu.`;}
  if(a.action==='member_clear_warnings'){const n=await clearModerationWarnings(guild.id,a.memberId);return `✅ Đã xóa ${n} cảnh cáo của <@${a.memberId}>.`;}
  if(a.action==='server_rename'){await requireBotPermission(guild,PermissionsBitField.Flags.ManageGuild,'Manage Server');await guild.setName(a.name,a.reason);return `✅ Đã đổi tên server thành **${a.name}**.`;}
  if(['channel_lock','channel_unlock','channel_rename','channel_topic','channel_slowmode','channel_create','channel_delete','message_purge'].includes(a.action)){
    await requireBotPermission(guild,a.action==='message_purge'?PermissionsBitField.Flags.ManageMessages:PermissionsBitField.Flags.ManageChannels,a.action==='message_purge'?'Manage Messages':'Manage Channels');
  }
  if(a.action==='channel_lock'||a.action==='channel_unlock'){
    const c=getChannel();if(!c?.permissionOverwrites)throw new Error('Kênh không hỗ trợ chỉnh quyền gửi tin.');
    if(a.action==='channel_lock')await c.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:false}, a.reason);
    else await c.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:null}, a.reason);
    return `✅ Đã ${a.action==='channel_lock'?'khóa':'mở khóa'} gửi tin trong <#${c.id}>.`;
  }
  if(a.action==='channel_rename'){const c=getChannel();if(!c)throw new Error('Kênh không còn tồn tại.');await c.setName(a.name,a.reason);return `✅ Đã đổi tên kênh thành **${a.name}**.`;}
  if(a.action==='channel_topic'){const c=getChannel();if(!c?.setTopic)throw new Error('Loại kênh này không hỗ trợ topic.');await c.setTopic(a.name,a.reason);return '✅ Đã cập nhật topic kênh.';}
  if(a.action==='channel_slowmode'){const c=getChannel();if(!c?.setRateLimitPerUser)throw new Error('Kênh không hỗ trợ slowmode.');await c.setRateLimitPerUser(a.seconds,a.reason);return `✅ Slowmode kênh đã đặt thành ${a.seconds} giây.`;}
  if(a.action==='channel_create'){
    const type=a.channel_type==='voice'?ChannelType.GuildVoice:a.channel_type==='category'?ChannelType.GuildCategory:ChannelType.GuildText;
    const c=await guild.channels.create({name:a.name,type,reason:a.reason});return `✅ Đã tạo ${type===ChannelType.GuildVoice?'kênh thoại':type===ChannelType.GuildCategory?'danh mục':'kênh văn bản'} <#${c.id}>.`;
  }
  if(a.action==='channel_delete'){const c=getChannel();if(!c)throw new Error('Kênh không còn tồn tại.');await c.delete(a.reason);return `✅ Đã xóa kênh #${c.name}.`;}
  if(a.action==='message_purge'){
    const c=getChannel();if(!c?.bulkDelete)throw new Error('Chỉ có thể dọn tin nhắn trong kênh văn bản hỗ trợ.');const deleted=await c.bulkDelete(a.count,true);return `✅ Đã xóa ${deleted.size} tin nhắn gần đây (Discord tự bỏ qua tin cũ hơn 14 ngày).`;
  }
  if(['role_create','role_delete','role_add','role_remove'].includes(a.action)){
    const me=await requireBotPermission(guild,PermissionsBitField.Flags.ManageRoles,'Manage Roles');
    if(a.action==='role_create'){const r=await guild.roles.create({name:a.name,reason:a.reason});return `✅ Đã tạo role **${r.name}**.`;}
    const role=guild.roles.cache.get(a.roleId);if(!role)throw new Error('Role không còn tồn tại.');
    if(role.managed||role.position>=me.roles.highest.position)throw new Error('Bot không đủ thứ bậc role để quản lý role này. Hãy kéo role bot lên cao hơn role mục tiêu.');
    if(a.action==='role_delete'){await role.delete(a.reason);return `✅ Đã xóa role **${a.roleName}**.`;}
    const member=getMember();if(!member)throw new Error('Thành viên không còn trong server.');
    if(member.id===guild.ownerId||member.roles.highest.position>=me.roles.highest.position)throw new Error('Bot không thể sửa role của chủ server hoặc thành viên có role ngang/cao hơn bot.');
    if(a.action==='role_add')await member.roles.add(role,a.reason);else await member.roles.remove(role,a.reason);
    return `✅ Đã ${a.action==='role_add'?'gán':'gỡ'} role **${role.name}** ${a.action==='role_add'?'cho':'khỏi'} <@${member.id}>.`;
  }
  if(['member_timeout','member_untimeout','member_kick','member_ban','member_unban','member_nickname'].includes(a.action)){
    const flag=a.action==='member_kick'?PermissionsBitField.Flags.KickMembers:a.action==='member_ban'||a.action==='member_unban'?PermissionsBitField.Flags.BanMembers:a.action==='member_nickname'?PermissionsBitField.Flags.ManageNicknames:PermissionsBitField.Flags.ModerateMembers;
    const label=a.action==='member_kick'?'Kick Members':a.action==='member_ban'||a.action==='member_unban'?'Ban Members':a.action==='member_nickname'?'Manage Nicknames':'Moderate Members';
    const me=await requireBotPermission(guild,flag,label);
    if(a.action==='member_unban'){await guild.members.unban(a.userId,a.reason);return `✅ Đã gỡ ban user ID \`${a.userId}\`.`;}
    const member=getMember();if(!member)throw new Error('Thành viên không còn trong server.');
    if(member.id===guild.ownerId||member.roles.highest.position>=me.roles.highest.position)throw new Error('Bot không thể quản lý chủ server hoặc thành viên có role ngang/cao hơn bot. Hãy chỉnh role hierarchy.');
    if(a.action==='member_timeout'){await member.timeout(a.durationMs,a.reason);await logModerationAction({guildId:guild.id,userId:member.id,moderatorId:a.moderatorId||'unknown',action:'timeout',reason:a.reason,metadata:{durationMs:a.durationMs}}).catch(()=>{});return `✅ Đã timeout <@${member.id}> trong ${Math.round(a.durationMs/60000)} phút.`;}
    if(a.action==='member_untimeout'){await member.timeout(null,a.reason);return `✅ Đã gỡ timeout <@${member.id}>.`;}
    if(a.action==='member_kick'){await member.kick(a.reason);await logModerationAction({guildId:guild.id,userId:member.id,moderatorId:a.moderatorId||'unknown',action:'kick',reason:a.reason}).catch(()=>{});return `✅ Đã kick thành viên <@${member.id}>.`;}
    if(a.action==='member_ban'){await guild.members.ban(member.id,{reason:a.reason});await logModerationAction({guildId:guild.id,userId:member.id,moderatorId:a.moderatorId||'unknown',action:'ban',reason:a.reason}).catch(()=>{});return `✅ Đã ban thành viên <@${member.id}>.`;}
    if(a.action==='member_nickname'){await member.setNickname(a.name.toLowerCase()==='clear'?null:a.name,a.reason);return `✅ Đã cập nhật biệt danh của <@${member.id}>.`;}
  }
  throw new Error('Hành động chưa được hỗ trợ. Hãy mô tả lại cụ thể hơn.');
}
function actionButtons(id){return new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`cadm_confirm:${id}`).setLabel('✅ Xác nhận thực hiện').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`cadm_cancel:${id}`).setLabel('Hủy').setStyle(ButtonStyle.Secondary)
);}

export async function handleNaturalAdminMessage(message){
  if(!message.guild||message.author.bot||!looksLikeAdminRequest(message.content))return false;
  const requestText=norm(message.content);
  if(/^(lam sao|cach|huong dan|chi minh|chi toi|how to|how do i|what is|giai thich)\b/.test(requestText))return false;
  if(/\b(dung|khong|ko|dont|do not|please dont)\s+(khoa|xoa|ban|kick|timeout|mute|tao|them|gan|doi|purge|clear|rename|lock|unlock)\b/.test(requestText))return false;
  if(!adminOf(message.member,null,message.author.id)){
    await message.reply({content:'⛔ Chức năng quản trị chỉ dành cho admin hoặc ID/role đã được cho phép trong Render (`ADMIN_USER_IDS`, `ADMIN_ROLE_IDS`).',allowedMentions:{repliedUser:false}}).catch(()=>{});
    return true;
  }
  await message.channel.sendTyping().catch(()=>{});
  let intent=await aiIntent(message);
  if(!intent||!ALLOWED_ACTIONS.has(NAME_ALIASES[intent.action]||intent.action))intent=localIntent(message);
  if(!intent){await message.reply({content:'🤔 Mình nhận ra bạn đang yêu cầu quản trị server nhưng chưa xác định đủ rõ hành động. Ví dụ: “khóa kênh này”, “tạo role VIP”, “timeout @user 10 phút”, “xóa 5 tin nhắn gần nhất”.',allowedMentions:{repliedUser:false}});return true;}
  intent.action=NAME_ALIASES[intent.action]||intent.action;
  try{
    const action=await resolveIntent(message,intent);
    action.moderatorId=message.author.id;
    const brief=summary(action,message);
    if(needsConfirmation(action)){
      const id=Math.random().toString(36).slice(2,10);
      pending.set(id,{userId:message.author.id,guildId:message.guild.id,channelId:message.channel.id,action,brief,createdAt:Date.now()});
      while(pending.size>200)pending.delete(pending.keys().next().value);
      await message.reply({content:`⚠️ **Cần xác nhận hành động quản trị**\n${brief}\n\nChỉ bạn mới có thể xác nhận. Yêu cầu hết hạn sau 2 phút.`,components:[actionButtons(id)],allowedMentions:{repliedUser:false}});
    }else{
      const result=await executeAction(message.guild,action);
      await message.reply({content:result,allowedMentions:{repliedUser:false}});
    }
  }catch(err){
    await message.reply({content:`❌ Không thực hiện được: ${String(err?.message||err).slice(0,1300)}`,allowedMentions:{repliedUser:false}}).catch(()=>{});
  }
  return true;
}

export function registerDiscordAdminInteractions(client){
  client.on('interactionCreate',async i=>{
    if(!i.isButton()||!/^cadm_(confirm|cancel):/.test(i.customId))return;
    const [,mode,id]=i.customId.split(':');const item=pending.get(id);
    if(!item)return i.reply({content:'Yêu cầu xác nhận đã hết hạn hoặc không còn tồn tại.',ephemeral:true}).catch(()=>{});
    if(i.user.id!==item.userId)return i.reply({content:'⛔ Chỉ admin đã tạo yêu cầu này mới được xác nhận.',ephemeral:true}).catch(()=>{});
    if(Date.now()-item.createdAt>120000){pending.delete(id);return i.update({content:'Yêu cầu đã hết hạn. Hãy gửi lại yêu cầu bằng tin nhắn mới.',components:[]}).catch(()=>{});}
    if(!adminOf(i.member,i.memberPermissions,i.user.id))return i.reply({content:'⛔ Bạn hiện không có quyền admin.',ephemeral:true}).catch(()=>{});
    if(mode==='cancel'){pending.delete(id);return i.update({content:'Đã hủy hành động quản trị.',components:[]}).catch(()=>{});}
    await i.deferUpdate();pending.delete(id);
    try{
      if(!i.guild||i.guild.id!==item.guildId)throw new Error('Sai máy chủ của yêu cầu.');
      const result=await executeAction(i.guild,item.action);
      await i.editReply({content:`${result}\n\n✅ Đã xác nhận bởi <@${i.user.id}>.`,components:[],embeds:[]});
    }catch(err){await i.editReply({content:`❌ Không thực hiện được: ${String(err?.message||err).slice(0,1300)}`,components:[],embeds:[]}).catch(()=>{});}
  });
}
