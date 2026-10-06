import { ask } from './ai.js';
import { collaborativeMedium, collaborativeHard } from './collaboration.js';

export async function singleAnswer(provider, ctx) {
  return ask(provider, ctx);
}

export async function mediumAnswer(providers, ctx) {
  return collaborativeMedium(providers, ctx);
}

export async function hardDebate(providers, ctx) {
  return collaborativeHard(providers, ctx);
}
