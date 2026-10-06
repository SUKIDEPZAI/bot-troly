import { ask } from '../ai.js';
import { config } from '../config.js';
import { extractFileCandidates } from '../ai.js';

function clip(text, max = 5000) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…[đã rút gọn]` : s;
}

/**
 * Reasoning environment: asks an AI for a compact decision plan, not private chain-of-thought.
 * The plan is a short checklist of assumptions, constraints and verification criteria.
 */
export async function reasoningEnvironment(provider, ctx, { purpose = 'plan' } = {}) {
  if (!config.environments.reasoning.enabled) return null;
  const result = await ask(provider, {
    ...ctx,
    messages: [{ role: 'user', content: `MÔI TRƯỜNG SUY LUẬN — ${purpose.toUpperCase()}\nTạo một decision brief ngắn, KHÔNG tiết lộ chain-of-thought nội bộ. Chỉ ghi:\n- Mục tiêu\n- Ràng buộc/giả định\n- Các bước giải quyết cấp cao\n- Tiêu chí kiểm chứng\n- Rủi ro cần tránh\nNhiệm vụ gốc:\n${clip(ctx.messages?.at(-1)?.content || '')}` }],
    system: `${ctx.system}\nBạn đang ở môi trường suy luận nội bộ. Chỉ tạo decision brief ngắn để agent khác sử dụng; không mô phỏng suy nghĩ riêng tư từng bước.`
  });
  return clip(result.text, config.environments.reasoning.maxChars);
}

/**
 * Critique environment: an independent reviewer evaluates a candidate and returns actionable findings.
 */
export async function critiqueEnvironment(provider, ctx, candidate, { focus = 'correctness' } = {}) {
  if (!config.environments.critique.enabled) return null;
  const result = await ask(provider, {
    ...ctx,
    messages: [{ role: 'user', content: `MÔI TRƯỜNG PHẢN BIỆN — tập trung ${focus}.\nĐây là candidate:\n${clip(candidate)}\n\nHãy kiểm tra độc lập và chỉ trả về:\n1. Lỗi/vấn đề quan trọng\n2. Điều đúng cần giữ\n3. Cách sửa cụ thể\n4. Mức tin cậy (thấp/vừa/cao)\nKhông đồng ý chỉ để tạo đồng thuận.` }],
    system: `${ctx.system}\nBạn là reviewer độc lập. Ưu tiên phát hiện lỗi, mâu thuẫn, giả định sai và thiếu kiểm chứng.`
  });
  return clip(result.text, config.environments.critique.maxChars);
}

/**
 * Test environment: validates generated code without executing arbitrary application code.
 * It currently performs deterministic static checks for common source formats and asks an AI
 * test engineer to propose runnable test cases. It deliberately does not execute user code.
 */
export async function testEnvironment(provider, ctx, candidate, analysis) {
  if (!config.environments.test.enabled) return null;
  const checks = [];
  const candidates = extractFileCandidates(candidate, analysis?.kinds?.includes('coding') ? 'txt' : 'txt');
  if (candidates.length) {
    for (const file of candidates) {
      if (file.language === 'js' || file.language === 'ts' || file.language === 'jsx' || file.language === 'tsx') {
        const opens = (file.content.match(/[({[]/g) || []).length;
        const closes = (file.content.match(/[)}\]]/g) || []).length;
        checks.push(`${file.name}: delimiter heuristic ${opens === closes ? 'OK' : 'WARN'} (${opens}/${closes})`);
      } else if (file.language === 'json') {
        try { JSON.parse(file.content); checks.push(`${file.name}: JSON parse OK`); }
        catch (e) { checks.push(`${file.name}: JSON parse FAIL — ${e.message}`); }
      } else {
        checks.push(`${file.name}: extracted successfully; execution skipped for safety`);
      }
    }
  }

  const aiTest = await ask(provider, {
    ...ctx,
    messages: [{ role: 'user', content: `MÔI TRƯỜNG TEST\nCandidate cần kiểm thử:\n${clip(candidate)}\n\nKiểm tra theo hướng QA. Hãy tạo test cases cụ thể (input → expected output), edge cases và acceptance criteria. Nếu thấy lỗi hiển nhiên, ghi rõ. Không tuyên bố đã chạy test nếu chưa thực sự chạy.` }],
    system: `${ctx.system}\nBạn là Test Engineer. Phân biệt rõ static inspection, test plan và test đã thực thi. Không bịa kết quả.`
  });
  return { checks, testPlan: clip(aiTest.text, config.environments.test.maxChars) };
}

export function shouldUseReasoning(analysis) {
  return config.environments.reasoning.enabled && (
    analysis.difficulty !== 'easy' ||
    analysis.kinds?.some(k => ['coding','research','math','web'].includes(k))
  );
}

export function shouldUseCritique(analysis) {
  return config.environments.critique.enabled && (
    analysis.difficulty !== 'easy' || analysis.kinds?.includes('coding') || analysis.wantsWeb
  );
}

export function shouldUseTest(analysis) {
  return config.environments.test.enabled && (
    analysis.kinds?.includes('coding') || analysis.wantsFile
  );
}
