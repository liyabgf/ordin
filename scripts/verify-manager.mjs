import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await realpath('/tmp');
const reportDir = await mkdtemp(join(temp, 'ordin-manager-report-'));
const reportPath = join(reportDir, 'manager-report.json');
const report = { checks: [], errors: [], model: [], browserRequests: [], screenshots: [], ports: {}, cleanup: {} };
const ports = report.ports;
const forbidden = [3080, 7471];
const key = 'manager-synthetic-model-key';
const modelName = 'manager-loopback-fixture';
const title = 'Manager synthetic task';
const assetQuery = 'Manager fixture Alpha';
const assetText = 'A雪B MANAGER_ASSET_BODY_ONLY';
const skillText = '# MANAGER_MANUAL_SKILL_BODY_ONLY';
const createPrompt = '请创建任务，整理一份测试目录。';
const readsPrompt = '请查找测试资产、运行状态和手工保存的技能。';
const ordinaryPrompt = '请聊聊已选资产，只讨论其用途。';
const recipesPrompt = '请按总管配方对比测试资产，核对任务和执行端，并说明如何补材料。';
const reply = { create: 'MANAGER_CREATED', reads: 'MANAGER_READS_COMPLETE', ordinary: 'MANAGER_DISCUSSION_ONLY', attach: 'MANAGER_ATTACHMENT_RECEIPT', recipes: 'MANAGER_RECIPES_COMPLETE' };
const json = JSON.stringify;
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
let stateDir, profile, booted, runtime, model, chrome, chromeExited, chromeExit, ws, cdp, panel;
let alpha, beta, skill, ticketId;
let probes = 0;
const stamps = new Map();
const browserPosts = [];
const expectedFixtureFiles = [
  'scripts/verify-manager.mjs', 'panel/chat.html', 'src/app/runtime.ts', 'src/app/coordinator.ts',
  'src/app/http.ts', 'src/app/asset-catalog.ts', 'src/app/manager-asset-reads.ts',
  'src/app/manager-health.ts', 'src/app/asset-inputs.ts', 'src/app/prompts.ts', 'src/app/executor.ts',
  'src/app/manager-artifact-reader.ts', 'src/app/manager-recipes.ts', 'src/app/tool-registry.ts',
];

async function until(label, check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await pause(60);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}

async function check(scope, name, action) {
  try {
    const detail = await action();
    report.checks.push({ scope, name, status: 'pass', detail });
    return detail;
  } catch (error) {
    report.checks.push({ scope, name, status: 'fail' });
    report.errors.push({ scope, name, detail: String(error.stack ?? error) });
    throw error;
  }
}

function safePort(port) {
  assert(Number.isSafeInteger(port) && port > 0 && !forbidden.includes(port), 'Unexpected loopback port ' + port);
  return port;
}

const pin = ({ id, revision, contentHash }) => ({ id, revision, contentHash });
const skillPin = ({ name, revision, contentHash }) => ({ name, revision, contentHash });
const attachPrompt = () => '把所选资产添加到任务 ' + ticketId;
const offeredAttach = 'attach_asset_to_task';

function planModel(body) {
  const userIndex = body.messages.findLastIndex(m => m.role === 'user');
  const user = body.messages[userIndex]?.content;
  const tools = body.tools.map(tool => tool.function.name);
  const outcomes = body.messages.slice(userIndex + 1).filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  const outcome = (name, ok = true) => {
    const value = outcomes.find(item => item.name === name);
    assert.equal(value?.ok, ok, json({ name, outcomes }));
    return value;
  };
  const invoke = (...calls) => ({ calls });
  const answer = kind => ({ content: reply[kind] });
  assert.equal(tools.includes(offeredAttach), user === attachPrompt(), 'Attachment tool visibility');
  switch (user) {
    case createPrompt:
      if (!outcomes.length) return invoke(['create_task', { title, text: '整理测试目录', backend: 'dsh' }]);
      assert.match(outcome('create_task').data.ticketId, /^[a-zA-Z0-9_-]+$/);
      return answer('create');
    case readsPrompt:
      if (!outcomes.length) {
        const context = body.messages[0].content;
        assert(!context.includes(skillText) && !context.includes(assetText));
        return invoke(['asset_search', { query: assetQuery }], ['inspect_runtime', {}], ['skill_search', { query: 'manager-browser-manual' }]);
      }
      if (outcomes.length === 3) {
        const search = outcome('asset_search').data;
        assert.deepEqual(search.assets.map(asset => asset.ref), [alpha]);
        assert(!json(search).includes(assetText));
        const health = outcome('inspect_runtime').data;
        assert.equal(health.backend, 'dsh');
        assert.equal(health.configuration, 'configured');
        assert.equal(health.probe.state, 'passed');
        assert.equal(health.probe.freshness, 'fresh');
        assert.equal(health.taskEvidence, 'recent-task-receipt');
        assert(health.taskReceipts.some(item => item.ticketId === ticketId && item.assignmentState === 'running'));
        assert(!json(health).includes('manager-synthetic-worker'));
        const skills = outcome('skill_search').data.skills;
        assert.deepEqual(skills.map(skillPin), [skill]);
        assert(!json(skills).includes(skillText));
        return invoke(['asset_get', { id: search.assets[0].id }], ['skill_get', skillPin(skills[0])], ['asset_revisions', { id: alpha.id }]);
      }
      if (outcomes.length === 6) {
        const asset = outcome('asset_get').data.asset;
        assert.deepEqual(asset.ref, alpha);
        assert.equal(asset.contentAccess, 'bounded-sample');
        assert(!json(asset).includes(assetText));
        assert.deepEqual(outcome('asset_revisions').data.revisions.map(item => item.ref), [alpha]);
        const saved = outcome('skill_get').data;
        assert.deepEqual(skillPin(saved), skill);
        assert.equal(saved.content, skillText);
        assert.equal(saved.untrustedContent, true);
        return invoke(['asset_read_sample', { ...asset.ref, maxBytes: 3 }], ['asset_relations', { id: alpha.id }]);
      }
      assert.equal(outcomes.length, 8);
      assert.deepEqual(outcome('asset_read_sample').data, { ref: alpha, sample: 'A', bytesReturned: 1, truncated: true, untrustedContent: true });
      assert.deepEqual(outcome('asset_relations').data.references, []);
      return answer('reads');
    case ordinaryPrompt:
    case attachPrompt(): {
      if (user === attachPrompt()) assert(!tools.includes('create_task'), 'Explicit attachment must not expose create_task');
      if (!outcomes.length) return invoke([offeredAttach, { ticketId }]);
      assert.equal(outcomes.length, 1);
      outcome(offeredAttach, user !== ordinaryPrompt);
      return answer(user === ordinaryPrompt ? 'ordinary' : 'attach');
    }
    case recipesPrompt: {
      const expected = ['compare-assets', 'attach-task-materials', 'diagnose-execution'];
      if (!outcomes.length) return invoke(['recipe_list', {}]);
      const recipes = outcome('recipe_list').data.recipes;
      assert.deepEqual(recipes.map(recipe => recipe.id), expected);
      const recipeOutcomes = outcomes.filter(item => item.name === 'recipe_get');
      if (!recipeOutcomes.length) return invoke(...recipes.map(({ id, revision, contentHash }) => ['recipe_get', { id, revision, contentHash }]));
      assert.deepEqual(recipeOutcomes.map(item => [item.ok, item.data.recipe.id]), expected.map(id => [true, id]));
      assert(recipeOutcomes[1].data.recipe.requiredTools.includes(offeredAttach));
      assert(!tools.includes(offeredAttach));
      if (outcomes.length === 4) return invoke(['asset_read_sample', alpha], ['asset_read_sample', beta], ['get_task_status', { ticketId }], ['inspect_runtime', {}]);
      assert.deepEqual(outcomes.filter(item => item.name === 'asset_read_sample').map(item => item.data.ref), [alpha, beta]);
      assert.equal(outcome('get_task_status').data.id, ticketId);
      assert.equal(outcome('inspect_runtime').data.backend, 'dsh');
      return answer('recipes');
    }
    default: throw new Error('Unexpected fixture prompt: ' + json(user));
  }
}

async function startModel() {
  model = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, 'Bearer ' + key);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, modelName);
      assert.equal(body.stream, true);
      const planned = planModel(body);
      const turnIndex = report.model.length;
      report.model.push({ action: planned.calls?.map(([name]) => name) ?? planned.content });
      const delta = planned.calls ? { tool_calls: planned.calls.map(([name, args], index) => ({
        index, id: 'manager-' + turnIndex + '-' + index, type: 'function', function: { name, arguments: json(args) },
      })) } : { content: planned.content };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + json({ choices: [{ delta, finish_reason: planned.calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      report.errors.push({ scope: 'fixture', name: 'controlled model contract', detail: String(error.stack ?? error) });
      response.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    model.once('error', reject);
    model.listen(0, '127.0.0.1', resolve);
  });
  ports.model = safePort(model.address().port);
}

async function startRuntime() {
  const modules = ['app/boot', 'app/config', 'app/runtime', 'app/process', 'app/logger', 'drivers/channel', 'app/worker-connections', 'drivers/router'];
  const [{ boot }, { resolveConfig }, { createRuntime }, { ProcessRegistry }, { silentLogger }, { TurnChannel }, { WorkerConnections }, { DriverRouter }] =
    await Promise.all(modules.map(path => import(new URL('../src/' + path + '.ts', import.meta.url))));
  // Keep the assignment open and assets queued deterministically. No external worker runs.
  const launch = async spec => {
    const queue = new TurnChannel();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    queue.push({ kind: 'started', at: now(), session: { backend: 'dsh', id: 'manager-' + spec.ticketId, cwd: spec.cwd, savedAt: now() } });
    return { id: spec.assignmentId, backend: 'dsh', events: queue.iterable, done,
      feed: async () => ({ status: 'unsupported', reason: 'fixture keeps attachments queued' }),
      cancel: async () => {
        const result = { status: 'cancelled', text: 'fixture teardown' };
        queue.push({ kind: 'final', at: now(), result });
        queue.close();
        finish(result);
      } };
  };
  const driver = {
    backend: 'dsh',
    probe: async () => { ++probes; return { backend: 'dsh', ok: true, checkedAt: now(), version: 'manager-fixture', auth: 'ok', problems: [] }; },
    prepare: async spec => ({ ...spec, preparedAt: now() }),
    launch,
    resume: async (_session, spec) => launch(spec),
  };
  const config = resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir: join(stateDir, 'inbox'), port: 0, home: stateDir, env: {}, cwd: root });
  const logger = silentLogger();
  booted = boot({ config, logger });
  const connections = new WorkerConnections(stateDir, backend => {
    assert.equal(backend, 'dsh');
    return driver;
  });
  await connections.load();
  await connections.testAndSave('dsh', { value: 'http://127.0.0.1:' + ports.model + '/?token=manager-synthetic-worker', allowDshPermissions: true });
  const router = new DriverRouter(backend => connections.driver(backend), () => 'dsh');
  runtime = createRuntime(booted, { logger, driver: router, proc: new ProcessRegistry(), notifier: null, connections });
  runtime.saveSettings({ ...runtime.settings(), acceptMode: 'auto', paused: false });
  await runtime.saveModelConfig({ provider: 'openai', baseUrl: 'http://127.0.0.1:' + ports.model + '/v1',
    model: modelName, models: [modelName], temperature: 0, maxTokens: 256, apiKeyEnv: '', apiKey: key });
  const saved = runtime.prompts.saveSkill({ name: 'manager-browser-manual', title: 'Manager manual skill', description: 'Synthetic operator reference', content: skillText });
  assert.equal(saved.source, 'operator');
  assert.equal(saved.enabled, true);
  skill = skillPin(saved);
  await runtime.start();
  panel = new URL(runtime.status().panel);
  assert.equal(panel.hostname, '127.0.0.1');
  ports.runtime = safePort(Number(panel.port));
  report.panel = panel.href;
}

async function startChrome() {
  const binary = process.env.CHROME_BIN ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  chrome = spawn(binary, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let spawnError;
  chrome.stderr.on('data', chunk => { report.chromeStderr = ((report.chromeStderr ?? '') + chunk).slice(-1800); });
  chromeExited = new Promise(resolve => {
    chrome.once('error', error => { spawnError = error; resolve(); });
    chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; resolve(); });
  });
  const portFile = join(profile, 'DevToolsActivePort');
  await until('Chrome DevToolsActivePort', () => {
    if (spawnError) throw spawnError;
    if (chromeExit) throw new Error('Chrome exited: ' + json(chromeExit));
    return existsSync(portFile);
  });
  ports.chrome = safePort(Number((await readFile(portFile, 'utf8')).split('\n')[0]));
  const base = 'http://127.0.0.1:' + ports.chrome;
  const version = await (await fetch(base + '/json/version', { signal: AbortSignal.timeout(5000) })).json();
  report.chromeVersion = version.Browser;
  const target = await (await fetch(base + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(5000) })).json();
  const debuggerUrl = new URL(target.webSocketDebuggerUrl);
  assert.equal(debuggerUrl.host, '127.0.0.1:' + ports.chrome);
  ws = new WebSocket(debuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP failed')); }, { once: true });
  });
  const pending = new Map();
  let sequence = 0;
  ws.addEventListener('close', () => {
    for (const finish of pending.values()) finish(new Error('CDP closed'));
  });
  ws.addEventListener('message', event => {
    const { id, result, error, method, params } = JSON.parse(event.data);
    if (id) {
      pending.get(id)?.(error && new Error(json(error)), result);
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      const { url, method, postData } = params.request;
      if (url.startsWith('http') && new URL(url).origin !== panel.origin) {
        report.errors.push({ scope: 'isolation', name: 'unexpected browser HTTP request', detail: url });
      }
      if (url.startsWith(panel.origin)) report.browserRequests.push({ method, path: new URL(url).pathname + new URL(url).search });
      if (method === 'POST' && /\/api\/conversations\/[^/]+\/message$/.test(url))
        browserPosts.push({ id: params.requestId, url, request: JSON.parse(postData), done: false });
    }
    if (method === 'Network.responseReceived') {
      const post = browserPosts.find(item => item.id === params.requestId);
      if (post) post.status = params.response.status;
    }
    if (method === 'Network.loadingFinished') {
      const post = browserPosts.find(item => item.id === params.requestId);
      if (post) post.done = true;
    }
    if (method === 'Runtime.exceptionThrown') {
      const error = params.exceptionDetails;
      report.errors.push({ scope: 'UI', name: 'uncaught browser exception', detail: error.exception?.description ?? error.text });
    }
  });
  cdp = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP closed: ' + method));
    const id = ++sequence;
    const timer = setTimeout(() => finish(new Error('CDP timeout: ' + method)), 6500);
    function finish(error, result) {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(error); else resolve(result);
    }
    pending.set(id, finish);
    try { ws.send(json({ id, method, params })); }
    catch (error) { finish(error); }
  });
  for (const domain of ['Runtime', 'Page', 'Network', 'Fetch']) {
    await cdp(domain + '.enable', domain === 'Fetch' ? { patterns: [{ urlPattern: 'http*' }] } : {});
  }
  // Deny page requests to every HTTP(S) origin other than the exact isolated Runtime origin.
  ws.addEventListener('message', event => {
    const { method, params } = JSON.parse(event.data);
    if (method !== 'Fetch.requestPaused') return;
    const allowed = new URL(params.request.url).origin === panel.origin;
    cdp(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
      requestId: params.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
    }).catch(error => report.errors.push({ scope: 'isolation', name: 'CDP request interception', detail: String(error) }));
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

function dom(label, expression) {
  return until(label, async () => {
    try { return await evaluate(expression); }
    catch (error) {
      if (!/context.*destroyed|cannot find context/i.test(String(error))) throw error;
      return false;
    }
  });
}

async function click(selector, label) {
  const point = await dom(label ?? selector, '(() => {' +
    'const el=[...document.querySelectorAll(' + json(selector) + ')].find(el=>' +
    (!label ? 'true' : 'el.textContent.includes(' + json(label) + ')') + ');' +
    'if (!el || el.disabled || !el.getClientRects().length) return null;' +
    'el.scrollIntoView({block:"nearest",behavior:"instant"});const r=el.getBoundingClientRect();' +
    'const x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()');
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { ...point, type, button: 'left', clickCount: 1 });
}

async function api(path, payload) {
  const target = new URL('api/' + path, panel);
  const { status, result } = await evaluate('(async()=>{const res=await fetch(' + json(target.pathname + target.search) +
    ',' + json({ method: payload === undefined ? 'GET' : 'POST', headers: { 'x-ordin-request': '1', 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: json(payload) }) }) + ');return {status:res.status,result:await res.json()};})()');
  assert(status >= 200 && status < 300, path + ' HTTP ' + status + ' ' + json(result));
  return result;
}

async function capture(name) {
  const path = join(reportDir, name + '.png');
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(data, 'base64'));
  report.screenshots.push(path);
}

async function sendUi(text, expectedReply, refs = []) {
  const previous = browserPosts.length;
  const replyCount = await evaluate('document.querySelector("#log").innerText.split(' + json(expectedReply) + ').length');
  await click('#input');
  await cdp('Input.insertText', { text });
  await click('#send');
  const post = await until('browser POST finishes for ' + text, () => browserPosts[previous]?.done && browserPosts[previous]);
  assert.equal(browserPosts.length, previous + 1);
  assert.deepEqual(post.request.assetRefs ?? [], refs);
  assert.equal(post.request.text, text);
  const body = await cdp('Network.getResponseBody', { requestId: post.id });
  const receipt = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
  assert.equal(post.status, 200, json(receipt));
  assert.equal(receipt.reply, expectedReply, json(receipt));
  await dom('rendered response ' + expectedReply, 'document.querySelector("#log").innerText.split(' + json(expectedReply) + ').length===' + (replyCount + 1) + ' && document.querySelector("#input:enabled")?.value===""');
  return { receipt, path: new URL(post.url).pathname };
}

async function main() {
  stateDir = await mkdtemp(join(temp, 'ordin-manager-state-'));
  profile = await mkdtemp(join(temp, 'ordin-manager-chrome-'));
  await startModel();
  await startRuntime();
  await startChrome();
  const destination = new URL('chat', panel).href;
  const navigation = await cdp('Page.navigate', { url: destination });
  assert(!navigation.errorText, navigation.errorText);
  await dom('chat ready', 'location.href.startsWith(' + json(destination) + ') && Boolean(document.querySelector("#input:enabled"))');
  await check('API', 'seed managed imports in Chrome and cache fixture execution check', async () => {
    alpha = pin(await api('assets/import', { name: assetQuery, text: assetText, kind: 'document' }));
    beta = pin(await api('assets/import', { name: 'Manager fixture Beta', text: 'MANAGER_BETA', kind: 'document' }));
    for (const ref of [alpha, beta]) { assert(ref.id); assert.equal(ref.revision, 1); assert.match(ref.contentHash, /^[a-f0-9]{64}$/); }
    assert.equal(alpha.contentHash, sha(assetText));
    assert.equal((await api('execution/check', {})).ok, true);
    return { alpha, beta, skill };
  });
  const message = await check('UI + observed HTTP', 'chat creates one task and renders its card', async () => {
    assert.equal((await api('tickets?state=all')).count, 0);
    const { receipt, path } = await sendUi(createPrompt, reply.create);
    assert.deepEqual(receipt.toolOutcomes.map(item => [item.name, item.ok]), [['create_task', true]]);
    ticketId = receipt.toolOutcomes[0].data.ticketId;
    assert.equal(await dom('task card', 'document.querySelector(".task-card")?.dataset.taskId'), ticketId);
    assert.equal((await api('tickets?state=all')).count, 1);
    await capture('manager-task-card');
    return path.split('/api/')[1];
  });
  const taskPath = 'tickets/' + encodeURIComponent(ticketId);
  await check('UI + observed HTTP and SSE', 'Manager reads catalog, exact sample, runtime and manual skill', async () => {
    await until('fixture assignment running', async () => (await api(taskPath)).assignment?.state === 'running');
    const before = probes;
    const { receipt } = await sendUi(readsPrompt, reply.reads);
    assert.equal(receipt.rounds, 4);
    assert.equal(probes, before, 'inspect_runtime triggered a new probe');
    assert.equal(receipt.toolOutcomes.length, 8);
    assert(receipt.toolOutcomes.every(item => item.ok));
    await capture('manager-reads');
    return receipt;
  });
  await check('UI + observed HTTP and SSE', 'Manager recipe contracts lead to read evidence and grant no attachment permission', async () => {
    const before = probes;
    const { receipt } = await sendUi(recipesPrompt, reply.recipes);
    assert.equal(receipt.rounds, 4);
    assert.equal(receipt.toolOutcomes.length, 8);
    assert(receipt.toolOutcomes.every(item => item.ok));
    assert.equal(probes, before, 'Recipe diagnosis triggered a new probe');
    assert.deepEqual((await api(taskPath)).inputs, []);
    assert.equal((await api('tickets?state=all')).count, 1);
    return receipt;
  });
  await check('UI + observed HTTP', 'asset picker selects both pins and ordinary chat cannot attach', async () => {
    await click('#asset-open');
    await click('#asset-query');
    await cdp('Input.insertText', { text: 'fixture Alpha' });
    await click('#asset-results button', assetQuery);
    await click('#asset-open');
    await click('#asset-query');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', commands: ['selectAll'] });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    await cdp('Input.insertText', { text: 'fixture Beta' });
    await click('#asset-results button', 'Manager fixture Beta');
    assert.equal(await evaluate('document.querySelectorAll("#asset-chips .asset-chip").length'), 2);
    await capture('manager-selected-assets');
    const { receipt } = await sendUi(ordinaryPrompt, reply.ordinary, [alpha, beta]);
    assert.deepEqual(receipt.toolOutcomes, [{ name: offeredAttach, ok: false, error: 'Tool unavailable for this request' }]);
    assert.deepEqual((await api(taskPath)).inputs, []);
    return receipt;
  });
  const original = await check('UI + observed HTTP', 'exact attachment instruction creates a single queued receipt', async () => {
    const { receipt } = await sendUi(attachPrompt(), reply.attach, [alpha, beta]);
    assert.deepEqual(receipt.toolOutcomes.map(item => [item.name, item.ok]), [[offeredAttach, true]]);
    const input = receipt.toolOutcomes[0].data;
    assert.deepEqual(input.assetRefs, [alpha, beta].sort((a, b) => a.id.localeCompare(b.id)));
    assert.match(input.requestId, /^manager-[a-f0-9]{64}$/);
    assert(input.inputId);
    assert.equal(input.deliveryState, 'queued');
    await capture('manager-attachment');
    return input;
  });
  await check('API', 'separate conversation turn replays original receipt with reordered pins', async () => {
    const replay = await api(message, { text: attachPrompt(), assetRefs: [beta, alpha] });
    assert.equal(replay.reply, reply.attach);
    assert.equal(replay.rounds, 2);
    const replayData = replay.toolOutcomes[0]?.data;
    assert.equal(replay.toolOutcomes[0]?.name, offeredAttach);
    assert.equal(replay.toolOutcomes[0]?.ok, true);
    assert.deepEqual({ requestId: replayData.requestId, inputId: replayData.inputId, assetRefs: replayData.assetRefs }, { requestId: original.requestId, inputId: original.inputId, assetRefs: original.assetRefs });
    assert(['queued', 'delivered'].includes(replayData.deliveryState));
    assert.equal(replayData.message, replayData.deliveryState === 'delivered' ? '已送达执行端，不代表已读取' : '已保存待投递；由执行端能力决定下一轮接收');
    const task = await api(taskPath);
    assert.equal(task.title, title);
    assert.deepEqual(task.inputs.map(input => ({ id: input.id, requestId: input.requestId, assetRefs: input.assetRefs, receipt: input.receipt })),
      [{ id: original.inputId, requestId: original.requestId, assetRefs: original.assetRefs, receipt: task.inputs[0].receipt }]);
    const history = await api(message + 's');
    assert.equal(history.messages.filter(row => row.role === 'user' && row.content === attachPrompt()).length, 2);
    assert.equal((await api('tickets?state=all')).count, 1);
    return { replay, inputs: task.inputs };
  });
}

function groupAlive() {
  if (!chrome?.pid) return false;
  try { process.kill(-chrome.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function portClosed(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function cleanup(name, action) {
  // Keep sweeping even when one cleanup assertion fails.
  await check('cleanup', name, action).catch(() => {});
}

try {
  for (const path of expectedFixtureFiles) stamps.set(path, sha(await readFile(join(root, path))));
  report.sourceHashes = Object.fromEntries(stamps);
  await main();
} catch (error) {
  if (!report.errors.some(item => item.detail === String(error.stack ?? error))) {
    report.errors.push({ scope: 'harness', name: 'startup or execution', detail: String(error.stack ?? error) });
  }
} finally {
  await cleanup('Chrome process group', async () => {
    if (cdp) await cdp('Browser.close').catch(() => {});
    ws?.close();
    if (chromeExited) await Promise.race([chromeExited, pause(2500, undefined, { ref: false })]);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!groupAlive()) break;
      try { process.kill(-chrome.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await pause(500);
    }
    report.cleanup.chromeExit = chromeExit;
    report.cleanup.chromeGroupGone = !groupAlive();
    assert(report.cleanup.chromeGroupGone);
  });
  await cleanup('Runtime and state lock', async () => {
    if (runtime) await runtime.stop(); else if (booted) await booted.stop();
    report.cleanup.lockGone = !stateDir || !existsSync(join(stateDir, 'ordin.lock'));
    assert(report.cleanup.lockGone);
  });
  await cleanup('model listener', async () => {
    if (!model?.listening) return;
    await new Promise((resolve, reject) => {
      model.close(error => error ? reject(error) : resolve());
      model.closeAllConnections();
    });
  });
  await cleanup('all allocated ports released', async () => {
    report.cleanup.portReleased = Object.fromEntries(await Promise.all(Object.entries(ports).map(async ([name, port]) => [name, await portClosed(port)])));
    assert(Object.values(report.cleanup.portReleased).every(Boolean), json(report.cleanup.portReleased));
  });
  await cleanup('remove temporary state and Chrome profile', async () => {
    for (const [path, prefix, stopped] of [[stateDir, 'ordin-manager-state-', report.cleanup.lockGone], [profile, 'ordin-manager-chrome-', report.cleanup.chromeGroupGone]]) {
      if (!path || !stopped) continue;
      const resolved = await realpath(path);
      assert.equal(dirname(resolved), temp);
      assert(resolved.startsWith(join(temp, prefix)));
      await rm(resolved, { recursive: true, force: true });
    }
    Object.assign(report.cleanup, { stateDir, profile, stateGone: !stateDir || !existsSync(stateDir), profileGone: !profile || !existsSync(profile) });
    assert(report.cleanup.stateGone && report.cleanup.profileGone);
  });
  await cleanup('source hashes stable', async () => {
    for (const [path, before] of stamps) assert.equal(sha(await readFile(join(root, path))), before, path + ' changed during acceptance');
  });
  report.exit = Number(report.errors.length > 0);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('MANAGER exit=' + report.exit + ' report=' + reportPath + '\n');
  process.exitCode = report.exit;
}
