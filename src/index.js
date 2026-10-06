import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Client, GatewayIntentBits, Partials, AttachmentBuilder } from 'discord.js';
import { config } from './config.js';
import { initDb, dbStatus, saveUser, saveChannel, saveMessage, getRecentMessages, getMemories, addMemory, getProviderStats, upsertUserProfile, getUserProfile } from './db.js';
import { classify, chooseProviders, resolveTargetProviders } from './router.js';
import { buildSystem, extractFileCandidates, providerHealthSnapshot } from './ai.js';
import { executeTask } from './pipeline/execution.js';
import { generateImage } from './image.js';
import { progressEmbed, finalEmbed } from './ui.js';
import { canUseBot, channelPermissionReport } from './permissions.js';
import { headroomStatus } from './headroom.js';
import { chooseExecutionBranch, buildTaskBranches } from './pipeline/branches.js';
import { gatherWebContext, formatWebContext } from './web.js';

if (!config.discord.token) throw new Error('Thiếu DISCORD_TOKEN.');
await initDb();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

const channelLocks = new Map();
const health = { startedAt: new Date().toISOString(), requests: 0, errors: 0, active: 0, completed: 0 };

async function getMe(guild) {
  if (!guild) return null;
  return guild.members.me || await guild.members.fetchMe().catch(() => null);
}

function queueFor(channelId, task) {
  const previous = channelLocks.get(channelId) || Promise.resolve();
  const current = previous.catch(()=>{}).then(task);
  const tracked = current.finally(() => {
    if (channelLocks.get(channelId) === tracked) channelLocks.delete(channelId);
  });
  channelLocks.set(channelId, tracked);
  return current;
}

async function statsFor(providers) {
  const out = {};
  await Promise.all(providers.map(async p => { out[p.name] = await getProviderStats(p.name).catch(()=>null); }));
  return out;
}

async function saveUserMessage(message, content) {
  await Promise.all([
    saveUser(message.author.id, message.author),
    saveChannel(message.channel),
    saveMessage(message.channel.id, message.author.id, 'user', content)
  ].map(p => p.catch(()=>{})));
}

function rememberExplicit(userId, text) {
  const m = text.match(/(?:nhớ|remember)\s+(?:rằng|that)?\s*:?[\s]+(.{5,500})$/i);
  return m?.[1]?.trim() || null;
}

function makeFileAttachments(text, analysis) {
  const candidates = extractFileCandidates(text, analysis.kinds.includes('coding') ? 'txt' : 'txt');
  return candidates.map(c => new AttachmentBuilder(Buffer.from(c.content, 'utf8'), { name:c.name }));
}

async function handleMessage(message) {
  if (message.author.bot) return;
  const content = message.content?.trim();
  if (!content && !message.attachments.size) return;
  if (!canUseBot(message)) return;
  const permission = message.guild ? channelPermissionReport(message.channel, await getMe(message.guild)) : { ok:true, missing:[] };
  if (!permission.ok) {
    console.warn(`[permissions] #${message.channel?.id}: thiếu ${permission.missing.join(', ')}`);
    return;
  }

  const text = content || '[người dùng gửi tệp/đính kèm]';
  await queueFor(message.channel.id, async () => {
    const started = Date.now();
    health.requests++;
    health.active++;
    const analysis = classify(text);
    const branches = buildTaskBranches(analysis);
    const profile = await getUserProfile(message.author.id).catch(()=>null);
    await upsertUserProfile(message.author.id, { language: message.content?.match(/[\u00C0-\u024F\u1E00-\u1EFF]/) ? 'vi' : 'auto', style: analysis.language.style, intent: analysis.kinds.join(','), preferences: { lastScore: analysis.score } }).catch(()=>{});
    const status = await message.channel.send({ embeds:[progressEmbed({botName:config.botName, analysis, stage: '🔎 Mình đang phân tích yêu cầu…'})] });

    try {
      if (analysis.mode === 'image') {
        await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage:'🎨 Image Engine đang tạo ảnh…', detail:'Không dùng token của AI chat để sinh ảnh.'})] });
        const image = await generateImage(text);
        const attach = new AttachmentBuilder(image.buffer, { name:image.filename });
        await saveMessage(message.channel.id, client.user.id, 'assistant', `[image:${image.filename}]`).catch(()=>{});
        await status.edit({ content:'', embeds:[finalEmbed({botName:config.botName, analysis, text:`✅ Xong.\n\n🖼️ Seed: ${image.seed}`, image:true, elapsedMs:Date.now()-started})], files:[attach] });
        return;
      }

      if (!config.providers.length) throw new Error('Chưa bật provider AI nào. Hãy thêm ít nhất một API key và model trong Render Environment Variables.');
      const stats = await statsFor(config.providers);
      let selected = chooseProviders(config.providers, analysis, stats);
      if (analysis.explicitAI) {
        const resolved = resolveTargetProviders(config.providers, analysis.targetAIs);
        if (resolved.unavailable.length) {
          const names = resolved.unavailable.map(x => x.alias || x.provider).join(', ');
          throw new Error(`Bạn đã chỉ đích danh AI: ${names}, nhưng AI này chưa được cấu hình API key/model trên bot.`);
        }
        selected = resolved.selected;
      }
      if (!selected.length) throw new Error('Không có provider khả dụng.');
      const memories = await getMemories(message.author.id, 8).catch(()=>[]);
      const history = await getRecentMessages(message.channel.id, config.routing.memoryMessages).catch(()=>[]);
      // Save after reading history so the current message is not duplicated in the model context.
      await saveUserMessage(message, text);
      let webContext = null;
      if (analysis.wantsWeb) {
        await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage: analysis.webMode === 'deep' ? '🌐 Đang nghiên cứu web sâu…' : '🔎 Đang tìm kiếm web…', detail:'Tìm nguồn, đọc nội dung và chuẩn bị dữ liệu cho AI.'})] });
        try { webContext = await gatherWebContext(analysis, text); }
        catch (webErr) {
          console.warn('[web]', webErr.message || webErr);
          if (analysis.difficulty === 'hard' || analysis.webMode === 'deep') throw webErr;
        }
      }
      const system = buildSystem({ botName:config.botName, analysis, memories, profile }) + (webContext ? `\n\n${formatWebContext(webContext)}` : '');
      const userMessage = webContext ? `${text}\n\n[Web context đã được thu thập ở trên. Hãy kiểm chứng và trích dẫn nguồn.]` : text;
      const messages = [
        ...history.slice(-config.routing.memoryMessages).map(m => ({ role:m.role === 'assistant' ? 'assistant' : 'user', content:m.content })),
        { role:'user', content:userMessage }
      ];
      const ctx = { system, messages, intent:analysis.kinds.join(','), difficulty:analysis.score, analysis };

      const executionBranch = chooseExecutionBranch(analysis, selected.length);
      const aiLabel = analysis.explicitAI
        ? `🎯 AI được chỉ đích danh: ${selected.map(x => x.name).join(' • ')}`
        : (analysis.difficulty === 'hard' ? '⚔️ Đang mở hội đồng Multi‑AI…' : '🧠 Đang chọn AI phù hợp…');
      const languageLabel = `${analysis.language.style}${analysis.language.speechAct === 'request' ? ' • yêu cầu' : analysis.language.speechAct === 'question' ? ' • câu hỏi' : ''}`;
      await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage:aiLabel, detail:`${selected.length} AI • nhánh: ${executionBranch} • ${branches.join(' / ')} • ngôn ngữ: ${languageLabel}${analysis.explicitAI ? ' • router bị khóa theo AI được chỉ định.' : ''}`})] });

      const result = await executeTask({
        analysis,
        selected,
        ctx,
        onEnvironment: async stage => {
          await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage, detail:'Tách riêng môi trường suy luận, kiểm thử và phản biện để giảm việc trộn vai trò.'})] });
        },
        onHardStart: async providers => {
          await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage:'🤝 Tất cả AI đang tương tác với nhau…', detail:`${providers.map(x=>x.name).join(' • ')}\nV1 → đề xuất • V2 → AI phản biện AI • V3 → AI cập nhật lẫn nhau • Judge → tổng hợp`})] });
        }
      });

      let attachments = analysis.wantsFile ? makeFileAttachments(result.text, analysis) : [];
      const fullText = result.text;
      if (analysis.wantsFile && attachments.length === 0) {
        attachments = [new AttachmentBuilder(Buffer.from(fullText, 'utf8'), { name: 'ai-answer.md' })];
      }
      const tooLong = fullText.length > 3900;
      const finalText = tooLong ? 'Mình đã hoàn thành. Vì nội dung dài, bản đầy đủ được gửi kèm file.' : fullText;
      if (attachments.length) await status.edit({ embeds:[finalEmbed({botName:config.botName, analysis, text:finalText, providers:result.participants || selected.map(x=>x.name), rounds:result.rounds||0, elapsedMs:Date.now()-started, fileCount:attachments.length})], files:attachments });
      else if (tooLong) await status.edit({ embeds:[finalEmbed({botName:config.botName, analysis, text:finalText, providers:result.participants || selected.map(x=>x.name), rounds:result.rounds||0, elapsedMs:Date.now()-started})], files:[new AttachmentBuilder(Buffer.from(fullText,'utf8'), {name:'ai-answer.md'})] });
      else await status.edit({ embeds:[finalEmbed({botName:config.botName, analysis, text:finalText, providers:result.participants || selected.map(x=>x.name), rounds:result.rounds||0, elapsedMs:Date.now()-started})] });

      await saveMessage(message.channel.id, client.user.id, 'assistant', fullText).catch(()=>{});
      health.completed++;
      const memory = rememberExplicit(message.author.id, text);
      if (memory) await addMemory(message.author.id, memory).catch(()=>{});
    } catch (err) {
      health.errors++;
      console.error(err);
      await status.edit({ embeds:[progressEmbed({botName:config.botName, analysis, stage:'⚠️ Mình không hoàn tất được yêu cầu.', detail:`Lỗi: ${String(err.message || err).slice(0,900)}`})] }).catch(()=>{});
    } finally {
      health.active = Math.max(0, health.active - 1);
    }
  });
}

client.on('messageCreate', handleMessage);
client.once('ready', c => console.log(`✅ ${c.user.tag} online • ${config.providers.map(p=>p.name).join(', ') || 'no AI provider'}`));
client.on('error', err => console.error('[discord]', err));

const port = Number(process.env.PORT || 10000);
http.createServer((req,res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ok:true, uptimeSec:Math.floor(process.uptime()), ...health, providers:config.providers.map(p=>p.name), providerHealth:providerHealthSnapshot(), db:dbStatus(), headroom:headroomStatus()}));
    return;
  }
  res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
  res.end('AI Council is online.');
}).listen(port, '0.0.0.0');

process.on('SIGTERM', async () => { await client.destroy(); process.exit(0); });
await client.login(config.discord.token);
