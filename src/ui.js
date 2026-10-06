import { EmbedBuilder } from 'discord.js';

const palettes = {
  chat: 0x5865F2, coding: 0x57F287, research: 0xFEE75C, image: 0xEB459E, file: 0xFAA61A,
  math: 0x00B0F4, explain: 0x9B59B6
};
const icons = { chat:'💬', coding:'💻', research:'🌐', image:'🎨', file:'📦', math:'🧮', explain:'📚' };

export function analysisLabel(a) {
  const main = a.kinds[0] || 'chat';
  return `${icons[main] || '🤖'} ${main.toUpperCase()}`;
}

export function progressEmbed({ botName, analysis, stage, detail='' }) {
  return new EmbedBuilder()
    .setColor(palettes[analysis.kinds[0]] || palettes.chat)
    .setAuthor({ name: `${botName} • đang xử lý`, iconURL: undefined })
    .setTitle(`${analysisLabel(analysis)}`)
    .setDescription(`${stage}${detail ? `\n${detail}` : ''}`)
    .addFields(
      { name:'Độ khó', value:`${analysis.difficulty.toUpperCase()} • ${analysis.score}/100`, inline:true },
      { name:'Chế độ', value:analysis.mode === 'image' ? 'Image Engine' : (analysis.difficulty === 'hard' ? 'Multi‑AI Debate' : 'Adaptive AI'), inline:true }
    )
    .setFooter({ text:'AI Council • xử lý nền, trả lời tự nhiên' })
    .setTimestamp();
}

export function finalEmbed({ botName, analysis, text, providers=[], rounds=0, elapsedMs=0, fileCount=0, image=false }) {
  const clean = text?.trim() || 'Mình chưa có nội dung để trả lời.';
  const desc = clean.length <= 3900 ? clean : `${clean.slice(0, 3860)}\n\n… Nội dung quá dài; mình đã gửi bản đầy đủ dưới dạng file.`;
  const embed = new EmbedBuilder()
    .setColor(palettes[analysis.kinds[0]] || palettes.chat)
    .setAuthor({ name:`${botName} • ${analysisLabel(analysis)}` })
    .setDescription(desc)
    .addFields(
      { name:'Độ khó', value:`${analysis.difficulty.toUpperCase()} • ${analysis.score}/100`, inline:true },
      { name:'AI', value:providers.length ? providers.join(', ').slice(0,1024) : 'local engine', inline:true },
      { name:'Xử lý', value:image ? 'Image Engine' : (rounds ? `${rounds} vòng tranh luận` : 'Adaptive'), inline:true }
    )
    .setFooter({ text:`${fileCount ? `📎 ${fileCount} file • ` : ''}⚡ ${(elapsedMs/1000).toFixed(1)}s` })
    .setTimestamp();
  return embed;
}
