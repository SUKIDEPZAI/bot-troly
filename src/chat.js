// Pipeline trả lời: ghép system prompt + lịch sử kênh + câu hỏi → engine (có giới hạn đồng thời).
import { councilChat, routedChat } from './engine.js';
import { addTurn, getHistory, historyKey } from './history.js';
import { buildSystemPrompt } from './personas.js';
import { createLimiter, envInt, stats, truncate } from './utils.js';

const limiter = createLimiter(envInt('MAX_CONCURRENT_AI', 4, 1, 16), 30);
export const limiterState = () => ({ active: limiter.active, waiting: limiter.waiting });

export async function answer({ channelId, userId = '', userName, text, referenced = '', council = false, settings, botName = 'AI Council', skipHistory = false }) {
  const hKey = historyKey(channelId, userId);
  const quoted = referenced ? `(Đang trả lời tin nhắn: "${truncate(referenced.replace(/\s+/g, ' '), 500)}")\n` : '';
  const userContent = `${userName}: ${quoted}${text}`;
  const messages = [
    { role: 'system', content: buildSystemPrompt({ botName, persona: settings.persona }) },
    ...(skipHistory ? [] : getHistory(hKey)),
    { role: 'user', content: userContent }
  ];
  const useCouncil = council && settings.council;
  if (useCouncil) stats.councils++;
  const run = () => (useCouncil ? councilChat : routedChat)({ messages, prompt: text, settings });
  const result = await limiter.run(run);
  if (!skipHistory) addTurn(hKey, userContent, result.text);
  return result;
}
