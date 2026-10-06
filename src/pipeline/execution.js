import { singleAnswer, mediumAnswer, hardDebate } from '../debate.js';
import { askWithFallback, providerAvailable } from '../ai.js';
import { chooseExecutionBranch } from './branches.js';
import { reasoningEnvironment, critiqueEnvironment, testEnvironment, shouldUseReasoning, shouldUseCritique, shouldUseTest } from './environments.js';
import { buildRolePlan, evaluateLightweight } from '../integrations/ecosystem.js';

function enrichContext(ctx, reasoningBrief) {
  if (!reasoningBrief) return ctx;
  return {
    ...ctx,
    system: `${ctx.system}\n\nDECISION BRIEF TỪ MÔI TRƯỜNG SUY LUẬN:\n${reasoningBrief}\nHãy kiểm tra brief trước khi dùng; nếu sai, sửa nó.`
  };
}

async function runEnvironments(provider, analysis, ctx, candidate) {
  const out = { reasoning: null, critique: null, test: null };
  if (shouldUseCritique(analysis) && candidate) {
    out.critique = await critiqueEnvironment(provider, ctx, candidate, { focus: analysis.kinds?.includes('coding') ? 'correctness, security and maintainability' : 'factual correctness and task fit' }).catch(() => null);
  }
  if (shouldUseTest(analysis) && candidate) {
    out.test = await testEnvironment(provider, ctx, candidate, analysis).catch(() => null);
  }
  return out;
}

export async function executeTask({ analysis, selected, ctx, onHardStart = async () => {}, onEnvironment = async () => {} }) {
  const branch = analysis.explicitAI && selected.length > 1
    ? (analysis.difficulty === 'hard' ? 'collaborative-3' : 'collaborative-2')
    : chooseExecutionBranch(analysis, selected.length);
  const available = selected.filter(providerAvailable);
  if (!available.length) throw new Error('Không có AI khả dụng; các provider đang lỗi hoặc cooldown.');

  // Reasoning environment is a compact planning layer, not hidden chain-of-thought.
  let workingCtx = ctx;
  if (shouldUseReasoning(analysis)) {
    const reasoningProvider = available[0];
    await onEnvironment('🧠 Môi trường suy luận đang lập decision brief…');
    const brief = await reasoningEnvironment(reasoningProvider, ctx, { purpose: branch }).catch(() => null);
    workingCtx = enrichContext(ctx, brief);
  }

  let result;
  const rolePlan = buildRolePlan(analysis);
  if (analysis.explicitAI && available.length === 1) {
    result = { ...(await singleAnswer(available[0], workingCtx)), branch, rolePlan };
  } else if (branch === 'single') {
    result = { ...(await askWithFallback(available, workingCtx)), branch, rolePlan };
  } else if (branch === 'collaborative-2') {
    result = { ...(await mediumAnswer(available, workingCtx)), branch, rolePlan };
  } else if (branch === 'collaborative-3') {
    await onHardStart(available);
    result = { ...(await hardDebate(available, workingCtx)), branch, rolePlan };
  } else {
    result = { ...(await askWithFallback(available, workingCtx)), branch, rolePlan };
  }

  // Test/critique environments inspect the candidate and feed actionable findings
  // back into a final revision pass instead of dumping internal review text to Discord.
  const inspector = available[1] || available[0];
  if (shouldUseCritique(analysis) || shouldUseTest(analysis)) {
    await onEnvironment('🧪 Môi trường kiểm thử & phản biện đang kiểm tra kết quả…');
    result.environments = await runEnvironments(inspector, analysis, workingCtx, result.text);
    const c = result.environments.critique;
    const t = result.environments.test;
    const findings = [
      c ? `PHẢN BIỆN ĐỘC LẬP:\n${c}` : '',
      t ? `KẾT QUẢ TEST TĨNH / TEST PLAN:\n${t.checks.join('\n') || 'Không có kiểm tra tĩnh áp dụng.'}\n${t.testPlan}` : ''
    ].filter(Boolean).join('\n\n');
    if (findings) {
      await onEnvironment('🔧 Đang sửa kết quả theo phản biện và kiểm thử…');
      const revised = await askWithFallback([inspector], {
        ...workingCtx,
        messages: [{ role:'user', content: `CANDIDATE BAN ĐẦU:\n${result.text}\n\n${findings}\n\nHãy tạo BẢN CUỐI đã sửa. Chỉ xuất đáp án người dùng cần; không kể nội bộ, không chép nguyên báo cáo review/test. Nếu reviewer sai, bỏ qua phần sai và giữ lập luận đúng. Không tuyên bố đã chạy test nếu chỉ có static check/test plan.` }],
        intent: ctx.intent,
        difficulty: ctx.difficulty,
        analysis
      }).catch(() => null);
      if (revised?.text) result.text = revised.text;
    }
  }

  result.qualityGate = evaluateLightweight(result.text, analysis);
  if (!result.qualityGate.ok && !result.text) throw new Error('AI không tạo được câu trả lời hợp lệ.');
  return result;
}
