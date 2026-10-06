import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function generateImage(prompt, { negative='', width=1024, height=1024 } = {}) {
  const wf = JSON.parse(await fs.readFile(path.resolve(config.image.workflow), 'utf8'));
  const seed = Math.floor(Math.random() * 2**31);
  for (const node of Object.values(wf)) {
    const input = node.inputs || {};
    if (typeof input.text === 'string') {
      if (input.text.includes('__POSITIVE__')) input.text = prompt;
      if (input.text.includes('__NEGATIVE__')) input.text = negative || 'low quality, blurry, distorted, watermark';
    }
    if (input.ckpt_name === '__CHECKPOINT__') input.ckpt_name = config.image.checkpoint;
    if ('seed' in input) input.seed = seed;
    if ('width' in input) input.width = width;
    if ('height' in input) input.height = height;
  }

  const clientId = randomUUID();
  const base = config.image.url.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.image.timeoutMs);
  try {
    const queued = await fetch(`${base}/prompt`, {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({prompt:wf, client_id:clientId}), signal: controller.signal
    }).then(r => { if(!r.ok) throw new Error(`ComfyUI /prompt ${r.status}`); return r.json(); });
    const promptId = queued.prompt_id;
    const end = Date.now() + config.image.timeoutMs;
    while (Date.now() < end) {
      await wait(1200);
      const history = await fetch(`${base}/history/${promptId}`, {signal:controller.signal}).then(r => r.ok ? r.json() : ({}));
      const item = history[promptId];
      if (!item) continue;
      const outputs = Object.values(item.outputs || {});
      for (const out of outputs) {
        const image = out.images?.[0];
        if (!image) continue;
        const qs = new URLSearchParams({filename:image.filename, subfolder:image.subfolder || '', type:image.type || 'output'});
        const data = Buffer.from(await fetch(`${base}/view?${qs}`, {signal:controller.signal}).then(r => {
          if (!r.ok) throw new Error(`ComfyUI /view ${r.status}`); return r.arrayBuffer();
        }));
        return { buffer:data, filename:image.filename || 'ai-image.png', seed };
      }
      if (item.status?.status_str === 'error') throw new Error('ComfyUI workflow execution failed.');
    }
    throw new Error('Image generation timeout.');
  } finally { clearTimeout(timer); }
}
