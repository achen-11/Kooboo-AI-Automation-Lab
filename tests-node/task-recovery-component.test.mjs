import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url), directory = mkdtempSync(join(tmpdir(), 'task-recovery-component-'));
let TaskDetail;
before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({ entryPoints: [resolve('frontend/src/views/automation/TaskDetail.vue')], bundle: true, platform: 'node', format: 'cjs', outfile,
    plugins: [{ name: 'recovery-services', setup(builder) {
      builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
      builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'recovery-test' }));
      builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'recovery-test' }));
      builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'recovery-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'recovery-test' }, args => ({ contents: args.path === 'api'
        ? 'export const api=(...args)=>globalThis.__recoveryServices.request(...args); export const message=e=>e.message; export const formatDate=String; export const go=()=>{}; export const platform={}; export const sessionFetch=async()=>new Response(JSON.stringify({error:"Not Found"}),{status:404,headers:{"content-type":"application/json"}});'
        : args.path === 'common' ? 'export const workspace={settings:{}}; export const scopeName=()=>"全站";'
        : 'export const notify={success:(t)=>globalThis.__recoveryServices.notified?.push({type:"success",text:t}),info:(t)=>globalThis.__recoveryServices.notified?.push({type:"info",text:t})};', loader: 'js' }));
      builder.onLoad({ filter: /\.vue$/ }, args => {
        if (args.path.endsWith('/ExecutionLog.vue')) return { contents: "import {h} from 'vue';export default {emits:['stage-change'],setup:(_, {emit})=>()=>h('button',{'data-stage':true,onClick:()=>emit('stage-change','child')},'选择评测轮次')};", loader: 'js' };
        if (!/\/(TaskDetail|TaskExecution|TaskRecoveryActions|TaskLearning)\.vue$/.test(args.path)) return { contents: "import {h} from 'vue';export default {setup:(_, {slots})=>()=>h('div',slots.default?.())};", loader: 'js' };
        const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
        return { contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts', resolveDir: dirname(args.path) };
      });
    } }],
  });
  TaskDetail = require(outfile).default;
});
after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') { super(); this.tag = tag; this.tagName = tag.toUpperCase(); this.text = text; this.children = []; this.parent = null; this.props = {}; }
  removeAttribute(name) { delete this.props[name]; }
}
const renderer = createRenderer({
  createElement: tag => new HostNode(tag), createText: text => new HostNode('#text', text), createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); await nextTick(); } }
const summary = (id, kind = 'evaluation') => ({ id, kind, resourceId: 'resource', resourceName: 'Car Repair', scenario: 'site-template', scope: 'site', environmentId: '', generatedSiteId: 'site', status: 'interrupted', stopped: false, createdAt: 1, updatedAt: 1, siteUrl: '', report: null, attention: '原评测执行尚未确认停止', nextStep: '确认停止后恢复' });
async function fixture({ pair = false, fail = false, legacy = false, cancelled = false, namingConflict = false, workflowActive = false, windowedFollowup = false, taskStatus, retainActiveOnResume = false } = {}) {
  const previous = new Map(['window', 'document', '__recoveryServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = Object.assign(new EventTarget(), { location: { hash: cancelled ? '#/tasks/root' : '#/tasks/root?tab=execution' }, history: { replaceState() {} } });
  const root = summary('root', pair || cancelled || namingConflict ? 'generation' : 'evaluation'), child = summary('child');
  if (pair) Object.assign(root, { status: 'completed', stopped: true, attention: '', evaluationTaskId: child.id });
  if (cancelled) Object.assign(root, { generatedSiteId: null, status: 'cancelled', stopped: true, attention: '', nextStep: '' });
  if (namingConflict) Object.assign(root, { generatedSiteId: null, stopped: true, canAdjustSiteNames: true, attention: '自定义站点名或子域名已被占用' });
  if (workflowActive) Object.assign(root, { stopped: true, attention: 'AI 跟进已达到配置的次数、时间或 token 预算，当前流程仍未完成。' });
  if (taskStatus) Object.assign(root, { status: taskStatus, stopped: !['running', 'cancelling'].includes(taskStatus), attention: '', nextStep: '' });
  let activeBlocker = workflowActive ? { tasks: 0, learning: 1, reason: '同工作流仍有活动执行（1 个经验学习执行中），请等待全部停止或强制中断后恢复' }
    : taskStatus ? { tasks: 1, learning: 0, reason: '同工作流仍有活动执行（1 个任务未停止），请等待全部停止或强制中断后恢复' } : undefined;
  const learningItems = workflowActive ? [{ id: 'learn-1', taskId: 'root', workflowId: 'root', phase: 'followup', kind: 'reflection', key: 'k1', status: 'running', policy: {}, createdAt: 1, updatedAt: 1, threadId: '', reason: '执行中', adoptions: [], produced: [], budgetId: 'experience:root' }] : [];
  const calls = [], notified = [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body });
    if (options.method === 'POST') {
      if (path === '/automation/learning/learn-1/cancel') {
        learningItems[0].status = 'failed';
        learningItems[0].reason = '模型服务拒绝请求（HTTP 402）';
        activeBlocker = undefined;
        return { run: structuredClone(learningItems[0]), alreadyStopped: true };
      }
      if (fail) throw Error('执行器仍有占用');
      const task = path.includes('/child/') ? child : root;
      if (path.endsWith('/confirm-stopped')) task.stopped = true;
      if (path.endsWith('/resume')) {
        const parsed = options.body ? JSON.parse(options.body) : {};
        if (activeBlocker && !parsed.force) throw Error(activeBlocker.reason);
        activeBlocker = retainActiveOnResume ? { tasks: 1, learning: 0, reason: '同工作流仍有活动执行（1 个任务未停止），请等待全部停止或强制中断后恢复' } : undefined;
        for (const item of learningItems) if (['running', 'queued'].includes(item.status)) item.status = 'failed';
        task.status = 'queued'; task.attention = '';
      }
      if (path.endsWith('/adjust-site-names')) { task.status = 'queued'; task.attention = ''; task.canAdjustSiteNames = false; }
      task.updatedAt++;
      return structuredClone(task);
    }
    if (path.includes('/learning?')) return structuredClone({ items: learningItems, page: 1, pages: 1, total: learningItems.length });
    if (path.endsWith('/summary')) return structuredClone({ task: path.includes('/child/') ? child : root, evaluation: pair ? child : null, active: null, deliveryEnabled: false, latest: null, ...(activeBlocker ? { workflowActive: activeBlocker } : {}) });
    if (path.includes('/sections/execution')) {
      const task = path.includes('taskId=child') ? child : root;
      const followup = windowedFollowup ? { state: 'interrupted', attempts: 6, elapsedMs: 42000, startedAt: 1, nextAt: 1, tokens: 500, threadId: 't-1', executionStopped: true, observations: [], policy: { enabled: true, maxAttempts: 5, maxMinutes: 20, maxTokens: 10000000, maxRequests: 80, concurrency: 1, sop: 'sop' }, window: { index: 1, startedAt: 2, attemptsBase: 5, tokensBase: 400, elapsedMsBase: 36000 } } : undefined;
      return structuredClone({ task: legacy ? undefined : { id: task.id, status: task.status, stopped: task.stopped, canAdjustSiteNames: task.canAdjustSiteNames }, context: '', error: '', followup, interruption: task.status === 'interrupted' ? { reason: task.attention, nextSteps: ['先确认停止再恢复'], resumeFrom: '保留证据', attempted: [] } : undefined });
    }
    throw Error(`Unexpected request ${path}`);
  };
  for (const [key, value] of Object.entries({ window, document, __recoveryServices: { request, notified } })) Object.defineProperty(globalThis, key, { value, configurable: true });
  const container = new HostNode('root'), app = renderer.createApp({ render: () => h(TaskDetail, { id: root.id }) });
  app.mount(container); await settle();
  return { calls, notified, root, child, text: () => text(container), nodes: () => descendants(container),
    buttons: label => descendants(container).filter(n => n.tag === 'button' && text(n) === label),
    close() { app.unmount(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } },
  };
}

test('direct execution links expose stop confirmation in both header and interruption details, then recovery', async () => {
  const f = await fixture();
  try {
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    assert.equal(f.buttons('恢复任务').length, 0);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/root/confirm-stopped']);
    assert.equal(f.buttons('已检查并确认原执行停止').length, 0);
    assert.equal(f.buttons('恢复任务').length, 2);
    await f.buttons('恢复任务')[1].props.onClick(); await settle();
    assert.equal(f.calls.filter(c => c.method === 'POST').at(-1).path, '/automation/tasks/root/resume');
    assert.equal(f.buttons('恢复任务').length, 0, 'historical interruption must not leave an actionable recovery button');
  } finally { f.close(); }
});

test('confirmation is available across tabs and a selected evaluation uses its own task identity', async () => {
  const f = await fixture({ pair: true });
  try {
    assert.equal(f.buttons('已检查并确认原执行停止').length, 1, 'header operates on the interrupted evaluation');
    f.nodes().find(n => n.props['data-stage']).props.onClick(); await settle();
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/child/confirm-stopped']);
    assert.equal(f.root.status, 'completed');
    f.buttons('输入与配置')[0].props.onClick(); await settle();
    assert.equal(f.buttons('恢复任务').length, 1, 'shared header remains available outside Overview');
  } finally { f.close(); }
});

test('rejected confirmation keeps the action available and displays the server error without resuming', async () => {
  const f = await fixture({ fail: true });
  try {
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.ok(f.text().includes('执行器仍有占用'));
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    assert.equal(f.buttons('恢复任务').length, 0);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  } finally { f.close(); }
});

test('an older running server supports selected-round recovery through compact task metadata', async () => {
  const f = await fixture({ pair: true, legacy: true });
  try {
    f.nodes().find(n => n.props['data-stage']).props.onClick(); await settle();
    assert.ok(f.calls.some(c => c.path === '/automation/tasks/child/summary'));
    assert.equal(f.buttons('已检查并确认原执行停止').length, 2);
    await f.buttons('已检查并确认原执行停止')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/automation/tasks/child/confirm-stopped']);
    assert.equal(f.buttons('恢复任务').length, 2);
  } finally { f.close(); }
});

test('cancelled tasks expose restart button in header and execution tab and queue via resume', async () => {
  const f = await fixture({ cancelled: true });
  try {
    assert.equal(f.buttons('重新启动').length, 1, 'header exposes restart on Overview');
    await f.buttons('执行记录')[0].props.onClick(); await settle();
    assert.equal(f.buttons('重新启动').length, 2, 'both header and execution panel expose restart');
    assert.ok(f.text().includes('任务已取消'));
    await f.buttons('重新启动')[0].props.onClick(); await settle();
    assert.equal(f.calls.filter(c => c.method === 'POST').at(-1).path, '/automation/tasks/root/resume');
    assert.equal(f.buttons('重新启动').length, 0);
  } finally { f.close(); }
});

test('naming conflicts expose a dedicated action and continue the original task through its naming endpoint', async () => {
  const f = await fixture({ namingConflict: true });
  try {
    assert.equal(f.buttons('自动调整名称并继续').length, 2); assert.equal(f.buttons('恢复任务').length, 0);
    await f.buttons('自动调整名称并继续')[1].props.onClick(); await settle();
    assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.path), ['/automation/tasks/root/adjust-site-names']);
    assert.equal(f.root.status, 'queued'); assert.equal(f.buttons('自动调整名称并继续').length, 0);
  } finally { f.close(); }
});

test('a failed naming adjustment leaves the action available and shows the error', async () => {
  const f = await fixture({ namingConflict: true, fail: true });
  try {
    await f.buttons('自动调整名称并继续')[0].props.onClick(); await settle();
    assert.ok(f.text().includes('执行器仍有占用')); assert.equal(f.buttons('自动调整名称并继续').length, 2);
    assert.equal(f.root.status, 'interrupted');
  } finally { f.close(); }
});

test('active workflow learning upgrades primary recovery buttons in header and execution panel to force-resume and displays current followup window counters', async () => {
  const f = await fixture({ workflowActive: true, windowedFollowup: true });
  try {
    assert.equal(f.buttons('恢复任务').length, 0, 'must not show a guaranteed-to-409 normal resume button while workflowActive is true');
    assert.ok(f.buttons('强制中断并恢复').length >= 3, 'header, banner, and interruption panel all expose force-resume');
    assert.ok(f.text().includes('本轮 1 / 5 次（累计 6 次）'));
    assert.ok(f.text().includes('本轮执行 6 秒 / 20 分钟预算（累计 42 秒）'));
    // Clicking the primary header button directly sends force: true and clears the blocker:
    await f.buttons('强制中断并恢复')[0].props.onClick(); await settle();
    const post = f.calls.find(c => c.method === 'POST');
    assert.equal(post.path, '/automation/tasks/root/resume');
    assert.deepEqual(JSON.parse(post.body), { force: true });
    assert.equal(f.root.status, 'queued');
    assert.equal(f.buttons('强制中断并恢复').length, 0);
  } finally { f.close(); }
});

test('cancelling a just-finished learning run in TaskLearning shows info instead of 409 error and immediately clears TaskDetail workflowActive banner', async () => {
  const f = await fixture({ workflowActive: true });
  try {
    assert.equal(f.buttons('强制中断').length, 1);
    assert.ok(f.text().includes('同工作流仍有活动执行'));
    await f.buttons('强制中断')[0].props.onClick(); await settle();
    assert.ok(!f.text().includes('只能中断排队中或执行中的经验学习'));
    assert.ok(!f.text().includes('同工作流仍有活动执行'));
    assert.deepEqual(f.notified, [{ type: 'info', text: '该经验学习已结束' }]);
    assert.equal(f.buttons('强制中断').length, 0);
    assert.equal(f.buttons('恢复任务').length, 2, 'once learning finishes, primary buttons return to normal resume');
  } finally { f.close(); }
});

test('normal task activity never displays a recovery blocker banner or force-resume action', async () => {
  for (const status of ['queued', 'running', 'following-up', 'cancelling', 'completed']) {
    const f = await fixture({ taskStatus: status });
    try {
      assert.ok(!f.text().includes('同工作流仍有活动执行'), `${status} is normal task activity, not a recovery error`);
      assert.equal(f.buttons('强制中断并恢复').length, 0);
      if (['queued', 'running', 'following-up'].includes(status)) assert.equal(f.buttons('取消任务').length, 1);
      f.buttons('概览')[0].props.onClick(); await settle();
      assert.ok(!f.text().includes('同工作流仍有活动执行'));
      assert.equal(f.buttons('强制中断并恢复').length, 0);
      assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
    } finally { f.close(); }
  }
  const f = await fixture({ taskStatus: 'completed', workflowActive: true });
  try {
    assert.ok(!f.text().includes('同工作流仍有活动执行'), 'background reflection after completion does not imply the task must recover');
    assert.equal(f.buttons('强制中断并恢复').length, 0);
  } finally { f.close(); }
});

test('successful recovery removes the blocker warning even while the resumed task is reported active', async () => {
  const f = await fixture({ workflowActive: true, retainActiveOnResume: true });
  try {
    assert.ok(f.text().includes('同工作流仍有活动执行'));
    await f.buttons('强制中断并恢复')[0].props.onClick(); await settle();
    assert.equal(f.root.status, 'queued');
    assert.ok(!f.text().includes('同工作流仍有活动执行'), 'resumed work must not be shown as another recovery failure');
    assert.equal(f.buttons('强制中断并恢复').length, 0);
    assert.equal(f.buttons('取消任务').length, 1);
    assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  } finally { f.close(); }
});
