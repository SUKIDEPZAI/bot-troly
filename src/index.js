import 'dotenv/config';
import http from 'node:http';
import { Client, GatewayIntentBits } from 'discord.js';
import { initDb } from './db.js';
import { registerAdmin, isChannelAllowed } from './admin.js';

const PORT = Number(process.env.PORT || 10000);

if (!process.env.DISCORD_TOKEN) throw new Error('Thiếu DISCORD_TOKEN');
if (!process.env.DATABASE_URL) throw new Error('Thiếu DATABASE_URL');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, botReady: client.isReady() }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);

  try {
    client.aiChannelAllowed = isChannelAllowed;
    await registerAdmin(client);
    console.log('✅ Đã đăng ký /admin');
    console.log('🔒 Bộ kiểm soát kênh AI đã sẵn sàng');
  } catch (error) {
    console.error('❌ Không thể đăng ký /admin:', error);
  }
});

try {
  await initDb();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Health server listening on ${PORT}`);
  });
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  console.error('❌ Startup failed:', error);
  server.close();
  process.exit(1);
}
