import { compress } from 'headroom-ai';
import { config } from './config.js';

let lastReport = null;

export async function compressMessages(messages, model) {
  const totalChars = messages.reduce((n, m) => n + String(m?.content ?? '').length, 0);
  if (!config.headroom.enabled || totalChars < config.routing.headroomMinChars) {
    return { messages, compressed: false, tokensSaved: 0, tokensBefore: 0, tokensAfter: 0, compressionRatio: 0, transformsApplied: [], skipped: true };
  }

  try {
    const result = await compress(messages, {
      model,
      tokenBudget: config.headroom.tokenBudget || undefined
    });
    lastReport = {
      compressed: Boolean(result.compressed),
      tokensBefore: Number(result.tokensBefore || 0),
      tokensAfter: Number(result.tokensAfter || 0),
      tokensSaved: Number(result.tokensSaved || 0),
      compressionRatio: Number(result.compressionRatio || 0),
      transformsApplied: result.transformsApplied || []
    };
    return { ...lastReport, messages: result.messages };
  } catch (err) {
    if (config.headroom.failOpen) {
      return { messages, compressed: false, tokensSaved: 0, tokensBefore: 0, tokensAfter: 0, compressionRatio: 0, transformsApplied: [], error: String(err.message || err) };
    }
    throw err;
  }
}

export function headroomStatus() {
  return { enabled: config.headroom.enabled, mode: 'local-sdk', last: lastReport };
}
