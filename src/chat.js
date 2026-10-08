// Pipeline trả lời: ghép system prompt + lịch sử kênh + câu hỏi → engine (có giới hạn đồng thời).
import { councilChat, routedChat } from './engine.js';
import { addTurn, getHistory } from './history.js';
import { buildSystemPrompt } from './personas.js';
import { createLimiter, envInt, stats, truncate } from './utils.js';

const limiter = createLimiter(envInt('MAX_CONCURRENT_AI', 4, 1, 16), 30);
export const limiterState = () => ({ active: limiter.active, waiting: limiter.waiting });

export async function answer({ channelId, userName, text, referenced = '', council = false, settings, botName = 'AI Council', skipHistory = false }) {
  const quoted = referenced ? `(Đang trả lời tin nhắn: "${truncate(referenced.replace(/\s+/g, ' '), 500)}")\n` : '';
  const userContent = `${userName}: ${quoted}${text}`;
  const messages = [
    { role: 'system', content: buildSystemPrompt({ botName, persona: settings.persona }) },
    ...(skipHistory ? [] : getHistory(channelId)),
    { role: 'user', content: userContent }
  ];
  const useCouncil = council && settings.council;
  if (useCouncil) stats.councils++;
  const run = () => (useCouncil ? councilChat : routedChat)({ messages, prompt: text, settings });
  const result = await limiter.run(run);
  if (!skipHistory) addTurn(channelId, userContent, result.text);
  return result;
}
