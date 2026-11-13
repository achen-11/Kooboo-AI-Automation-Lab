import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { createRenderer, h, nextTick } from 'vue';

const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'live-comparison-component-'));
let TaskDetail;
let TaskReport;
let SiteReports;

before(async () => {
  const outfile = join(directory, 'component.cjs');
  await build({
    entryPoints: [resolve('frontend/src/views/automation/TaskDetail.vue')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins: [{
      name: 'live-comparison-services',
      setup(builder) {
        builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
        builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'live-test' }));
        builder.onResolve({ filter: /\/notifications$/ }, () => ({ path: 'notifications', namespace: 'live-test' }));
        builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'live-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'live-test' }, args => ({
          contents: args.path === 'api'
            ? 'export const api=(...args)=>globalThis.__liveServices.request(...args); export const message=e=>e.message; export const formatDate=String; export const go=()=>{}; export const platform={}; export const sessionFetch=async()=>new Response(JSON.stringify({error:"Not Found"}),{status:404,headers:{"content-type":"application/json"}});'
            : args.path === 'common'
              ? 'export const workspace={settings:{}}; export const scopeName=()=>"全站";'
              : 'export const notify={success:()=>{}};',
          loader: 'js',
        }));
        builder.onLoad({ filter: /\.vue$/ }, args => {
          if (args.path.endsWith('/LiveSiteFrame.vue')) {
            return {
              contents: `import {h} from 'vue';
                export default {
                  props: ['url', 'title', 'width'],
                  setup: props => () => h('iframe', { 'data-live-frame': true, src: props.url, title: props.title, width: props.width })
                };`,
              loader: 'js',
            };
          }
          if (!/\/(TaskDetail|TaskReport|SiteReports|LiveSiteComparisonDialog)\.vue$/.test(args.path)) {
            return { contents: "import {h} from 'vue';export default {setup:(_, {slots})=>()=>h('div',slots.default?.())};", loader: 'js' };
          }
          const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
          return {
            contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
            loader: 'ts',
            resolveDir: dirname(args.path),
          };
        });
      },
    }],
  });
  TaskDetail = require(outfile).default;

  for (const [name, relPath] of [['report', 'frontend/src/views/automation/TaskReport.vue'], ['siteReports', 'frontend/src/views/automation/SiteReports.vue']]) {
    const out = join(directory, `${name}.cjs`);
    await build({
      entryPoints: [resolve(relPath)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: out,
      plugins: [{
        name: `live-${name}`,
        setup(builder) {
          builder.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve('vue'), external: true }));
          builder.onResolve({ filter: /\/api$/ }, () => ({ path: 'api', namespace: 'live-test' }));
          builder.onResolve({ filter: /^\.\/common$/ }, () => ({ path: 'common', namespace: 'live-test' }));
          builder.onLoad({ filter: /.*/, namespace: 'live-test' }, args => ({
            contents: args.path === 'api'
              ? 'export const api=(...args)=>globalThis.__liveServices.request(...args); export const message=e=>e.message; export const formatDate=String; export const go=()=>{};'
              : 'export const workspace={settings:{}}; export const scopeName=()=>"全站";',
            loader: 'js',
          }));
          builder.onLoad({ filter: /\.vue$/ }, args => {
            if (args.path.endsWith('/LiveSiteFrame.vue')) {
              return {
                contents: `import {h} from 'vue';export default {props:['url','title','width'],setup:props=>()=>h('iframe',{src:props.url,title:props.title,width:props.width})};`,
                loader: 'js',
              };
            }
            if (!/\/(TaskReport|SiteReports|LiveSiteComparisonDialog)\.vue$/.test(args.path)) {
              return { contents: "import {h} from 'vue';export default {setup:(_, {slots})=>()=>h('div',slots.default?.())};", loader: 'js' };
            }
            const { descriptor } = parse(readFileSync(args.path, 'utf8'), { filename: args.path });
            return {
              contents: compileScript(descriptor, { id: args.path, inlineTemplate: true }).content,
              loader: 'ts',
              resolveDir: dirname(args.path),
            };
          });
        },
      }],
    });
    if (name === 'report') TaskReport = require(out).default;
    else SiteReports = require(out).default;
  }
});

after(() => rmSync(directory, { recursive: true, force: true }));

class HostNode extends EventTarget {
  constructor(tag, text = '') {
    super();
    this.tag = tag;
    this.tagName = tag.toUpperCase();
    this.text = text;
    this.children = [];
    this.parent = null;
    this.props = {};
    this.open = false;
  }
  removeAttribute(name) { delete this.props[name]; }
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.props.onClose?.(new Event('close'));
  }
  querySelectorAll() { return []; }
  scrollTo() {}
}

const renderer = createRenderer({
  createElement: tag => new HostNode(tag),
  createText: text => new HostNode('#text', text),
  createComment: text => new HostNode('#comment', text),
  insert(node, parent, anchor = null) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = parent;
    const index = parent.children.indexOf(anchor);
    parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = null;
  },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  parentNode: node => node?.parent || null,
  nextSibling: node => (node?.parent ? node.parent.children[node.parent.children.indexOf(node) + 1] || null : null),
  querySelector: sel => globalThis.document?.querySelector?.(sel) || null,
  patchProp(node, key, _previous, value) { node.props[key] = value; },
});

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const text = node => ((node.tag === '#comment' ? '' : node.text) + node.children.map(text).join('')).trim();
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
    await nextTick();
  }
}

async function mountTaskDetail({ canCompareLive = true, payload }) {
  const previous = new Map(['window', 'document', '__liveServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const body = new HostNode('body');
  body.style = { overflow: '' };
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    body,
    querySelector: sel => (sel === 'body' ? body : null),
  });
  const window = Object.assign(new EventTarget(), {
    location: { hash: '#/tasks/task-1' },
    history: { replaceState() {} },
  });
  const calls = [];
  const request = async path => {
    calls.push(path);
    if (path.endsWith('/summary')) {
      return structuredClone({
        task: {
          id: 'task-1',
          kind: 'generation',
          resourceId: 'res-1',
          resourceName: 'Horizone Template',
          scenario: 'site-template',
          scope: 'site',
          environmentId: 'env-1',
          generatedSiteId: 'site-1',
          status: 'completed',
          stopped: true,
          createdAt: 1,
          updatedAt: 1,
          siteUrl: 'https://generated.kooboo.io/',
          report: null,
          attention: '',
          nextStep: '',
        },
        evaluation: null,
        active: null,
        currentReportId: 'eval-1',
        deliveryEnabled: false,
        canCompareLive,
        latest: null,
      });
    }
    if (path.includes('/live-comparison')) {
      return structuredClone(payload);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  for (const [key, value] of Object.entries({ window, document, __liveServices: { request } })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const container = new HostNode('root');
  const app = renderer.createApp({ render: () => h(TaskDetail, { id: 'task-1' }) });
  app.mount(container);
  await settle();

  const allNodes = () => [...descendants(container), ...descendants(body)];
  return {
    calls,
    body,
    text: () => [text(container), text(body)].join(' '),
    iframes: () => allNodes().filter(n => n.tag === 'iframe'),
    images: () => allNodes().filter(n => n.tag === 'img'),
    dialogs: () => allNodes().filter(n => n.tag === 'dialog'),
    buttons: label => allNodes().filter(n => n.tag === 'button' && text(n) === label),
    links: label => allNodes().filter(n => n.tag === 'a' && text(n) === label),
    close() {
      app.unmount();
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else delete globalThis[key];
      }
    },
  };
}

test('Framer embeddable reference and Kooboo target render dual live iframes, switch viewports, and unmount on close', async () => {
  const f = await mountTaskDetail({
    payload: {
      taskId: 'task-1',
      resourceName: 'Horizone Template',
      scenario: 'site-template',
      referenceUrl: '',
      contentUrl: 'https://horizone-visuvate.framer.website/',
      targetUrl: 'https://generated.kooboo.io/',
      sources: [{ key: 'reference', label: '参考站', url: 'https://horizone-visuvate.framer.website/', screenshotRoles: ['reference', 'content'] }],
      embedChecks: {
        'https://horizone-visuvate.framer.website/': { url: 'https://horizone-visuvate.framer.website/', status: 'allowed', embeddable: true, checkedAt: 1 },
        'https://generated.kooboo.io/': { url: 'https://generated.kooboo.io/', status: 'allowed', embeddable: true, checkedAt: 1 },
      },
      fallbackScreenshots: { reportTaskId: null, historical: false, items: [] },
    },
  });
  try {
    assert.equal(f.iframes().length, 0, 'iframes are not mounted before opening dialog');
    assert.equal(f.buttons('实时对比').length, 1);

    await f.buttons('实时对比')[0].props.onClick();
    await settle();

    assert.ok(f.calls.some(path => path === '/automation/tasks/task-1/live-comparison?reportId=eval-1'));
    assert.equal(f.body.style.overflow, 'hidden');
    assert.equal(f.iframes().length, 2);
    assert.equal(f.iframes()[0].props.src, 'https://horizone-visuvate.framer.website/');
    assert.equal(f.iframes()[0].props.width, 1440);
    assert.equal(f.iframes()[1].props.src, 'https://generated.kooboo.io/');
    assert.equal(f.iframes()[1].props.width, 1440);

    // Switch to mobile 390px viewport
    await f.buttons('移动 390px')[0].props.onClick();
    await settle();
    assert.equal(f.iframes()[0].props.width, 390);
    assert.equal(f.iframes()[1].props.width, 390);

    // Close dialog -> iframes unmount and body overflow unlocks
    const closeBtn = f.dialogs().find(d => d.props.class === 'live-comparison-dialog');
    closeBtn.close();
    await settle();
    assert.equal(f.iframes().length, 0);
    assert.equal(f.body.style.overflow, '');
  } finally {
    f.close();
  }
});

test('blocked Webflow reference automatically falls back to same-viewport screenshots while keeping live Kooboo iframe, and supports Reference/Content toggle', async () => {
  const f = await mountTaskDetail({
    payload: {
      taskId: 'task-1',
      resourceName: 'Orthofex Upgrade',
      scenario: 'upgrade',
      referenceUrl: 'https://car-dealership-128.webflow.io/',
      contentUrl: 'https://www.orthofex.nl/',
      targetUrl: 'https://orthofex_gen.kooboo.io/',
      sources: [
        { key: 'reference', label: '参考站', url: 'https://car-dealership-128.webflow.io/', screenshotRoles: ['reference'] },
        { key: 'content', label: '内容站', url: 'https://www.orthofex.nl/', screenshotRoles: ['content'] },
      ],
      embedChecks: {
        'https://car-dealership-128.webflow.io/': {
          url: 'https://car-dealership-128.webflow.io/',
          status: 'blocked',
          embeddable: false,
          reason: '该站点设置了 CSP frame-ancestors 安全策略，禁止在当前平台通过 iframe 嵌入。',
          checkedAt: 1,
        },
        'https://www.orthofex.nl/': { url: 'https://www.orthofex.nl/', status: 'allowed', embeddable: true, checkedAt: 1 },
        'https://orthofex_gen.kooboo.io/': { url: 'https://orthofex_gen.kooboo.io/', status: 'allowed', embeddable: true, checkedAt: 1 },
      },
      fallbackScreenshots: {
        reportTaskId: 'eval-1',
        historical: false,
        items: [
          { id: '1', name: 'ref-desk.png', type: 'image/png', size: 100, sha256: 'a'.repeat(64), role: 'reference', viewport: 'desktop' },
        ],
      },
    },
  });
  try {
    await f.buttons('实时对比')[0].props.onClick();
    await settle();

    // Left is blocked Webflow -> falls back to desktop screenshot; right remains live Kooboo iframe
    assert.equal(f.iframes().length, 1);
    assert.equal(f.iframes()[0].props.src, 'https://orthofex_gen.kooboo.io/');
    assert.equal(f.images().length, 1);
    assert.equal(f.images()[0].props.src, '/api/v1/automation/reports/eval-1/artifacts/ref-desk.png');
    assert.ok(f.text().includes('禁止第三方 iframe 嵌入'));

    // Switch to mobile where no screenshots were captured -> shows explicit blocked state + switch-viewport button + external link
    await f.buttons('移动 390px')[0].props.onClick();
    await settle();
    assert.equal(f.images().length, 0);
    assert.ok(f.text().includes('CSP frame-ancestors'));
    assert.equal(f.links('新窗口打开参考站').length, 1);

    // Switch left source from 参考站 (blocked Webflow) to 内容站 (embeddable customer site)
    await f.buttons('内容站')[0].props.onClick();
    await settle();
    assert.equal(f.iframes().length, 2);
    assert.equal(f.iframes()[0].props.src, 'https://www.orthofex.nl/');
    assert.equal(f.iframes()[1].props.src, 'https://orthofex_gen.kooboo.io/');
  } finally {
    f.close();
  }
});

test('header hides live comparison button when task has neither source nor generated site URLs', async () => {
  const f = await mountTaskDetail({
    canCompareLive: false,
    payload: null,
  });
  try {
    assert.equal(f.buttons('实时对比').length, 0);
  } finally {
    f.close();
  }
});

test('TaskReport and SiteReports expose live site comparison entry points bound to the viewed report', async () => {
  const previous = new Map(['window', 'document', '__liveServices'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const body = new HostNode('body');
  body.style = { overflow: '' };
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    body,
    querySelector: sel => (sel === 'body' ? body : null),
  });
  const window = Object.assign(new EventTarget(), {
    location: { hash: '#/tasks/gen-1?tab=report&view=history' },
    history: { replaceState() {} },
  });
  const calls = [];
  const comparisonPayload = {
    taskId: 'gen-1',
    resourceName: 'Washioo',
    scenario: 'site-template',
    referenceUrl: '',
    contentUrl: 'https://washioo.framer.website/',
    targetUrl: 'https://washioo_gen.kooboo.io/',
    sources: [{ key: 'reference', label: '参考站', url: 'https://washioo.framer.website/', screenshotRoles: ['reference', 'content'] }],
    embedChecks: {
      'https://washioo.framer.website/': { url: 'https://washioo.framer.website/', status: 'allowed', embeddable: true, checkedAt: 1 },
      'https://washioo_gen.kooboo.io/': { url: 'https://washioo_gen.kooboo.io/', status: 'allowed', embeddable: true, checkedAt: 1 },
    },
    fallbackScreenshots: { reportTaskId: 'eval-99', historical: false, items: [] },
  };
  const request = async path => {
    calls.push(path);
    if (path.startsWith('/automation/site-deliveries/site-1/reports?')) {
      return {
        currentReportId: 'eval-99',
        scope: 'site',
        targetScore: 85,
        items: [],
        total: 0,
        pages: 1,
        page: 1,
        pageSize: 10,
      };
    }
    if (path === '/automation/tasks/gen-1/sections/report') {
      return {
        taskId: 'eval-99',
        report: {
          summary: 'All good',
          quality: 'passed',
          scores: [{ viewport: 'desktop', value: 92 }],
          assessments: [],
          issues: [],
          coverage: { verified: [], unverified: [], outOfScope: [] },
          artifacts: [],
        },
        rule: null,
      };
    }
    if (path.includes('/live-comparison')) return structuredClone(comparisonPayload);
    throw new Error(`Unexpected request: ${path}`);
  };
  for (const [key, value] of Object.entries({ window, document, __liveServices: { request } })) {
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }

  const container1 = new HostNode('root');
  const app1 = renderer.createApp({
    render: () => h(SiteReports, { taskId: 'gen-1', siteId: 'site-1', taskKind: 'generation', revision: '1', detailRevision: '1' }),
  });
  const container2 = new HostNode('root');
  const app2 = renderer.createApp({
    render: () => h(TaskReport, { taskId: 'gen-1', revision: '1' }),
  });

  try {
    app1.mount(container1);
    await settle();
    const siteButtons = descendants(container1).filter(n => n.tag === 'button' && text(n) === '实时站点对比');
    assert.equal(siteButtons.length, 1);
    await siteButtons[0].props.onClick();
    await settle();
    assert.ok(calls.includes('/automation/tasks/gen-1/live-comparison?reportId=eval-99'));
    descendants(body).find(n => n.tag === 'dialog')?.close();
    await settle();

    calls.length = 0;
    app2.mount(container2);
    await settle();
    const reportButtons = descendants(container2).filter(n => n.tag === 'button' && text(n) === '实时站点对比');
    assert.equal(reportButtons.length, 1);
    await reportButtons[0].props.onClick();
    await settle();
    assert.ok(calls.includes('/automation/tasks/gen-1/live-comparison?reportId=eval-99'));
  } finally {
    app1.unmount();
    app2.unmount();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else delete globalThis[key];
    }
  }
});
