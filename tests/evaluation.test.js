import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareReports, parseEvaluationDataset, runEvaluation } from '../scripts/evaluate-model.mjs';

const dataset = [
  { id: 'one', prompt: 'Return PONG.', requiredTerms: ['pong'] },
  { id: 'two', prompt: 'Use JavaScript.', requiredTerms: ['function', 'return'] },
];

test('evaluation dataset validates fixed cases and rejects duplicates and credentials', async () => {
  assert.equal(parseEvaluationDataset(dataset.map(JSON.stringify).join('\n')).length, 2);
  assert.throws(() => parseEvaluationDataset(`${JSON.stringify(dataset[0])}\n${JSON.stringify(dataset[0])}`), /duplicates case ID/);
  assert.throws(() => parseEvaluationDataset(JSON.stringify({
    id: 'secret',
    prompt: 'api_key=supersecretvalue123',
    requiredTerms: ['done'],
  })), /credentials/);
  await assert.rejects(runEvaluation({
    datasetText: dataset.map(JSON.stringify).join('\n'),
    provider: 'deepseek',
    model: 'cloud-model',
    chat: async () => ({ text: 'unused' }),
  }), /only with explicitly selected local providers/);
});

test('repeatable local evaluation records only test outcomes and compares the same dataset', async () => {
  const datasetText = dataset.map(JSON.stringify).join('\n');
  let callCount = 0;
  const baseline = await runEvaluation({
    datasetText,
    datasetPath: 'smoke.jsonl',
    provider: 'lm-studio',
    model: 'base-model',
    chat: async (prompt) => {
      callCount += 1;
      return { text: prompt.includes('PONG') ? 'PONG' : 'function add() { return 1; }', totalMs: 100 };
    },
  });
  const candidate = await runEvaluation({
    datasetText,
    datasetPath: 'smoke.jsonl',
    provider: 'lm-studio',
    model: 'candidate-model',
    chat: async (prompt) => ({
      text: prompt.includes('PONG') ? 'PONG' : 'function add() { return 1; }',
      totalMs: 80,
    }),
  });
  assert.equal(callCount, 2);
  assert.equal(baseline.summary.passRate, 1);
  assert.equal(candidate.summary.meanTotalMs, 80);
  assert.equal(Object.hasOwn(baseline.results[0], 'response'), false);
  const comparison = compareReports(baseline, candidate);
  assert.equal(comparison.passRateDelta, 0);
  assert.equal(comparison.meanLatencyDeltaMs, -20);
  assert.throws(() => compareReports(baseline, { ...candidate, datasetSha256: '0'.repeat(64) }), /same evaluation dataset/);
});
