import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { runEvaluationAgent, type AgentInput } from '../server/lib/agent.js';
import type { AgentCompletionRequest, Completion } from '../server/lib/model.js';
import type { CollectionInput } from '../server/lib/collector.js';
import type { Evidence, RuleSet } from '../shared/types.js';
import agentRule from '../server/lib/agent-rule.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAAAxklEQVR42u3RMQ0AAAzDsPIn3ZHYV0shEDlNphrbbQADBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBgwYMGDAgAEDBvzVASYy0OCwGZT6AAAAAElFTkSuQmCC';
let callId = 0;
const response = (...calls: [string, unknown][]): Completion => ({
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      logprobs: null,
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: calls.map(([name, args]) => ({
          id: `call-${++callId}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      },
    },
  ],
  usage: { total_tokens: 10 },
});

async function fixture(options: { scope?: 'homepage' | 'site'; rule?: RuleSet } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'evaluator-agent-test-'));
  let input: AgentInput;
  const captures: string[] = [];
  const failures = new Set<string>();
  const collect = async (request: CollectionInput): Promise<Evidence> => {
    assert.equal(request.continuous, true);
    assert.equal(request.maxAttempts, 1);
    const role = request.roles![0],
      viewport = request.rule.viewports[0],
      key = `${role}-${viewport.id}`;
    captures.push(key);
    if (failures.has(key)) throw Error('temporary capture failure');
    const id = `${key}-${request.attemptTag}-tile-001`,
      file = `${id}.png`;
    request.artifacts.save(request.evaluationId, request.runId, file, png);
    const evidence: Evidence = {
      targetUrl: request.targetUrl,
      targetTitle: 'Visible page',
      text: 'Actual page content',
      readme: null,
      screenshots: [
        {
          id,
          file,
          role,
          viewport: viewport.id,
          region: 'tile-001',
          width: viewport.width,
          height: viewport.height,
          pageY: 0,
          url: role === 'target' ? request.targetUrl : request.referenceUrl!,
          capturedAt: Date.now(),
        },
      ],
      health: 'ok',
      issues: [],
      fingerprint: 'stable',
      stable: true,
      coverage: {
        requested: request.scope,
        actual: 'homepage',
        complete: request.scope === 'homepage',
        captureComplete: true,
        note: 'Static homepage',
      },
    };
    request.onProgress?.('checkpoint', evidence);
    return evidence;
  };
  const state = { complete: undefined as AgentCompletionRequest | undefined };
  const instance = await createApp({
    directory,
    serveWeb: false,
    startWorker: false,
    workerDependencies: {
      resolve: async () => ({ targetUrl: 'https://target.test/', readme: null, warnings: [] }),
      agent: (args) => {
        input = args;
        return runEvaluationAgent({
          ...args,
          collect,
          complete: (...a) => state.complete!(...a),
          sheet: async (shots, get) => {
            shots.forEach(get);
            return Buffer.from(png, 'base64');
          },
        });
      },
    },
  });
  instance.vault.update({
    ...instance.vault.get(),
    model: {
      endpoint: 'https://model.test/chat/completions',
      name: 'scripted-agent',
      apiKey: 'private-test-key',
    },
    execution: { timeoutSeconds: 30, captureAttempts: 2 },
  });
  const login = await instance.app.inject({ method: 'POST', url: '/api/login' });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  if (options.rule) {
    const draft = instance.store.createDraft(options.rule);
    instance.store.publishDraft(draft.id, draft.revision);
  }
  const accepted = await instance.app.inject({
    method: 'POST',
    url: '/api/manual-evaluations',
    headers: { cookie },
    payload: {
      jobId: 'agent-test',
      targetUrl: 'https://target.test/',
      referenceUrl: 'https://reference.test/',
      scope: options.scope || 'homepage',
    },
  });
  assert.equal(accepted.statusCode, 202);
  const id = accepted.json().evaluationId as string;
  const keys = ['target-desktop', 'target-mobile', 'reference-desktop', 'reference-mobile'];
  const shots = () => input.pipeline.captures.flatMap((c) => c.evidence?.screenshots || []);
  const captureCalls = (): [string, unknown][] =>
    keys
      .filter(
        (k) =>
          !input.pipeline.captures.some(
            (c) => `${c.role}-${c.viewport}` === k && ['completed', 'reused'].includes(c.status)
          )
      )
      .map((key) => {
        const [role, viewport] = key.split('-');
        return ['capture_page', { role, viewport }];
      });
  const readCalls = (): [string, unknown][] =>
    shots().map((s) => ['read_images', { ids: [s.id], mode: 'overview' }]);
  const reviews = (): [string, unknown][] =>
    input.pipeline.captures.map((c) => [
      'submit_review',
      {
        role: c.role,
        viewport: c.viewport,
        usable: true,
        reason: 'Visible page sections',
        evidence: c.evidence!.screenshots.map((s) => s.id),
      },
    ]);
  const assessment = () => ({
    summary: 'Compared visible semantic sections',
    confidence: 'medium',
    completionScore: null,
    dimensions: input.rule.dimensions.map((d) => ({
      id: d.id,
      score: 83,
      reason: 'Compared actual images',
      evidence: shots()
        .filter((s) => (d.id === 'mobile' ? s.viewport === 'mobile' : s.viewport === 'desktop'))
        .map((s) => s.id),
    })),
    issues: [],
    limitations: ['Static homepage only; interactions and animations not verified'],
    pairings: [
      {
        name: 'Hero',
        target: shots()
          .filter((s) => s.role === 'target')
          .map((s) => s.id),
        reference: shots()
          .filter((s) => s.role === 'reference')
          .map((s) => s.id),
      },
    ],
  });
  const toolsResults = (messages: Parameters<AgentCompletionRequest>[1]) =>
    messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content as string));
  let modelTurns = 0;
  function normalAgent(): AgentCompletionRequest {
    return async (_model, messages, tools) => {
      assert.ok(
        tools.some((t) => t.type === 'function' && t.function.name === 'submit_assessment')
      );
      modelTurns++;
      if (modelTurns === 1) {
        const calls = captureCalls();
        return calls.length ? response(...calls) : response(['get_task', {}]);
      }
      if (modelTurns === 2) return response(...readCalls());
      assert.ok(
        messages.some(
          (m) =>
            m.role === 'user' &&
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === 'image_url' && p.image_url.url.includes(png))
        ),
        'model must receive actual pixels'
      );
      return response(...reviews(), ['submit_assessment', assessment()]);
    };
  }
  return {
    ...instance,
    directory,
    id,
    cookie,
    captures,
    failures,
    state,
    shots,
    keys,
    captureCalls,
    readCalls,
    reviews,
    assessment,
    toolsResults,
    normalAgent,
    input: () => input!,
    resetTurns() {
      modelTurns = 0;
    },
    async close() {
      await instance.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('published custom dimensions and instructions reach the agent and use configured weights', async () => {
  const customRule: RuleSet = { ...agentRule, version: 'agent-custom-v1', dimensions: [
    ...agentRule.dimensions.filter(d => ['layout', 'spacing', 'typography', 'mobile'].includes(d.id)).map(d => ({ ...d, weight: 20 })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `custom-${index}`, label: `自定义 ${index}`, weight: 4, instruction: `逐项检查自定义标准 ${index}` })),
  ] };
  const f = await fixture({ rule: customRule });
  try {
    const normal = f.normalAgent();
    f.state.complete = async (...args) => {
      const system = args[1].find(m => m.role === 'system')!.content as string;
      assert.ok(system.includes(JSON.stringify({ version: customRule.version, dimensions: customRule.dimensions })));
      assert.ok(system.includes('优先于上文中的固定维度示例'));
      const response = await normal(...args);
      for (const call of response.choices[0].message.tool_calls || []) {
        if (call.type !== 'function' || call.function.name !== 'submit_assessment') continue;
        const assessment = JSON.parse(call.function.arguments);
        for (const dimension of assessment.dimensions) if (dimension.id.startsWith('custom-')) dimension.score = 50;
        call.function.arguments = JSON.stringify(assessment);
      }
      return response;
    };
    await f.worker.tick();
    const run = f.store.get(f.id)!.run;
    assert.equal(run.status, 'completed', run.error || '');
    assert.equal(run.report!.dimensions.length, 9);
    assert.equal(run.report!.fidelityScore, 76.4);
    assert.deepEqual(run.snapshot!.rule, customRule);
    assert.deepEqual(run.report!.dimensions.map(d => d.id), customRule.dimensions.map(d => d.id));
  } finally { await f.close(); }
});

test('manual kickoff runs autonomous tools, delivers real image inputs and persists report, source images and traces across reopening', async () => {
  const f = await fixture();
  try {
    f.state.complete = f.normalAgent();
    await f.worker.tick();
    const run = f.store.get(f.id)!.run;
    assert.equal(run.status, 'completed');
    assert.equal(run.report!.fidelityScore, 83);
    assert.equal(run.snapshot!.rule.version, 'agent-ui-v1');
    assert.equal(run.snapshot!.executor!.kind, 'tool-agent');
    assert.equal(run.pipeline!.agent!.iterations, 3);
    assert.equal(run.pipeline!.agent!.calls.length, 13);
    assert.equal(run.report!.model.usage!.total_tokens, 30);
    assert.ok(run.pipeline!.steps.every((s) => s.status === 'completed'));
    const shot = run.evidence!.screenshots[0];
    const image = await f.app.inject({
      url: `/api/evaluations/${f.id}/artifacts/${run.id}/${shot.file}`,
      headers: { cookie: f.cookie },
    });
    assert.equal(image.statusCode, 200);
    assert.deepEqual(image.rawPayload, Buffer.from(png, 'base64'));
    assert.equal(
      (
        await f.app.inject({
          url: `/api/evaluations/${f.id}/reports/${run.id}`,
          headers: { cookie: f.cookie },
        })
      ).json().report.fidelityScore,
      83
    );
    await f.app.close();
    const reopened = await createApp({
      directory: f.directory,
      serveWeb: false,
      startWorker: false,
    });
    try {
      assert.equal(reopened.store.get(f.id)!.run.report!.fidelityScore, 83);
      assert.equal(reopened.store.get(f.id)!.run.pipeline!.agent!.calls.length, 13);
    } finally {
      await reopened.app.close();
    }
  } finally {
    await f.close();
  }
});

test('reading files in the same tool batch does not prove seeing pixels; unseen, invented and wrong-role evidence is rejected', async () => {
  const f = await fixture();
  let turn = 0;
  try {
    f.state.complete = async (_model, messages) => {
      turn++;
      if (turn === 1) return response(...f.captureCalls());
      if (turn === 2)
        return response(...f.readCalls(), ...f.reviews(), ['submit_assessment', f.assessment()]);
      if (turn === 3) {
        assert.ok(f.toolsResults(messages).filter((r) => r.error).length >= 4);
        const invalid = f.assessment();
        invalid.dimensions[0].evidence = ['invented'];
        return response(...f.reviews(), ['submit_assessment', invalid]);
      }
      if (turn === 4) {
        assert.match(f.toolsResults(messages).at(-1).error, /实际查看/);
        const invalid = f.assessment();
        invalid.pairings[0].reference = invalid.pairings[0].target;
        return response(['submit_assessment', invalid]);
      }
      if (turn === 5) {
        assert.match(f.toolsResults(messages).at(-1).error, /对应截图/);
        const invalid = f.assessment();
        invalid.dimensions.find((d) => d.id === 'mobile')!.evidence = f
          .shots()
          .filter((s) => s.viewport === 'desktop')
          .map((s) => s.id);
        return response(['submit_assessment', invalid]);
      }
      assert.match(f.toolsResults(messages).at(-1).error, /移动项/);
      return response(['submit_assessment', f.assessment()]);
    };
    await f.worker.tick();
    assert.equal(f.store.get(f.id)!.run.status, 'completed');
    assert.ok(
      f.store.get(f.id)!.run.pipeline!.agent!.calls.filter((c) => c.status === 'failed').length >= 7
    );
  } finally {
    await f.close();
  }
});

test('failed capture diagnostic retains successful evidence; retry collects only missing viewports and views reused source images again', async () => {
  const f = await fixture();
  let turn = 0;
  try {
    f.failures.add('reference-mobile');
    f.state.complete = async () =>
      ++turn === 1
        ? response(...f.captureCalls())
        : response([
            'report_blocked',
            {
              reason: 'Mobile reference unavailable',
              limitations: ['Missing mobile reference; no score'],
            },
          ]);
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    assert.equal(first.status, 'failed');
    assert.equal(first.report!.fidelityScore, null);
    assert.equal(first.pipeline!.captures.filter((c) => c.status === 'completed').length, 3);
    f.failures.clear();
    f.captures.length = 0;
    f.resetTurns();
    f.state.complete = f.normalAgent();
    f.store.rerun(f.id, { mode: 'failed', sourceRunId: first.id });
    await f.worker.tick();
    const next = f.store.get(f.id)!.run;
    assert.equal(next.status, 'completed');
    assert.deepEqual(f.captures, ['reference-mobile']);
    assert.ok(
      next
        .evidence!.screenshots.filter((s) => s.viewport !== 'mobile' || s.role !== 'reference')
        .every((s) => s.sourceRunId === first.id)
    );
    assert.equal(f.store.history(f.id).find((r) => r.id === first.id)!.report!.fidelityScore, null);
  } finally {
    await f.close();
  }
});

test('capture budgets survive executor restart and stopped model call queues completed viewports for recovery', async () => {
  const f = await fixture();
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  let turn = 0;
  try {
    f.state.complete = async (_model, _messages, _tools, _timeout, signal) => {
      if (++turn === 1) return response(...f.captureCalls());
      entered();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      );
    };
    const running = f.worker.tick();
    await ready;
    await f.worker.stop();
    await running;
    const queued = f.store.get(f.id)!.run;
    assert.equal(queued.status, 'queued');
    assert.equal(queued.pipeline!.agent!.captureAttempts!['target-desktop'], 1);
    const input = f.input();
    const owner = 'resumed-test';
    const claimed = f.store.claim(owner)!;
    assert.equal(claimed.run.id, queued.id);
    const pipeline = claimed.run.pipeline!;
    pipeline.agent!.captureAttempts!['target-desktop'] = 2;
    let count = 0;
    await runEvaluationAgent({
      ...input,
      owner,
      pipeline,
      signal: new AbortController().signal,
      checkpoint: () => {},
      start: (id) => pipeline.steps.find((s) => s.id === id)!,
      finish: (step, status) => {
        step.status = status;
      },
      complete: async (_m, messages) => {
        if (++count === 1)
          return response(['capture_page', { role: 'target', viewport: 'desktop', force: true }]);
        assert.match(f.toolsResults(messages).at(-1).error, /次数上限/);
        return response(['report_blocked', { reason: 'budget checked', limitations: [] }]);
      },
    });
    assert.equal(f.captures.length, 4);
  } finally {
    await f.close();
  }
});

test('file tampering is detected before scoring and an incomplete capture cannot pass visual review', async () => {
  const f = await fixture();
  let turn = 0;
  try {
    f.state.complete = async (_m, messages) => {
      if (++turn === 1) return response(...f.captureCalls());
      if (turn === 2) {
        f.input().pipeline.captures[0].evidence!.coverage.complete = false;
        return response(...f.readCalls());
      }
      if (turn === 3) return response(...f.reviews());
      assert.ok(f.toolsResults(messages).some((r) => /完整/.test(r.error || '')));
      return response([
        'report_blocked',
        { reason: 'incomplete capture', limitations: ['Coverage incomplete'] },
      ]);
    };
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    assert.equal(first.report!.fidelityScore, null);
    const shot = first.evidence!.screenshots[0];
    writeFileSync(join(f.directory, 'artifacts', f.id, first.id, shot.file), 'tampered');
    const imageResponse = await f.app.inject({
      url: `/api/evaluations/${f.id}/artifacts/${first.id}/${shot.file}`,
      headers: { cookie: f.cookie },
    });
    assert.equal(imageResponse.statusCode, 404);
  } finally {
    await f.close();
  }
});

test('score-only retry restores aggregate capture stages, reviews images again and report-only retry uses accepted report without model', async () => {
  const f = await fixture();
  try {
    f.state.complete = f.normalAgent();
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    f.captures.length = 0;
    f.resetTurns();
    f.state.complete = f.normalAgent();
    f.store.rerun(f.id, { mode: 'score', sourceRunId: first.id });
    await f.worker.tick();
    const scored = f.store.get(f.id)!.run;
    assert.equal(scored.status, 'completed');
    assert.deepEqual(f.captures, []);
    assert.ok(
      scored.pipeline!.steps.every((s) => s.status === 'completed' || s.status === 'reused')
    );
    assert.ok(scored.evidence!.screenshots.every((s) => s.sourceRunId === first.id));
    f.state.complete = async () => {
      throw Error('report-only retry must not call model');
    };
    f.store.rerun(f.id, { mode: 'report', sourceRunId: scored.id });
    await f.worker.tick();
    const report = f.store.get(f.id)!.run;
    assert.equal(report.status, 'completed');
    assert.equal(report.report!.fidelityScore, 83);
    assert.equal(report.pipeline!.agent!.iterations, 0);
  } finally {
    await f.close();
  }
});


test('image batches remain in model context until their visual review records observations',async()=>{
  const f=await fixture();let turn=0;
  const imageCount=(messages:Parameters<AgentCompletionRequest>[1])=>messages.flatMap(m=>m.role==='user'&&Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length;
  try{
    f.state.complete=async(_m,messages)=>{
      turn++;
      if(turn===1)return response(...f.captureCalls());
      if(turn===2)return response(...f.readCalls().slice(0,2));
      if(turn===3){assert.equal(imageCount(messages),2);return response(...f.readCalls().slice(2));}
      if(turn===4){assert.equal(imageCount(messages),4,'earlier unseen-in-review batches must remain available');return response(...f.reviews());}
      assert.equal(imageCount(messages),0,'review text now preserves observations without resending pixels');
      return response(['submit_assessment',f.assessment()]);
    };
    await f.worker.tick();assert.equal(f.store.get(f.id)!.run.status,'completed');
  }finally{await f.close();}
});

test('site requests can assess complete homepage evidence while retaining explicit incomplete site coverage', async () => {
  const f = await fixture({ scope: 'site' });
  let turn = 0;
  try {
    f.state.complete = async (_model, messages) => {
      if (++turn === 1) {
        f.input().pipeline.prepared!.readme = 'Verify the entire site including contact page';
        const task = JSON.parse(String(messages[1].content).split('\n').slice(1).join('\n'));
        assert.equal(task.scope, 'site');
        assert.equal(task.assessmentScope, 'homepage');
        assert.ok(task.scopeLimitations.length);
        return response(...f.captureCalls());
      }
      if (turn === 2) return response(...f.readCalls());
      const assessment = { ...f.assessment(), confidence: 'high', completionScore: 100 };
      return response(...f.reviews(), ['submit_assessment', assessment]);
    };
    await f.worker.tick();
    const evaluation = f.store.get(f.id)!;
    const run = evaluation.run;
    assert.equal(run.status, 'completed');
    assert.equal(run.report!.fidelityScore, 83, 'score applies to observed homepage only');
    assert.equal(run.report!.completionScore, null, 'homepage evidence cannot certify whole-site requirements');
    assert.equal(run.report!.confidence, 'medium');
    assert.equal(run.report!.coverage.requested, 'site');
    assert.equal(run.report!.coverage.actual, 'homepage');
    assert.equal(run.report!.coverage.captureComplete, true);
    assert.equal(run.report!.coverage.complete, false);
    assert.match(run.report!.summary, /仅首页评测/);
    assert.ok(run.report!.limitations!.some(text => /不代表全站/.test(text)));
    assert.equal(evaluation.needsReview, true);
    assert.ok(run.pipeline!.captures.every(capture => capture.status === 'completed'));
    assert.deepEqual(f.captures, f.keys, 'scope mismatch alone never triggers repeated captures');
  } finally { await f.close(); }
});

test('retrying target can repair a failed reference viewport without recapturing its valid sibling', async () => {
  const f = await fixture();
  let turn = 0;
  try {
    f.failures.add('reference-mobile');
    f.state.complete = async () => ++turn === 1 ? response(...f.captureCalls()) : response([
      'report_blocked', { reason: 'Reference mobile temporarily failed', limitations: [] },
    ]);
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    assert.equal(first.status, 'failed');
    f.failures.clear();
    f.captures.length = 0;
    f.resetTurns();
    f.state.complete = f.normalAgent();
    f.store.rerun(f.id, { mode: 'target', sourceRunId: first.id });
    await f.worker.tick();
    const next = f.store.get(f.id)!.run;
    assert.equal(next.status, 'completed');
    assert.deepEqual(f.captures, ['target-desktop', 'target-mobile', 'reference-mobile']);
    assert.equal(next.pipeline!.captures.find(c => c.role === 'reference' && c.viewport === 'desktop')!.status, 'reused');
    assert.equal(f.store.history(f.id).find(run => run.id === first.id)!.status, 'failed');
  } finally { await f.close(); }
});

test('score retry repairs a lost artifact, but cannot force recapture unrelated valid evidence', async () => {
  const f = await fixture();
  try {
    f.state.complete = f.normalAgent();
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    const lost = first.evidence!.screenshots.find(shot => shot.role === 'target' && shot.viewport === 'desktop')!;
    rmSync(join(f.directory, 'artifacts', f.id, first.id, lost.file));
    f.captures.length = 0;
    f.resetTurns();
    f.state.complete = f.normalAgent();
    f.store.rerun(f.id, { mode: 'score', sourceRunId: first.id });
    await f.worker.tick();
    const repaired = f.store.get(f.id)!.run;
    assert.equal(repaired.status, 'completed');
    assert.deepEqual(f.captures, ['target-desktop']);
    let turn = 0;
    f.captures.length = 0;
    f.state.complete = async (_model, messages) => {
      if (++turn === 1) return response(['capture_page', { role: 'reference', viewport: 'desktop', force: true }]);
      assert.match(f.toolsResults(messages).at(-1).error, /复用该分支的有效证据/);
      return response(['report_blocked', { reason: 'Forced recapture correctly refused', limitations: [] }]);
    };
    f.store.rerun(f.id, { mode: 'score', sourceRunId: repaired.id });
    await f.worker.tick();
    assert.deepEqual(f.captures, []);
  } finally { await f.close(); }
});

test('SOP-only report retry rereads and reviews retained screenshots before replacing the old report', async () => {
  const f = await fixture();
  try {
    f.state.complete = f.normalAgent();
    await f.worker.tick();
    const first = f.store.get(f.id)!.run;
    f.store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(
      JSON.stringify({ ...first.snapshot, sop: { ...first.snapshot!.sop, hash: 'old-agent-sop' } }), first.id,
    );
    f.captures.length = 0;
    f.resetTurns();
    const normal = f.normalAgent();
    let requests = 0;
    f.state.complete = async (...args) => {
      if (++requests === 1) {
        assert.equal(f.input().pipeline.scoredReport, null);
        assert.deepEqual(f.input().pipeline.agent!.reviews, {});
        assert.ok(f.input().pipeline.captures.every(capture => capture.status === 'reused'));
      }
      return normal(...args);
    };
    f.store.rerun(f.id, { mode: 'report', sourceRunId: first.id });
    await f.worker.tick();
    const retried = f.store.get(f.id)!.run;
    assert.equal(retried.status, 'completed');
    assert.equal(requests, 3, 'must revisit image pixels and submit fresh reviews under new SOP');
    assert.deepEqual(f.captures, []);
    assert.ok(retried.evidence!.screenshots.every(shot => shot.sourceRunId === first.id));
    assert.ok(retried.pipeline!.agent!.calls.some(call => call.name === 'read_images'));
    assert.ok(retried.pipeline!.agent!.calls.some(call => call.name === 'submit_review'));
    assert.notEqual(retried.snapshot!.sop!.hash, 'old-agent-sop');
  } finally { await f.close(); }
});
