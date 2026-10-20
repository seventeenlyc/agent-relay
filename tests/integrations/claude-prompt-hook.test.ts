import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyDomain } from '../../integrations/claude-package/lib/domains.js';

const hookPath = fileURLToPath(new URL('../../integrations/claude-package/lib/prompt-hook.js', import.meta.url));
const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

// Exercise the command hook, replacing only process launch so a regression cannot
// open terminals or start paid Claude sessions during the test.
function runHook(messages: unknown[], prompt: string, rawInput?: string, modelResponse?: unknown, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-prompt-hook-'));
  try {
    const transcript = path.join(dir, 'transcript.jsonl');
    const launches = path.join(dir, 'launches.jsonl');
    const preload = path.join(dir, 'capture-spawn.mjs');
    const requests = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(transcript, messages.map((m) => JSON.stringify(m)).join('\n'));
    fs.writeFileSync(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { appendFileSync } from 'node:fs';
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      if (process.env.RELAY_TEST_INTERACTIVE) {
        Object.defineProperty(process, 'platform', {value:'win32'});
        const lstat = fs.lstatSync;
        fs.lstatSync = (...args) => String(args[0]).endsWith('wt.exe') ? {} : lstat(...args);
      }
      childProcess.spawn = (...args) => {
        appendFileSync(process.env.RELAY_TEST_LAUNCHES, JSON.stringify(args) + '\\n');
        const child = new EventEmitter();
        child.unref = () => {};
        child.kill = () => {};
        queueMicrotask(() => {
          if (String(args[0]).endsWith('wt.exe')) {
            if (process.env.RELAY_TEST_WT_SPAWN_FAIL) { child.emit('error',new Error('wt failed')); return; }
            const config = JSON.parse(fs.readFileSync(args[1].at(-1),'utf8'));
            fs.writeFileSync(config.readyPath, JSON.stringify({type:process.env.RELAY_TEST_WT_TARGET_FAIL ? 'failed':'started'}));
            child.emit('spawn');
            return;
          }
          if (process.env.RELAY_TEST_LAUNCH_FAIL) child.emit('error', new Error('spawn failed'));
          else child.emit('message', {type: process.env.RELAY_TEST_WORKER_FAIL ? 'failed' : 'started'});
        });
        return child;
      };
      syncBuiltinESMExports();
      if (process.env.RELAY_TEST_RESPONSE) {
        globalThis.fetch = async (url, options) => {
          appendFileSync(process.env.RELAY_TEST_REQUESTS, JSON.stringify({url, ...options, body: JSON.parse(options.body)}) + '\\n');
          if (process.env.RELAY_TEST_FETCH_ERROR) throw new Error('offline');
          if (process.env.RELAY_TEST_FETCH_TIMEOUT) {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('too slow')), 5000);
              options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, {once:true});
            });
          }
          return new Response(process.env.RELAY_TEST_RESPONSE, {status: Number(process.env.RELAY_TEST_STATUS || 200)});
        };
      }
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, hookPath], {
      input: rawInput ?? JSON.stringify({ prompt, transcript_path: transcript, cwd: dir }),
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '',
        AGENT_RELAY_TOPIC_BASE_URL: '', AGENT_RELAY_TOPIC_MODEL: '',
        AGENT_RELAY_HEADLESS: '1', AGENT_RELAY_DATA_DIR: dir,
        RELAY_TEST_LAUNCHES: launches, RELAY_TEST_REQUESTS: requests,
        RELAY_TEST_RESPONSE: modelResponse === undefined ? '' : JSON.stringify(modelResponse),
        ...(modelResponse === undefined ? {} : { ANTHROPIC_API_KEY: 'test-api-key', ANTHROPIC_BASE_URL: 'https://judge.example/anthropic', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'test-fast-model' }),
        ...extraEnv
      }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return {
      output: result.stdout.trim() ? JSON.parse(result.stdout) : null,
      requests: fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [],
      launches: fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const videoHistory = [
  user('给这个 Relay 项目创作宣传视频动画，发布到哔哩哔哩'),
  assistant('已创建宣传文档 README、markdown report、配音脚本和 HTML Canvas 动画页面按钮。')
];
for (const prompt of [
  '[Image #1] 打开html没有播放按钮',
  '[Image #1] 打开你说的html是空的',
  '还是看不到，控制台没有报错，元素里能看到按钮，但是不在上面',
  '视频可以长一点嘛，21秒的视频太短了，至少1分钟吧',
  '给这个动画加一个 React 页面，再补 Playwright 测试和 README 文档'
]) {
  test(`prompt hook keeps video follow-up in the same session: ${prompt}`, () => {
    const result = runHook(videoHistory, prompt);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

test('prompt hook does not repeatedly launch sessions for the same correction', () => {
  const prompt = '还是看不到，控制台没有报错，元素里能看到按钮';
  const messages = [...videoHistory, user(prompt), assistant('已经修好了')];
  for (let i = 0; i < 2; i++) {
    const result = runHook(messages, prompt);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  }
});

for (const prompt of [
  '为这个数据库接口补充 Playwright 测试和文档',
  '顺便用 React 和 CSS 写个这个接口的前端页面',
  '不要换话题，继续修复 HTML 页面按钮',
  '文档里解释一下“换个话题”这个按钮的 React 样式',
  '换个话题按钮的 HTML 和 CSS 样式还是有问题',
  '另一个任务失败了，继续修复 HTML 页面按钮'
]) {
  test(`prompt hook keeps related task work together: ${prompt}`, () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API'), assistant('后端完成')], prompt);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

for (const prompt of ['换个话题，帮我写一篇科幻小说', '另一个任务：使用 React 和 Tailwind CSS 构建前端页面', 'Switch topics: write a fantasy novel']) {
  test(`prompt hook hands off an explicit independent task: ${prompt}`, () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API'), assistant('数据库完成')], prompt);
    assert.equal(result.output?.decision, 'block');
    assert.match(result.output.reason, /backend_systems -> (creative_writing|frontend_ui)/);
    assert.equal(result.launches.length, 1);
    assert.equal(result.launches[0][1].at(-1), prompt);
  });
}

test('prompt hook ignores assistant, tool-result, meta and sidechain domain noise', () => {
  const result = runHook([
    user('设计 SQLite 数据库和后端 API'),
    assistant('React HTML CSS Tailwind 页面 按钮 弹窗 组件'),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'React HTML CSS 页面' }, { type: 'text', text: 'Vue Tailwind 前端' }] } },
    { ...user('React HTML CSS 页面'), isMeta: true },
    { ...user('React HTML CSS 页面'), isSidechain: true }
  ], '换个任务，设计 SQLite 数据库和后端 API');
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

for (const prompt of ['帮我写一篇科幻小说', '写一首关于秋天的诗歌', 'Write a fantasy novel about a dragon']) {
  test(`prompt hook automatically detects an unannounced independent task: ${prompt}`, () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API'), assistant('数据库完成')], prompt);
    assert.equal(result.output?.decision, 'block');
    assert.equal(result.launches.length, 1);
    assert.equal(result.launches[0][1].at(-1), prompt);
  });
}

const modelReply = (decision: string, confidence: number) => ({content:[{type:'text',text:JSON.stringify({decision,confidence,reason:'任务目标关系判断'})}]});
test('semantic judge detects a new project even when both tasks are frontend work', () => {
  const result = runHook([user('给情侣网站制作 React 相册页面'), assistant('相册已完成')], '帮我做一个咖啡店的 React 预约网站', undefined, modelReply('switch', 0.97));
  assert.equal(result.output?.decision, 'block');
  assert.equal(result.launches.length, 1);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].url, 'https://judge.example/anthropic/v1/messages');
  assert.equal(result.requests[0].body.model, 'test-fast-model');
  assert.equal(result.requests[0].headers['x-api-key'], 'test-api-key');
  const context = JSON.parse(result.requests[0].body.messages[0].content);
  assert.ok(context.userPrompts.includes('给情侣网站制作 React 相册页面'));
  assert.equal(context.prompt, '帮我做一个咖啡店的 React 预约网站');
});

test('semantic judge can keep a natural phase change in the same task', () => {
  const result = runHook(videoHistory, '帮我做一个用来播放视频的 React 页面', undefined, modelReply('continue', 0.99));
  assert.equal(result.requests.length, 1);
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

test('clear feedback on the current artifact does not need a model request', () => {
  const result = runHook(videoHistory, '打开你说的html是空的', undefined, modelReply('switch', 0.99));
  assert.equal(result.requests.length, 0);
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

test('a current artifact error without an explicit pronoun also avoids a model request', () => {
  const result = runHook(videoHistory, '[Image #1] 打开html没有播放按钮', undefined, modelReply('switch', 0.99));
  assert.equal(result.requests.length, 0);
  assert.equal(result.output, null);
});

test('a reference to an artifact absent from the current task still needs semantic judgment', () => {
  const result = runHook([user('设计 SQLite 数据库和后端 API')], '这个视频太短了，帮我改一下', undefined, modelReply('switch', 0.98));
  assert.equal(result.requests.length, 1);
  assert.equal(result.output?.decision, 'block');
});

test('semantic request honors the configured topic model, bearer token and /v1 base', () => {
  const result = runHook([user('设计 SQLite 数据库和后端 API')], '写一篇关于月球的科幻小说', undefined, modelReply('switch', 0.99), {
    ANTHROPIC_AUTH_TOKEN:'test-bearer', AGENT_RELAY_TOPIC_MODEL:'test-topic-model', AGENT_RELAY_TOPIC_BASE_URL:'https://judge.example/v1/'
  });
  assert.equal(result.requests[0].url, 'https://judge.example/v1/messages');
  assert.equal(result.requests[0].body.model, 'test-topic-model');
  assert.equal(result.requests[0].headers.authorization, 'Bearer test-bearer');
  assert.equal(result.output?.decision, 'block');
});

for (const reply of [modelReply('switch', 0.6), modelReply('unsure', 0.99), {content:[{type:'text',text:'not JSON'}]}, modelReply('switch', '0.99' as any), {...modelReply('switch', 0.99),stop_reason:'max_tokens'}]) {
  test('semantic uncertainty or malformed output cannot force a handoff', () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API')], '帮我写一篇科幻小说', undefined, reply);
    assert.equal(result.requests.length, 1);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

for (const env of [{RELAY_TEST_FETCH_ERROR:'1'}, {RELAY_TEST_FETCH_TIMEOUT:'1',AGENT_RELAY_TOPIC_TIMEOUT_MS:'25'}, {RELAY_TEST_STATUS:'503'}]) {
  test('unavailable semantic judge does not block ambiguous follow-up work', () => {
    const result = runHook(videoHistory, '帮我做一个用来播放视频的 React 页面', undefined, modelReply('switch', 0.99), env);
    assert.equal(result.requests.length, 1);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

test('/btw remains a side question and never starts a new session', () => {
  const result = runHook([user('设计 SQLite 数据库和后端 API')], '/btw 写一首诗歌', undefined, modelReply('switch', 1));
  assert.equal(result.requests.length, 0);
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

test('Windows Terminal target startup must be confirmed before blocking input', () => {
  const result = runHook([user('设计 SQLite 数据库和后端 API')], '帮我写一篇科幻小说', undefined, undefined, {
    AGENT_RELAY_HEADLESS:'0',RELAY_TEST_INTERACTIVE:'1'
  });
  assert.equal(result.output?.decision, 'block');
  assert.equal(result.launches.length, 1);
});

for (const failure of [{RELAY_TEST_WT_SPAWN_FAIL:'1'}, {RELAY_TEST_WT_TARGET_FAIL:'1'}]) {
  test('failed Windows Terminal startup falls back without losing input', () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API')], '帮我写一篇科幻小说', undefined, undefined, {
      AGENT_RELAY_HEADLESS:'0',RELAY_TEST_INTERACTIVE:'1',RELAY_TEST_WORKER_FAIL:'1',...failure
    });
    assert.equal(result.launches.length, 2);
    assert.equal(result.output, null);
  });
}

test('local fallback keeps fiction requested as API test data in the same task', () => {
  const result = runHook([user('设计 SQLite 数据库和后端 API，支持生成小说，接下来需要测试数据')], '帮我写一篇科幻小说用于测试');
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

test('a correction followed by an independent request still reaches the semantic judge', () => {
  const result = runHook([user('创建一个 React 前端页面')], '你给的页面已经好了，另外帮我写一篇科幻小说，增加一点悬疑元素', undefined, modelReply('switch', 0.99));
  assert.equal(result.requests.length, 1);
  assert.equal(result.output?.decision, 'block');
});

test('interactive launcher cancels a target that starts after the hook timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-late-launch-'));
  try {
    const readyPath = path.join(dir, 'ready.json');
    const cancelPath = path.join(dir, 'cancel');
    const killed = path.join(dir, 'killed');
    const configPath = path.join(dir, 'launch.json');
    const preload = path.join(dir, 'delay-spawn.mjs');
    fs.writeFileSync(configPath, JSON.stringify({workspacePath:dir,sessionId:'late-session',title:'test',prompt:'fixture',claudeBin:'fake-claude',sessionDir:path.join(dir,'sessions'),readyPath,cancelPath}));
    fs.writeFileSync(preload, `
      import cp from 'node:child_process'; import fs from 'node:fs';
      import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
      cp.spawn = () => {
        fs.writeFileSync(process.env.RELAY_CANCEL, '');
        const child = new EventEmitter();
        child.kill = () => fs.writeFileSync(process.env.RELAY_KILLED, 'yes');
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }; syncBuiltinESMExports();
    `);
    const launcher = fileURLToPath(new URL('../../integrations/claude-package/lib/launch-interactive.mjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--import',pathToFileURL(preload).href,launcher,configPath], {encoding:'utf8',timeout:3000,env:{...process.env,RELAY_CANCEL:cancelPath,RELAY_KILLED:killed}});
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(killed), true);
    assert.equal(fs.existsSync(readyPath), false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

for (const extraEnv of [{RELAY_TEST_LAUNCH_FAIL:'1'}, {RELAY_TEST_WORKER_FAIL:'1'}]) {
  test('a failed target startup cannot suppress the original user request', () => {
    const result = runHook([user('设计 SQLite 数据库和后端 API')], '帮我写一篇科幻小说', undefined, undefined, extraEnv);
    assert.equal(result.launches.length, 1);
    assert.equal(result.output, null);
  });
}

test('prompt hook uses recent user context rather than freezing the initial domain', () => {
  const result = runHook([
    user('写宣传文档和 README markdown report'), assistant('文档完成'),
    ...Array.from({ length: 20 }, () => ({ type: 'progress' })),
    user('使用 React 和 Tailwind CSS 构建前端页面'), assistant('前端完成')
  ], '换个任务，创建一个 React 和 CSS 前端页面');
  assert.equal(result.output, null);
  assert.equal(result.launches.length, 0);
});

test('prompt hook excludes the incoming prompt when it is already in the transcript', () => {
  const prompt = '换个话题，帮我写一篇科幻小说';
  const result = runHook([user('设计 SQLite 数据库和后端 API'), assistant('完成'), user(prompt)], prompt);
  assert.equal(result.output?.decision, 'block');
  assert.equal(result.launches.length, 1);
});

for (const messages of [[], [{ type: 'system' }, assistant('SQLite API 后端 数据库')], [{ type: 'progress' }, user('换个话题，帮我写一篇科幻小说')]]) {
  test('prompt hook never hands off a first user turn', () => {
    const result = runHook(messages, '换个话题，帮我写一篇科幻小说');
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

for (const rawInput of ['', '{broken json', JSON.stringify({ prompt: '换个话题，帮我写小说' })]) {
  test('prompt hook lets incomplete input pass without launching a worker', () => {
    const result = runHook([], '', rawInput);
    assert.equal(result.output, null);
    assert.equal(result.launches.length, 0);
  });
}

test('domain classifier does not match English keywords inside unrelated words', () => {
  assert.equal(classifyDomain('describe a beautiful building').primaryDomain, 'general');
  assert.equal(classifyDomain('testimonials and shipping details').primaryDomain, 'general');
  assert.equal(classifyDomain('打开html页面').primaryDomain, 'frontend_ui');
});
