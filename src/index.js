import 'dotenv/config';
import http from 'node:http';
import { Client, GatewayIntentBits } from 'discord.js';
import { initDb } from './db.js';
import { registerAdmin, isChannelAllowed } from './admin.js';

const PORT=Number(process.env.PORT||10000);
if(!process.env.DISCORD_TOKEN)throw new Error('Thiếu DISCORD_TOKEN');
if(!process.env.DATABASE_URL)throw new Error('Thiếu DATABASE_URL');
if(!process.env.AI_SECRET_KEY)throw new Error('Thiếu AI_SECRET_KEY');

const client=new Client({intents:[GatewayIntentBits.Guilds]});
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){let db='unknown';try{await import('./db.js').then(m=>m.pool.query('SELECT 1'));db='ok';}catch{db='error';}res.writeHead(db==='ok'?200:503,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:db==='ok'&&client.isReady(),database:db,botReady:client.isReady()}));return;}
  res.writeHead(404,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'Not found'}));
});

client.once('ready',async()=>{console.log(`✅ Bot online: ${client.user.tag}`);try{await registerAdmin(client);console.log('✅ /admin đã sẵn sàng');}catch(err){console.error('❌ Đăng ký /admin thất bại:',err);}});
await initDb();
server.listen(PORT,'0.0.0.0',()=>console.log(`🌐 Health server listening on ${PORT}`));
try{await client.login(process.env.DISCORD_TOKEN);}catch(err){console.error('❌ Discord login failed:',err);process.exit(1);}

// Hook sẵn cho luồng chat AI sau này: gọi isChannelAllowed(message.channelId) trước khi phản hồi.
export { client, isChannelAllowed };
