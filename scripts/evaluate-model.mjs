import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio']);
const PRIVATE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{15,})\b/,
  /\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

export function parseEvaluationDataset(text) {
  const cases = [];
  const ids = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error(`Evaluation dataset line ${index + 1} is not valid JSON.`);
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'id,prompt,requiredTerms'
      || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)
      || typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 2000
      || !Array.isArray(item.requiredTerms) || item.requiredTerms.length < 1 || item.requiredTerms.length > 10
      || item.requiredTerms.some((term) => typeof term !== 'string' || !term.trim() || term.length > 120)) {
      throw new Error(`Evaluation dataset line ${index + 1} does not match the id/prompt/requiredTerms schema.`);
    }
    if (ids.has(item.id)) throw new Error(`Evaluation dataset line ${index + 1} duplicates case ID "${item.id}".`);
    if (PRIVATE_PATTERNS.some((pattern) => pattern.test(item.prompt) || item.requiredTerms.some((term) => pattern.test(term)))) {
      throw new Error(`Evaluation dataset line ${index + 1} appears to contain credentials; remove them before evaluation.`);
    }
    ids.add(item.id);
    cases.push({
      id: item.id,
      prompt: item.prompt,
      requiredTerms: item.requiredTerms.map((term) => term.toLocaleLowerCase()),
    });
  }
  if (!cases.length) throw new Error('Evaluation dataset must contain at least one test case.');
  return cases;
}

export async function runEvaluation({ datasetText, datasetPath, provider, model, chat }) {
  if (!LOCAL_PROVIDERS.has(provider)) throw new Error('Evaluation runs only with explicitly selected local providers (ollama or lm-studio).');
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) throw new Error('A valid local model ID is required.');
  const cases = parseEvaluationDataset(datasetText);
  const results = [];
  for (const testCase of cases) {
    const started = performance.now();
    const response = await chat(testCase.prompt);
    const output = response.text.toLocaleLowerCase();
    const matchedTerms = testCase.requiredTerms.filter((term) => output.includes(term));
    results.push({
      id: testCase.id,
      passed: matchedTerms.length === testCase.requiredTerms.length,
      matchedTerms,
      requiredTermCount: testCase.requiredTerms.length,
      totalMs: response.totalMs ?? Math.round(performance.now() - started),
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    });
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    provider,
    model,
    datasetPath,
    datasetSha256: createHash('sha256').update(datasetText).digest('hex'),
    mode: 'local-smoke-evaluation',
    summary: {
      total: results.length,
      passed,
      passRate: passed / results.length,
      meanTotalMs: Math.round(results.reduce((total, result) => total + result.totalMs, 0) / results.length),
    },
    results,
    note: 'Keyword smoke checks are not a measure of general model quality, factuality, or safety. Model outputs are not retained.',
  };
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

async function postChat(baseUrl, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error(`Could not reach the local Maya backend at ${baseUrl}: ${error.message}`);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.error === 'string' ? payload.error : `Local Maya chat failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('Maya returned no evaluation response stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let metrics;
  let done = false;
  try {
    while (true) {
      const { value, done: ended } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !ended });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          throw new Error('Maya returned malformed evaluation stream data.');
        }
        if (typeof payload.error === 'string') throw new Error(payload.error);
        if (typeof payload.token === 'string') {
          text += payload.token;
          if (text.length > 200_000) throw new Error('Evaluation response exceeded the 200,000 character safety limit.');
        }
        if (payload.metrics && typeof payload.metrics === 'object') metrics = payload.metrics;
        if (payload.done === true) done = true;
      }
      if (ended) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!done || !text.trim()) throw new Error('Maya evaluation stream ended without a complete assistant response.');
  return { text, totalMs: metrics?.totalMs, finishReason: metrics?.finishReason };
}

function validateReport(report, label) {
  if (!report || report.schemaVersion !== 1 || report.mode !== 'local-smoke-evaluation'
    || !/^[a-f0-9]{64}$/.test(report.datasetSha256)
    || !Array.isArray(report.results) || !report.results.length) {
    throw new Error(`${label} is not a valid Maya evaluation report.`);
  }
}

export function compareReports(baseline, candidate) {
  validateReport(baseline, 'Baseline report');
  validateReport(candidate, 'Candidate report');
  const baselineIds = baseline.results.map((result) => result.id).sort();
  const candidateIds = candidate.results.map((result) => result.id).sort();
  if (baseline.datasetSha256 !== candidate.datasetSha256
    || JSON.stringify(baselineIds) !== JSON.stringify(candidateIds)) {
    throw new Error('Reports must use the exact same evaluation dataset and cases.');
  }
  return {
    datasetSha256: baseline.datasetSha256,
    baseline: { provider: baseline.provider, model: baseline.model, ...baseline.summary },
    candidate: { provider: candidate.provider, model: candidate.model, ...candidate.summary },
    passRateDelta: candidate.summary.passRate - baseline.summary.passRate,
    meanLatencyDeltaMs: candidate.summary.meanTotalMs - baseline.summary.meanTotalMs,
    note: 'This small keyword benchmark is directional only and does not establish general model quality or safety.',
  };
}

function readOption(args, name, required = true) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
    if (!required) return undefined;
    throw new Error(`Missing required option ${name}.`);
  }
  return args[index + 1];
}

async function main(args) {
  if (args[0] === '--compare') {
    const baselinePath = args[1];
    const candidatePath = args[2];
    if (!baselinePath || !candidatePath || args.length !== 3) throw new Error('Usage: node scripts/evaluate-model.mjs --compare <baseline.json> <candidate.json>');
    const [baseline, candidate] = await Promise.all([
      fs.readFile(baselinePath, 'utf8').then(JSON.parse),
      fs.readFile(candidatePath, 'utf8').then(JSON.parse),
    ]);
    console.log(JSON.stringify(compareReports(baseline, candidate), null, 2));
    return;
  }

  const provider = readOption(args, '--provider');
  const model = readOption(args, '--model');
  const datasetPath = path.resolve(readOption(args, '--dataset'));
  const outputPath = readOption(args, '--output', false);
  const rawBaseUrl = process.env.MAYA_EVALUATION_API_URL || 'http://127.0.0.1:3000/api';
  const baseUrl = new URL(rawBaseUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || !isLoopbackHostname(baseUrl.hostname)
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('MAYA_EVALUATION_API_URL must be a loopback Maya API URL with no credentials or query parameters.');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  const apiBaseUrl = baseUrl.href.replace(/\/+$/, '');
  const datasetText = await fs.readFile(datasetPath, 'utf8');
  const report = await runEvaluation({
    datasetText,
    datasetPath,
    provider,
    model,
    chat: (message) => postChat(apiBaseUrl, process.env.MAYA_API_TOKEN || '', {
      provider,
      model,
      message,
      conversation: [],
      temperature: 0,
      context: 2048,
      maxTokens: 512,
      systemPrompt: '',
      webSearch: false,
      useMemory: false,
    }),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const target = path.resolve(outputPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, serialized, { encoding: 'utf8', flag: 'wx' });
    console.log(`Evaluation report written to ${target}`);
  } else {
    console.log(serialized);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Evaluation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
