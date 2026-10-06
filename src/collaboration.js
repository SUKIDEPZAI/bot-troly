import { SharedContext } from 'headroom-ai';
import { ask } from './ai.js';
import { config } from './config.js';

const clip = (s, max = config.routing.maxCharsPerAI) =>
  String(s || '').length > max ? `${String(s).slice(0, max)}\n…[đã rút gọn]` : String(s || '');


function roleForTask(ctx, providerName, index) {
  const kinds = new Set(String(ctx.intent || '').split(',').filter(Boolean));
  if (kinds.has('coding')) return index === 0 ? 'Lead engineer' : index === 1 ? 'Code reviewer' : 'Architecture / security engineer';
  if (kinds.has('research')) return index === 0 ? 'Lead researcher' : index === 1 ? 'Fact checker' : 'Skeptical analyst';
  if (kinds.has('creative')) return index === 0 ? 'Creative lead' : 'Creative editor';
  if (kinds.has('math')) return index === 0 ? 'Solver' : 'Proof checker';
  return index === 0 ? 'Lead analyst' : 'Independent critic';
}

function createRoom(model) {
  try {
    return new SharedContext({
      model,
      ttl: config.routing.collabContextTtlSec,
      maxEntries: config.routing.collabMaxEntries
    });
  } catch {
    return null;
  }
}

async function put(room, key, content, agent) {
  if (!room) return;
  try { await room.put(key, content, { agent }); } catch { /* fail-open */ }
}

function get(room, key, full = false, fallback = '') {
  if (!room) return fallback;
  try {
    const value = room.get(key, { full });
    return typeof value === 'string' ? value : value?.content || fallback;
  } catch {
    return fallback;
  }
}


async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = { status: 'fulfilled', value: await worker(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  });
  await Promise.all(runners);
  return results;
}

function peerDossier(results, excludeName = '', room = null, prefix = '') {
  return results
    .filter(x => x?.provider?.name !== excludeName)
    .map(x => {
      const compressed = room ? get(room, `${prefix}${x.provider.name}`, false, x.text) : x.text;
      return `--- ${x.provider.name} ---\n${clip(compressed)}`;
    })
    .join('\n\n');
}

async function askPeer(provider, ctx, prompt, role) {
  return ask(provider, {
    ...ctx,
    messages: [{ role: 'user', content: prompt }],
    system: `${ctx.system}\n\nBẠN ĐANG Ở TRONG PHÒNG CỘNG TÁC AI.\nVai trò hiện tại: ${role}.\nCác AI khác là đồng nghiệp, không phải người dùng. Bạn phải đọc ý kiến của họ, chỉ ra điểm đúng/sai và đóng góp phần của mình. Không được giả vờ đồng ý nếu có lỗi.`
  });
}

export async function collaborativeMedium(providers, ctx) {
  if (providers.length <= 1) return ask(providers[0], ctx);

  const room = createRoom(providers[0].model);
  const first = await mapConcurrent(providers, config.routing.maxParallelAI, (p, i) => ask(p, {
    ...ctx,
    system: `${ctx.system}\nVÒNG 1 CỘNG TÁC: AI ${i + 1} (${roleForTask(ctx, p.name, i)}) hãy tự phân tích nhiệm vụ và đưa ra phương án ban đầu.`
  }));
  const r1 = first.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!r1.length) throw new Error('Không có AI provider nào phản hồi.');

  for (const x of r1) await put(room, `round1:${x.provider.name}`, x.text, x.provider.name);

  const second = await mapConcurrent(r1, config.routing.maxParallelAI, async x => {
    const peers = peerDossier(r1, x.provider.name, room, 'round1:');
    return askPeer(x.provider, ctx,
      `VÒNG 2 CỘNG TÁC. Đây là phương án của các AI đồng nghiệp:\n\n${peers}\n\nHãy phản biện trực tiếp từng điểm quan trọng, sau đó sửa phương án của bạn.`,
      'Peer reviewer'
    );
  });
  const r2 = second.filter(x => x.status === 'fulfilled').map(x => x.value);
  const finals = r2.length ? r2 : r1;
  for (const x of finals) await put(room, `round2:${x.provider.name}`, x.text, x.provider.name);

  const dossier = finals.map(x => `AI ${x.provider.name}:\n${clip(get(room, `round2:${x.provider.name}`, false, x.text))}`).join('\n\n');
  const judge = await ask(finals[0].provider, {
    ...ctx,
    messages: [{ role: 'user', content: `VÒNG CHỐT CỘNG TÁC. Tất cả AI đã trao đổi với nhau. Hãy tổng hợp phương án tốt nhất từ các ý kiến sau thành câu trả lời duy nhất:\n\n${dossier}` }],
    system: `${ctx.system}\nBạn là điều phối viên cuối của phòng cộng tác AI. Chỉ xuất kết quả cuối, không kể nội bộ nếu người dùng không hỏi.`
  });

  return {
    ...judge,
    rounds: 2,
    participants: [...new Set(finals.map(x => x.provider.name))],
    collaboration: true,
    interactionCount: r1.length + r2.length
  };
}

export async function collaborativeHard(providers, ctx) {
  if (providers.length <= 1) return ask(providers[0], ctx);

  const room = createRoom(providers[0].model);
  const names = providers.map(p => p.name).join(' • ');

  // Round 1: all agents start independently, but their outputs enter one shared room.
  const round1 = await mapConcurrent(providers, config.routing.maxParallelAI, (p, i) => ask(p, {
    ...ctx,
    system: `${ctx.system}\nVÒNG 1/3 — ĐỀ XUẤT ĐỘC LẬP. Bạn là AI ${p.name}, vai trò ${roleForTask(ctx, p.name, i)}. Đưa ra phương án của riêng bạn. Sau vòng này các AI khác sẽ đọc phương án của bạn.`
  }));
  const r1 = round1.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!r1.length) throw new Error('Không có AI provider nào phản hồi.');
  for (const x of r1) await put(room, `proposal:${x.provider.name}`, x.text, x.provider.name);

  // Round 2: every AI sees every other AI and directly critiques peers.
  const round2 = await mapConcurrent(r1, config.routing.maxParallelAI, async x => {
    const peers = peerDossier(r1, x.provider.name, room, 'proposal:');
    return askPeer(x.provider, ctx,
      `VÒNG 2/3 — PHẢN BIỆN LIÊN AI. Phòng có các AI: ${names}.\n\nÝ kiến của đồng nghiệp:\n${peers}\n\nBạn phải:\n1) Chỉ ra điểm mạnh/yếu của từng đồng nghiệp.\n2) Nêu mâu thuẫn nếu có.\n3) Đề xuất cách sửa.\n4) Không chỉ lặp lại ý kiến của mình.`,
      'Cross-agent critic'
    );
  });
  const r2 = round2.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!r2.length) return { ...r1[0], rounds: 1, participants: r1.map(x => x.provider.name), collaboration: true };
  for (const x of r2) await put(room, `critique:${x.provider.name}`, x.text, x.provider.name);

  // Round 3: each AI receives proposals + peer critiques and must revise its final position.
  const proposalDossier = r1.map(x => `PROPOSAL ${x.provider.name}:\n${clip(get(room, `proposal:${x.provider.name}`, false, x.text))}`).join('\n\n');
  const critiqueDossier = r2.map(x => `CRITIQUE ${x.provider.name}:\n${clip(get(room, `critique:${x.provider.name}`, false, x.text))}`).join('\n\n');
  const round3 = await mapConcurrent(r2, config.routing.maxParallelAI, async x => askPeer(x.provider, ctx,
    `VÒNG 3/3 — HỢP TÁC CHỐT PHƯƠNG ÁN.\n\n${proposalDossier}\n\n${critiqueDossier}\n\nHãy cập nhật quan điểm của bạn dựa trên toàn bộ trao đổi. Chỉ giữ lập luận có căn cứ, sửa lỗi được đồng nghiệp phát hiện và đưa ra phương án cuối có thể thực thi.`,
    'Final collaborator'
  ));
  const r3 = round3.filter(x => x.status === 'fulfilled').map(x => x.value);
  const finals = r3.length ? r3 : r2;
  for (const x of finals) await put(room, `final:${x.provider.name}`, x.text, x.provider.name);

  // Judge is also a participant: it sees every final and is explicitly told that these are peer outputs.
  const finalDossier = finals.map(x => `FINAL ${x.provider.name}:\n${clip(get(room, `final:${x.provider.name}`, false, x.text))}`).join('\n\n');
  const judgeProvider = [...finals].sort((a,b) => (b.provider.quality || 0) - (a.provider.quality || 0))[0].provider;
  const judge = await ask(judgeProvider, {
    ...ctx,
    messages: [{ role: 'user', content: `JUDGE SAU CỘNG TÁC. Các AI đã trao đổi qua 3 vòng. Hãy tổng hợp các phương án cuối dưới đây thành MỘT đáp án tốt nhất. Nếu các AI bất đồng, tự đánh giá bằng lập luận và chọn phương án đúng hơn.\n\n${finalDossier}` }],
    system: `${ctx.system}\nBạn là Judge cuối cùng của phòng cộng tác AI. Bạn cũng là một thành viên AI trong phòng. Không nhắc quá trình nội bộ trừ khi người dùng yêu cầu.`
  });

  return {
    ...judge,
    rounds: 3,
    participants: [...new Set(finals.map(x => x.provider.name))],
    collaboration: true,
    interactionCount: r1.length + r2.length + finals.length + 1
  };
}

export function collaborationStats(result) {
  return {
    collaboration: Boolean(result?.collaboration),
    rounds: Number(result?.rounds || 0),
    participants: result?.participants || [],
    interactions: Number(result?.interactionCount || 0)
  };
}
