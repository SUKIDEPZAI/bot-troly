// Small, explicit branches used by the main pipeline.
export function chooseExecutionBranch(analysis, selectedCount) {
  if (analysis.mode === 'image') return 'image';
  if (analysis.wantsWeb && analysis.webMode === 'url') return 'web-url';
  if (analysis.wantsWeb && analysis.webMode === 'deep') return 'deep-research';
  if (analysis.wantsWeb) return 'web-search';
  if (analysis.explicitAI && selectedCount > 1) return analysis.difficulty === 'hard' ? 'collaborative-3' : 'collaborative-2';
  if (analysis.explicitAI && selectedCount === 1) return 'direct-target';
  if (analysis.difficulty === 'easy') return 'single';
  if (analysis.difficulty === 'medium') return 'collaborative-2';
  return 'collaborative-3';
}

export function buildTaskBranches(analysis) {
  const branches = [...(analysis.kinds || [])];
  if (analysis.language?.style) branches.push(`language:${analysis.language.style}`);
  if (analysis.explicitAI) branches.push('target-ai');
  if (analysis.wantsFile) branches.push('file-output');
  if (analysis.wantsWeb) branches.push(`web:${analysis.webMode}`);
  return [...new Set(branches)];
}
