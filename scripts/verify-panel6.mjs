import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const taskTitle = 'PANEL-6 受控任务';
const assetName = 'PANEL-6 受控资产';
const assetText = 'PANEL6_ASSET_PREVIEW <b>原样文本</b>';
const ordinary = 'PANEL6_DISCUSS 今天聊聊思路即可。';
const assignment = 'PANEL6_ASSIGN 请创建任务，整理一份简单目录。';
const reply = 'PANEL6_DISCUSSION_REPLY';
const progressText = 'PANEL6_WORKER_NEW_TEXT';
const progressTool = 'panel6_probe_tool';
const privateArg = 'PANEL6_PRIVATE_SYNTHETIC_ARG';
const report = { root, checks: [], errors: [], layout: [], screenshots: [], network: [], model: [], cleanup: {} };
const reportDir = process.argv[2] || process.env.PANEL6_REPORT_DIR
  ? resolve(process.argv[2] || process.env.PANEL6_REPORT_DIR)
  : await mkdtemp(join(tmpdir(), 'ordin-panel6-report-'));
assert.match(reportDir, /^\/(?:private\/)?(?:tmp|var\/folders)\//, 'reportDir must be under the temporary directory');
await mkdir(reportDir, { recursive: true });

const describe = e => e instanceof Error ? e.stack ?? e.message : String(e);
const quote = JSON.stringify;
const now = () => new Date().toISOString();
let stateDir, profile, booted, runtime, model, chrome, chromeExited, chromeExit, ws, send;
const ports = {};
const blockedPorts = ['127.0.0.1', 'localhost', '[::1]'].flatMap(host => [7471, 3080].map(port => '*://' + host + ':' + port + '/*'));
const turns = new Map();

async function until(label, probe, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await pause(75);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + label);
}

async function step(name, action) {
  try {
    const detail = await action();
    report.checks.push({ name, status: 'pass', detail });
  } catch (error) {
    const detail = describe(error);
    report.checks.push({ name, status: 'fail', detail: detail.slice(0, 2400) });
    report.errors.push({ name, detail: detail.slice(0, 2400) });
  }
}

function loopbackPort(port) {
  assert(Number.isInteger(port) && port > 0 && ![3080, 7471].includes(port), 'unexpected fixture port: ' + port);
  return port;
}

async function launchModel() {
  model = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer panel6-synthetic-key');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.stream, true);
      assert.equal(body.model, 'panel6-local');
      const lastUser = body.messages.findLast(m => m.role === 'user');
      assert(lastUser, 'missing user message');
      const last = body.messages.at(-1);
      let delta, finish = 'stop';
      if (lastUser.content.includes(ordinary)) {
        delta = { content: reply };
        report.model.push('ordinary');
      } else if (lastUser.content.includes(assignment) && last.role === 'tool') {
        delta = { content: 'PANEL6_TASK_CONFIRMATION' };
        report.model.push('tool-result');
      } else {
        assert(lastUser.content.includes(assignment), 'unexpected synthetic model prompt');
        assert(body.tools.some(t => t.function?.name === 'create_task'));
        delta = { tool_calls: [{ index: 0, id: 'panel6-create', type: 'function', function: {
          name: 'create_task', arguments: quote({ title: taskTitle, text: '整理一份简单目录', backend: 'dsh' })
        } }] };
        finish = 'tool_calls';
        report.model.push('create_task');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + quote({ choices: [{ delta, finish_reason: finish }] }) + '\n\ndata: [DONE]\n\n');
    } catch (error) {
      report.errors.push({ name: 'local SSE model', detail: describe(error) });
      res.writeHead(500).end();
    }
  });
  await new Promise((ok, fail) => {
    model.once('error', fail);
    model.listen(0, '127.0.0.1', ok);
  });
  ports.model = loopbackPort(model.address().port);
}

async function startChrome() {
  const binary = process.env.CHROME_BIN ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  chrome = spawn(binary, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--no-proxy-server', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let spawnError;
  chrome.stderr.on('data', chunk => { report.chromeStderr = ((report.chromeStderr ?? '') + chunk).slice(-1400); });
  chromeExited = new Promise(done => {
    chrome.once('error', error => { spawnError = error; done(); });
    chrome.once('exit', (code, signal) => { chromeExit = { code, signal }; done(); });
  });
  const portFile = join(profile, 'DevToolsActivePort');
  await until('Chrome DevToolsActivePort', () => {
    if (spawnError) throw spawnError;
    if (chromeExit) throw new Error('Chrome exited: ' + quote(chromeExit));
    return existsSync(portFile);
  });
  ports.chrome = loopbackPort(Number((await readFile(portFile, 'utf8')).split('\n')[0]));
  const target = await (await fetch('http://127.0.0.1:' + ports.chrome + '/json/new?about:blank', {
    method: 'PUT', signal: AbortSignal.timeout(5000),
  })).json();
  assert.equal(new URL(target.webSocketDebuggerUrl).hostname, '127.0.0.1');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('CDP WebSocket open timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); ok(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); fail(new Error('CDP WebSocket failed')); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  report.conversationPosts = [];
  ws.addEventListener('close', () => {
    for (const finish of pending.values()) finish(new Error('CDP WebSocket closed'));
    pending.clear();
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      pending.get(message.id)?.(message.error && new Error(quote(message.error)), message.result);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      report.errors.push({ name: 'Chrome uncaught exception', detail: d.exception?.description ?? d.text });
    }
    if (message.method === 'Network.requestWillBeSent') {
      const { method, url } = message.params.request;
      if (method === 'POST' && url.endsWith('/message') && url.includes('/ordin/api/conversations/'))
        report.conversationPosts.push({ at: Date.now(), url });
    }
    if (message.method === 'Network.responseReceived') {
      const { url, status } = message.params.response;
      report.network.push({ at: Date.now(), url, status });
    }
  });
  send = (method, params = {}) => new Promise((ok, fail) => {
    if (ws.readyState !== WebSocket.OPEN) return fail(new Error('CDP closed: ' + method));
    const request = ++id;
    const timer = setTimeout(() => finish(new Error('CDP timeout: ' + method)), 6000);
    function finish(error, result) {
      clearTimeout(timer);
      pending.delete(request);
      if (error) fail(error); else ok(result);
    }
    pending.set(request, finish);
    try { ws.send(quote({ id: request, method, params })); }
    catch (error) { finish(error); }
  });
  for (const domain of ['Runtime', 'Page', 'Network', 'Accessibility']) await send(domain + '.enable');
  await send('Network.setBlockedURLs', { urls: blockedPorts });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitDom(label, expression, timeout) {
  return until(label, async () => {
    try { return await evaluate(expression); }
    catch (error) {
      if (!/context.*destroyed|cannot find context/i.test(String(error))) throw error;
      return false;
    }
  }, timeout);
}

const frameDoc = id => 'document.getElementById(' + quote(id) + ')?.contentDocument';
async function click(selector, frame) {
  const hit = await waitDom('click target ' + selector, '(() => {' +
    'const frame=' + (frame ? 'document.getElementById(' + quote(frame) + ')' : 'null') + ';' +
    'const el=(frame ? frame.contentDocument : document)?.querySelector(' + quote(selector) + ');' +
    'if (!el || el.disabled || !el.getClientRects().length) return null;' +
    'frame?.scrollIntoView({block:"nearest"});el.scrollIntoView({block:"center",inline:"nearest",behavior:"instant"});' +
    'const r=el.getBoundingClientRect(), f=frame?.getBoundingClientRect();' +
    'const x=r.left+r.width/2, y=r.top+r.height/2;' +
    'if (!el.contains(el.ownerDocument.elementFromPoint(x,y))) return null;' +
    'return {x:x+(f?.left??0)+(frame?.clientLeft??0), y:y+(f?.top??0)+(frame?.clientTop??0)};' +
    '})()');
  if (selector === '#execution-connection-value') {
    report.connectionClickGeometry = await evaluate('(() => { const rect=e=>{const {x,y,width,height}=e.getBoundingClientRect();return {x,y,width,height}};return { input:rect(document.querySelector("#execution-connection-value")), header:rect(document.querySelector("header")) }; })()');
  }
  await send('Input.dispatchMouseEvent', { ...hit, type: 'mousePressed', button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { ...hit, type: 'mouseReleased', button: 'left', clickCount: 1 });
}

async function tab() {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
  await send('Input.dispatchKeyEvent', { ...key, type: 'keyDown' });
  await send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
}

async function capture(name) {
  const path = join(reportDir, name + '.png');
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(data, 'base64'));
  report.screenshots.push(path);
}

async function main() {
  stateDir = await mkdtemp(join(tmpdir(), 'ordin-panel6-state-'));
  profile = await mkdtemp(join(tmpdir(), 'ordin-panel6-chrome-'));
  const [{ boot }, { resolveConfig }, { createRuntime }, { ProcessRegistry }, { silentLogger }, { TurnChannel }, { WorkerConnections }, { DriverRouter }] =
    await Promise.all(['app/boot', 'app/config', 'app/runtime', 'app/process', 'app/logger', 'drivers/channel', 'app/worker-connections', 'drivers/router']
      .map(path => import(new URL('../src/' + path + '.ts', import.meta.url))));
  await launchModel();
  const makeTurn = (spec, session) => {
    const queue = new TurnChannel();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const at = now();
    queue.push({ kind: 'started', at, session: session ?? { backend: 'dsh', id: 'panel6-' + spec.ticketId, cwd: spec.cwd, savedAt: at } });
    const turn = { id: spec.assignmentId, backend: 'dsh', events: queue.iterable, done,
      feed: async () => ({ status: 'accepted' }), cancel: async () => {
        const result = { status: 'cancelled', text: 'fixture teardown' };
        queue.push({ kind: 'final', at: now(), result });
        queue.close(); finish(result);
      } };
    turns.set(spec.ticketId, { spec, queue, turn });
    return turn;
  };
  const driver = {
    backend: 'dsh',
    probe: async () => ({ backend: 'dsh', ok: true, checkedAt: now(), version: 'panel6-fixture', auth: 'ok', problems: [] }),
    prepare: async spec => ({ ...spec, preparedAt: now() }),
    launch: async spec => makeTurn(spec),
    resume: async (session, spec) => makeTurn(spec, session),
  };
  const config = resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir: join(stateDir, 'inbox'), port: 0, home: stateDir, env: {}, cwd: root });
  const logger = silentLogger();
  booted = boot({ config, logger });
  const connections = new WorkerConnections(stateDir, backend => {
    assert.equal(backend, 'dsh', 'fixture supports DSH only');
    return driver;
  });
  await connections.load();
  const connectionLink = token => 'http://127.0.0.1:' + ports.model + '/?token=' + token;
  const seeded = await connections.testAndSave('dsh', { value: connectionLink('panel6-original-synthetic'), allowDshPermissions: true });
  const oldConnection = seeded.dsh.connectionId;
  const router = new DriverRouter(backend => connections.driver(backend), () => 'dsh');
  runtime = createRuntime(booted, { logger, driver: router, proc: new ProcessRegistry(), notifier: null, connections });
  runtime.saveSettings({ ...runtime.settings(), acceptMode: 'auto', paused: false });
  await runtime.saveModelConfig({ provider: 'openai', baseUrl: 'http://127.0.0.1:' + ports.model + '/v1',
    model: 'panel6-local', models: ['panel6-local'], temperature: 0, maxTokens: 256, apiKeyEnv: '', apiKey: 'panel6-synthetic-key' });
  await runtime.start();
  const panel = new URL(runtime.status().panel);
  assert.equal(panel.hostname, '127.0.0.1');
  ports.runtime = loopbackPort(Number(panel.port));
  report.panel = panel.href;
  const api = async (path, body) => {
    const response = await fetch(new URL('api/' + path, panel), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-ordin-request': '1', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: quote(body) }),
    });
    const value = await response.json();
    assert(response.ok, path + ' HTTP ' + response.status + ' ' + quote(value));
    return value;
  };
  await api('assets/import', { name: assetName, text: assetText, kind: 'document' });
  await startChrome();
  const url = suffix => new URL(suffix, panel).href;
  async function navigate(suffix) {
    const destination = url(suffix);
    const result = await send('Page.navigate', { url: destination });
    assert(!result.errorText, result.errorText);
    await waitDom(destination, 'location.href===' + quote(destination) + ' && document.readyState==="complete"');
    await pause(250);
    if (suffix === '') { await click('[data-tab=overview]'); await waitDom('home visible', 'Boolean(document.getElementById("home-start")?.getClientRects().length)'); }
  }
  const setViewport = (width, height, deviceScaleFactor = 1) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  await setViewport(1440, 1000);
  const frameReady = (frame, selector) => waitDom(frame + ' ' + selector,
    'Boolean(document.getElementById(' + quote(frame) + ')?.getClientRects().length && ' + frameDoc(frame) + '?.querySelector(' + quote(selector) + '))');
  let ticketId;
  let conversationId;
  await step('home → tasks', async () => {
    await navigate(''); await click('#home-tasks'); await frameReady('workspace-frame', '#search');
    return evaluate(frameDoc('workspace-frame') + '.URL');
  });
  await step('home → assets → available asset preview', async () => {
    await navigate(''); await click('#home-assets'); await frameReady('assets-frame', '#list .asset');
    await click('#list .asset', 'assets-frame');
    await waitDom('available asset detail', frameDoc('assets-frame') + '?.querySelector("#detail")?.innerText.includes(' + quote(assetName) + ')');
    assert.match(await evaluate(frameDoc('assets-frame') + '.querySelector("#detail").innerText'), /可用/);
    await click('#load-content', 'assets-frame');
    const text = await waitDom('asset literal preview', frameDoc('assets-frame') + '?.querySelector("#preview-body")?.innerText.includes(' + quote(assetText) + ')');
    assert(text);
    await capture('assets-preview');
    return evaluate(frameDoc('assets-frame') + '.URL');
  });
  const chat = frameDoc('chat-frame');
  await step('home → chat → ordinary discussion without a Ticket', async () => {
    await navigate(''); await click('#home-start'); await frameReady('chat-frame', '#input');
    await waitDom('chat input enabled', 'Boolean(' + chat + '?.querySelector("#input:enabled"))');
    const before = runtime.store.tickets.list().length;
    await click('#input', 'chat-frame'); await send('Input.insertText', { text: ordinary });
    await click('#send', 'chat-frame');
    await waitDom('ordinary assistant reply', chat + '?.querySelector("#log")?.innerText.includes(' + quote(reply) + ')');
    assert.equal(runtime.store.tickets.list().length, before);
    assert.deepEqual(report.model, ['ordinary']);
    conversationId = await evaluate(chat + '?.querySelector("#conversation-list [aria-current=true]")?.dataset.id');
    return { url: await evaluate(chat + '.URL'), ticketCount: before };
  });
  await step('explicit browser chat creates and opens matching Ticket', async () => {
    const before = runtime.store.tickets.list().length;
    await click('#input', 'chat-frame'); await send('Input.insertText', { text: assignment });
    await click('#send', 'chat-frame');
    const id = await waitDom('task card', chat + '?.querySelector(".task-card[data-task-id]")?.dataset.taskId');
    const stored = runtime.store.tickets.get(id);
    assert.equal(stored?.title, taskTitle);
    assert.equal(runtime.store.tickets.list().length, before + 1);
    assert.deepEqual(report.model.slice(-2), ['create_task', 'tool-result']);
    const stage = await until('running assignment in Store and API', async () => {
      if (runtime.store.tickets.get(id)?.assignments.at(-1)?.state !== 'running') return false;
      const detail = await api('tickets/' + encodeURIComponent(id));
      return detail.stage === 'running' && detail.assignment?.state === 'running' ? detail : false;
    });
    assert.equal(stage.id, id);
    ticketId = id;
    await capture('chat-task-card');
    let keyboardCard = false;
    for (let index = 0; index < 40; index++) {
      await tab();
      if (await evaluate(chat + '?.activeElement?.matches(".task-card a")')) { keyboardCard = true; break; }
    }
    assert(keyboardCard, 'Tab did not reach task card link within 40 steps');
    await click('.task-card[data-task-id=' + quote(id) + '] a', 'chat-frame');
    await frameReady('workspace-frame', '#detail');
    const workspace = frameDoc('workspace-frame');
    await waitDom('same Ticket URL and rendered title', workspace + '?.URL.includes(' + quote('ticket=' + encodeURIComponent(id)) + ') && ' + workspace + '?.querySelector("#detail h2")?.innerText===' + quote(taskTitle));
    return { id, stage: stage.stage, assignment: stage.assignment.id, url: await evaluate(workspace + '.URL') };
  });
  await step('5s workspace polling renders delayed Worker text and safe tool name', async () => {
    assert(ticketId, 'browser task and running API prerequisite failed');
    const frame = frameDoc('workspace-frame');
    const prefix = 'tickets/' + encodeURIComponent(ticketId);
    const initial = await api(prefix);
    assert.equal(initial.stage, 'running');
    assert.equal(runtime.store.tickets.get(ticketId).assignments.at(-1).state, 'running');
    await waitDom('loaded running task and visible workspace', frame + '?.querySelector("#detail h2")?.innerText===' + quote(taskTitle) + ' && !' + frame + '.hidden');
    const before = await evaluate(frame + '.body.innerText');
    assert(!before.includes(progressText)); assert(!before.includes(progressTool));
    const delayedAt = Date.now();
    const { queue, spec } = turns.get(ticketId);
    assert.equal(spec.assignmentId, initial.assignment.id);
    queue.push({ kind: 'text', at: now(), text: progressText });
    queue.push({ kind: 'tool', at: now(), name: progressTool, detail: { args: privateArg } });
    queue.push({ kind: 'usage', at: now(), usage: { input: 7, output: 3 } });
    await waitDom('delayed text and tool in browser after natural poll', '(() => {const text=' + frame + '?.body.innerText; return text?.includes(' + quote(progressText) + ') && text.includes(' + quote(progressTool) + ')})()', 11500);
    const elapsedMs = Date.now() - delayedAt;
    const polled = report.network.filter(row => row.url === url('api/' + prefix + '/progress') && row.at >= delayedAt && row.status === 200);
    assert(polled.length > 0, 'no browser HTTP progress poll after event injection');
    const apiProgress = await api(prefix + '/progress');
    const journal = await api(prefix + '/events?limit=100');
    const dom = await evaluate(frame + '.body.textContent');
    for (const [label, text] of [['DOM', dom], ['progress API', quote(apiProgress)], ['events API', quote(journal)]])
      assert(!text.includes(privateArg), 'Worker tool arguments exposed in ' + label);
    await capture('workspace-progress');
    return { elapsedMs, polled, initialAssignment: initial.assignment.id, progress: apiProgress };
  });

  await step('DSH settings save rotates connection while running Ticket retains its owner', async () => {
    assert(ticketId, 'running browser Ticket prerequisite required');
    const oldPath = 'tickets/' + encodeURIComponent(ticketId) + '/progress';
    assert.equal((await api(oldPath)).connectionId, oldConnection);
    await waitDom('old connection on running task', frameDoc('workspace-frame') + '?.querySelector("#detail")?.innerText.includes(' + quote(oldConnection) + ')');
    await navigate('#settings');
    await waitDom('saved old connection shown in settings', 'document.getElementById("execution-connection-version")?.innerText.includes(' + quote(oldConnection) + ')');
    report.connectionInputBeforeClick = await evaluate('(() => { const el=document.getElementById("execution-connection-value");const r=el.getBoundingClientRect(); return { y:r.top, height:r.height, disabled:el.disabled, viewport:innerHeight }; })()');
    await click('#execution-connection-value');
    await send('Input.insertText', { text: connectionLink('panel6-replacement-synthetic') });
    await click('#execution-connection-dsh-allow');
    await click('#execution-connection-save');
    const newConnection = await until('new DSH connection UUID', async () => {
      const id = (await api('execution/connections')).dsh.connectionId;
      return id && id !== oldConnection ? id : false;
    });
    await waitDom('settings shows new connection ID', 'document.getElementById("execution-connection-version")?.innerText.includes(' + quote(newConnection) + ')');
    assert.equal(await evaluate('document.getElementById("execution-connection-value").value'), '');
    await capture('settings-connection-rotated');
    await navigate('workspace?ticket=' + encodeURIComponent(ticketId));
    await waitDom('old task still renders original connection', 'document.querySelector("#detail")?.innerText.includes(' + quote(oldConnection) + ')');
    assert.equal((await api(oldPath)).connectionId, oldConnection);
    assert.equal((await api('tickets/' + encodeURIComponent(ticketId))).stage, 'running');
    await capture('workspace-original-connection');
    const newTaskTitle = 'PANEL-6 切换后新任务';
    const created = await api('tickets', { title: newTaskTitle, request: '验证后续启动采用新连接' });
    const nextId = created.ticketId ?? created.disposition?.ticketId;
    assert(nextId && nextId !== ticketId);
    await until('next task running on rotated connection', async () => {
      if (runtime.store.tickets.get(nextId)?.assignments.at(-1)?.state !== 'running') return false;
      const progress = await api('tickets/' + encodeURIComponent(nextId) + '/progress');
      return progress.connectionId === newConnection;
    });
    await navigate('workspace?ticket=' + encodeURIComponent(nextId));
    await waitDom('new task shows new connection', 'document.querySelector("#detail")?.innerText.includes(' + quote(newConnection) + ') && document.querySelector("#detail h2")?.innerText===' + quote(newTaskTitle));
    await capture('workspace-rotated-connection');
    return { oldConnection, newConnection, oldTicket: ticketId, newTicket: nextId };
  });

  await step('running workspace polls terminal receipt and newly produced artifact', async () => {
    assert(ticketId, 'running Ticket prerequisite required');
    const prefix = 'tickets/' + encodeURIComponent(ticketId);
    const file = 'panel6-deliverable.md';
    const summary = 'PANEL6_TERMINAL_RECEIPT';
    await navigate('workspace?ticket=' + encodeURIComponent(ticketId));
    await waitDom('initial running workspace before artifact', 'document.querySelector("#detail h2")?.innerText===' + quote(taskTitle) + ' && !document.getElementById("selected-content").hidden');
    assert.equal((await api(prefix)).stage, 'running');
    assert(!await evaluate('document.getElementById("files").innerText.includes(' + quote(file) + ')'));
    const { queue, spec } = turns.get(ticketId);
    await writeFile(join(spec.cwd, file), '# 受控交付物\n');
    const at = Date.now();
    queue.push({ kind: 'report', at: now(), report: { state: 'ready', summary, files: [file], at: now() } });
    await until('independent acceptance of fixture artifact', async () => {
      const result = await api(prefix);
      return result.stage === 'done' && result.acceptance?.status === 'accepted';
    });
    await waitDom('automatic terminal receipt and artifact list', 'document.getElementById("detail")?.innerText.includes(' + quote(summary) + ') && document.getElementById("files")?.innerText.includes(' + quote(file) + ')', 11500);
    assert(report.network.some(row => row.at >= at && row.url === url('api/' + prefix + '/files') && row.status === 200));
    await capture('workspace-terminal-artifact');
    return { ticketId, file, elapsedMs: Date.now() - at };
  });

  await step('chat read failure retains draft and explicit history retry recovers', async () => {
    assert(conversationId, 'successful ordinary conversation prerequisite required');
    await navigate('chat?conversation=' + encodeURIComponent(conversationId));
    await waitDom('chat ready', 'Boolean(document.querySelector("#input:enabled"))');
    await click('#input'); await send('Input.insertText', { text: 'PANEL6_RETAINED_DRAFT' });
    await send('Network.setBlockedURLs', { urls: [...blockedPorts, '*/ordin/api/conversations/*/messages*'] });
    const before = report.model.length;
    try {
      await click('#history-retry');
      await waitDom('read error visible', 'document.getElementById("conversation-error")?.innerText.includes("读取历史失败")');
      assert.equal(await evaluate('document.getElementById("input").value'), 'PANEL6_RETAINED_DRAFT');
      assert.equal(report.model.length, before);
      await capture('chat-read-failure');
    } finally { await send('Network.setBlockedURLs', { urls: blockedPorts }); }
    await click('#history-retry');
    await waitDom('explicit read retry enabled input', 'Boolean(document.querySelector("#input:enabled")) && !document.getElementById("conversation-error").innerText');
    assert.equal(await evaluate('document.getElementById("input").value'), 'PANEL6_RETAINED_DRAFT');
    assert.equal(report.model.length, before);
  });
  await step('chat response unknown retains draft and read button never resends mutation', async () => {
    assert(conversationId, 'conversation prerequisite required');
    const before = report.model.length;
    await send('Network.setBlockedURLs', { urls: [...blockedPorts, '*/ordin/api/conversations/*/message'] });
    try {
      await click('#send');
      await waitDom('unknown send result visible', 'document.getElementById("send-feedback")?.innerText.includes("发送结果未知")');
      assert.equal(await evaluate('document.getElementById("input").value'), 'PANEL6_RETAINED_DRAFT');
      await capture('chat-send-unknown');
    } finally { await send('Network.setBlockedURLs', { urls: blockedPorts }); }
    const postsBeforeRead = report.conversationPosts.length;
    await click('#send-retry');
    await waitDom('read recovery completed', 'Boolean(document.querySelector("#input:enabled"))');
    await pause(600);
    assert.equal(report.conversationPosts.length, postsBeforeRead, 'read button sent a second browser POST');
    assert.equal(report.model.length, before, 'read button invoked the model');
    assert.equal(await evaluate('document.getElementById("input").value'), 'PANEL6_RETAINED_DRAFT');
  });

  for (const [mode, width, height, scale] of [
    ['desktop', 1440, 1000, 1], ['narrow', 390, 844, 1], ['zoom200-reflow', 720, 500, 2], ['css-zoom200', 1440, 1000, 1],
  ]) {
    await setViewport(width, height, scale);
    for (const [page, suffix, selectors] of [
      ['home', '', ['#home-start', '#home-tasks', '#home-assets']],
      ['chat', 'chat' + (conversationId ? '?conversation=' + encodeURIComponent(conversationId) : ''), ['#conversation-new', '#input', '#send']],
      ['workspace', 'workspace' + (ticketId ? '?ticket=' + encodeURIComponent(ticketId) : ''), ['#search', '#refresh', ...(ticketId && !runtime.store.tickets.get(ticketId)?.ended ? ['#note'] : [])]],
      ['assets', 'assets', ['#query', '#kind', '#status', '#import-open']],
      ['settings', '#settings', ['#execution-connection-backend', '#execution-connection-value', '#execution-connection-save', '#execution-connection-refresh']],
    ]) {
      await step(mode + ' ' + page + ' document width, keyboard focus, AX labels', async () => {
        await navigate(suffix);
        if (page === 'settings') await waitDom('execution settings visible', 'Boolean(document.getElementById("execution-connection-value")?.getClientRects().length)');
        if (mode === 'css-zoom200') await evaluate('document.body.style.zoom="2"');
        if (page === 'chat') await waitDom('chat history initialized', 'Boolean(document.querySelector("#input:enabled"))');
        if (page === 'assets') await waitDom('asset list initialized', 'Boolean(document.querySelector("#list .asset"))');
        if (page === 'workspace' && ticketId) await waitDom('selected Ticket', 'document.querySelector("#detail h2")?.innerText===' + quote(taskTitle));
        const dimensions = await evaluate('({inner:innerWidth, html:document.documentElement.scrollWidth, body:document.body.scrollWidth, bodyZoom:getComputedStyle(document.body).zoom, dpr:devicePixelRatio})');
        const focus = [];
        for (let index = 0; index < 4; index++) {
          await tab();
          focus.push(await evaluate('(() => {let e=document.activeElement; e=e?.contentDocument?.activeElement??e; if(!e || e.tagName==="BODY") return null;const s=e.ownerDocument.defaultView.getComputedStyle(e);return {id:e.id,tag:e.tagName,visible:e.matches(":focus-visible"),outline:s.outlineStyle,width:parseFloat(s.outlineWidth),shadow:s.boxShadow};})()'));
        }
        const labels = {};
        const { root: doc } = await send('DOM.getDocument');
        for (const selector of selectors) {
          const { nodeId } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
          if (!nodeId) { labels[selector] = null; continue; }
          const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
          labels[selector] = { role: nodes[0]?.role?.value, name: nodes[0]?.name?.value, ignored: nodes[0]?.ignored };
        }
        const metrics = { mode, page, url: await evaluate('location.href'), dimensions, focus, labels };
        report.layout.push(metrics);
        await capture(mode + '-' + page);
        assert.equal(dimensions.inner, width);
        assert.equal(dimensions.dpr, scale);
        assert(Math.max(dimensions.html, dimensions.body) <= width + 1, 'document horizontal overflow: ' + quote(metrics));
        assert(focus.some(f => f?.visible && ((f.outline !== 'none' && f.width > 0) || f.shadow !== 'none')), 'keyboard focus indicator missing: ' + quote(focus));
        assert(Object.values(labels).every(label => label?.name?.trim() && !label.ignored), 'missing AX name: ' + quote(labels));
        return metrics;
      });
    }
  }
}

function portClosed(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', error => resolve(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

function groupAlive() {
  if (!chrome?.pid) return false;
  try { process.kill(-chrome.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

try {
  report.sourceHashes = {};
  for (const path of ['scripts/verify-panel6.mjs', 'panel/index.html', 'panel/chat.html', 'panel/workspace.html', 'panel/assets.html', 'src/app/runtime.ts', 'src/app/executor.ts', 'src/app/http.ts', 'src/app/views.ts', 'src/app/worker-connections.ts'])
    report.sourceHashes[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  await main();
} catch (error) {
  report.errors.push({ name: 'harness startup or execution', detail: describe(error) });
} finally {
  await step('cleanup Chrome process group', async () => {
    if (send) await send('Browser.close').catch(() => {});
    ws?.close();
    if (chromeExited) await Promise.race([chromeExited, pause(2500, undefined, { ref: false })]);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!groupAlive()) break;
      try { process.kill(-chrome.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await pause(500);
    }
    report.cleanup.chromeExit = chromeExit;
    report.cleanup.chromeGroupGone = !groupAlive();
    assert(report.cleanup.chromeGroupGone);
  });
  await step('cleanup Runtime and state lock', async () => {
    if (runtime) await runtime.stop(); else if (booted) await booted.stop();
    report.cleanup.lockGone = !stateDir || !existsSync(join(stateDir, 'ordin.lock'));
    assert(report.cleanup.lockGone);
  });
  await step('cleanup local model server', async () => {
    if (!model?.listening) return;
    await new Promise((ok, fail) => {
      model.close(error => error ? fail(error) : ok());
      model.closeAllConnections();
    });
  });
  await step('verify ports released', async () => {
    report.cleanup.portReleased = {};
    for (const [name, port] of Object.entries(ports)) report.cleanup.portReleased[name] = await portClosed(port);
    assert(Object.values(report.cleanup.portReleased).every(Boolean), quote(report.cleanup.portReleased));
    return ports;
  });
  await step('remove isolated workspace and Chrome profile', async () => {
    if (stateDir && report.cleanup.lockGone) await rm(stateDir, { recursive: true, force: true });
    if (profile && report.cleanup.chromeGroupGone) await rm(profile, { recursive: true, force: true });
    report.cleanup.paths = { stateDir, profile, stateGone: !stateDir || !existsSync(stateDir), profileGone: !profile || !existsSync(profile) };
    assert(report.cleanup.paths.stateGone && report.cleanup.paths.profileGone, quote(report.cleanup.paths));
  });
  await step('verify source snapshot remained stable', async () => {
    for (const [path, before] of Object.entries(report.sourceHashes ?? {})) {
      const after = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
      assert.equal(after, before, 'source changed during browser acceptance: ' + path);
    }
  });
  report.summary = { checks: report.checks.length, passed: report.checks.filter(c => c.status === 'pass').length, failed: report.checks.filter(c => c.status === 'fail').length, errors: report.errors.length, modes: [...new Set(report.layout.map(row => row.mode))], pages: [...new Set(report.layout.map(row => row.page))] };
  report.gaps = ['Native Chrome browser zoom was not exercised; CSS zoom 2 and 720px/DPR2 reflow are reported separately.', 'No human screen reader test.', 'Asset archive/mutation recovery not yet covered.'];
  report.exit = report.errors.length ? 1 : 0;
  await writeFile(join(reportDir, 'panel6-report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('PANEL-6 exit=' + report.exit + ' report=' + join(reportDir, 'panel6-report.json') + '\n');
  process.exitCode = report.exit;
}