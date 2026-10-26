#!/usr/bin/env node
/**
 * 任务面板 · 本地服务
 * ------------------------------------------------------------------
 * 作用：
 *   1) 以 http://127.0.0.1:5173 托管这个纯静态面板
 *   2) 提供 /api/push，把面板里的任务写入 data/tasks.json，然后 git commit + push
 *
 * 零依赖，只用 Node 内置模块。仅监听回环地址，不对外网开放。
 *
 * 用法：node server.js [--open]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile, exec } = require('child_process');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 5173;
const BRANCH = 'main';
const REMOTE = 'origin';
const DATA_FILE = path.join(ROOT, 'data', 'tasks.json');
const OPEN_BROWSER = process.argv.includes('--open');

// git 在这里必须是「非交互」的：否则密钥没配好时按钮会一直转圈
const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10',
  LC_ALL: 'C.UTF-8',
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/* ------------------------------ 工具 ------------------------------ */

function git(args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: ROOT, env: GIT_ENV, timeout: 90000, windowsHide: true, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || '').trim(),
          err: String(stderr || (err && err.message) || '').trim(),
        });
      }
    );
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 过滤 git 的换行符噪音，并限制日志长度
function tidy(text, maxLines = 60) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/LF will be replaced by CRLF/i.test(l));
  return (lines.length > maxLines ? lines.slice(-maxLines) : lines).join('\n');
}

function sendJSON(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------ 业务 ------------------------------ */

async function status() {
  const [branch, dirty, last, ahead] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain']),
    git(['log', '-1', '--format=%h|%s|%cI']),
    git(['rev-list', '--count', '@{u}..HEAD']),
  ]);

  const changed = dirty.ok && dirty.out ? dirty.out.split('\n').filter(Boolean).length : 0;
  const [sha, msg, date] = last.ok && last.out ? last.out.split('|') : ['', '', ''];

  return {
    branch: branch.ok ? branch.out : BRANCH,
    remote: (await git(['remote', 'get-url', REMOTE])).out,
    changed,
    ahead: ahead.ok ? Number(ahead.out) || 0 : 0,
    lastCommit: sha ? { sha, msg, date } : null,
    hasBackup: fs.existsSync(DATA_FILE),
  };
}

async function push(payload) {
  const log = [];
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];

  // 1. 落盘：面板数据 → data/tasks.json
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const backup = { updatedAt: new Date().toISOString(), count: tasks.length, tasks };
  await fsp.writeFile(DATA_FILE, JSON.stringify(backup, null, 2), 'utf8');
  log.push(`[1/4] 写入 data/tasks.json（${tasks.length} 条任务）`);

  // 2. 暂存
  const add = await git(['add', '-A']);
  if (!add.ok) return { ok: false, error: 'git add 失败', log: log.concat(tidy(add.err)) };
  log.push('[2/4] git add -A 完成');

  // 3. 提交（无改动则跳过，但后面仍然尝试推送，方便上次推送失败后重试）
  const dirty = await git(['status', '--porcelain']);
  const changed = dirty.out ? dirty.out.split('\n').filter(Boolean) : [];
  if (changed.length) {
    const message = `sync: ${tasks.length} tasks @ ${stamp()}`;
    const commit = await git(['commit', '-m', message]);
    if (!commit.ok) return { ok: false, error: 'git commit 失败', log: log.concat(tidy(commit.err)) };
    log.push(`[3/4] 已提交 ${changed.length} 个文件：${message}`);
  } else {
    log.push('[3/4] 工作区没有新改动，跳过提交');
  }

  // 4. 推送
  const pushed = await git(['push', '-u', REMOTE, BRANCH]);
  if (!pushed.ok) {
    const detail = tidy([pushed.err, pushed.out].filter(Boolean).join('\n'));
    let hint = '';
    if (/Permission denied \(publickey\)/i.test(detail)) {
      hint = 'SSH 公钥还没登记到 GitHub，或仓库地址不对。';
    } else if (/Could not resolve host|Connection timed out/i.test(detail)) {
      hint = '连不上 github.com，检查网络或代理。';
    } else if (/rejected|non-fast-forward/i.test(detail)) {
      hint = '远端有新提交，先执行 git pull --rebase。';
    }
    return { ok: false, error: hint || 'git push 失败', log: log.concat(detail) };
  }

  const upToDate = /Everything up-to-date/i.test(pushed.out + pushed.err);
  const sha = (await git(['rev-parse', '--short', 'HEAD'])).out;
  log.push(upToDate ? '[4/4] 远端已是最新，无需推送' : `[4/4] 推送成功 → ${sha}`);

  return { ok: true, sha, upToDate, log };
}

/* ------------------------------ 路由 ------------------------------ */

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    // 防 DNS rebinding：只接受回环 Host
    const host = String(req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJSON(res, 200, await status());
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        try {
          const raw = await fsp.readFile(DATA_FILE, 'utf8');
          return sendJSON(res, 200, JSON.parse(raw));
        } catch (e) {
          return sendJSON(res, 200, { tasks: [] });
        }
      }

      if (pathname === '/api/push' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          return sendJSON(res, 403, { ok: false, error: '来源不被允许' });
        }
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = JSON.parse(raw || '{}');
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        }
        const result = await push(payload);
        return sendJSON(res, result.ok ? 200 : 500, result);
      }

      if (pathname.startsWith('/api/')) {
        return sendJSON(res, 404, { ok: false, error: '未知接口' });
      }

      return serveStatic(req, res, pathname);
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message, log: [String(e.stack || e)] });
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */

function openBrowser(url) {
  if (OPEN_BROWSER && process.platform === 'win32') {
    exec(`start "" "${url}"`, { shell: 'cmd.exe' });
  }
}

// 探测某个端口上是不是「本服务」已经在跑
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port, path: '/api/status', timeout: 1200 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(res.statusCode === 200 && typeof data.branch === 'string');
          } catch (e) {
            resolve(false);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function listen(server, port, tries = 0) {
  let retry = false;

  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') {
      console.error('[启动失败]', e.message);
      process.exit(1);
    }

    // 端口被占用：先看是不是自己已经跑着了。
    // 直接复用旧实例，绝不顺延端口——端口不同就是不同 origin，
    // localStorage 会另开一份，用户会以为任务全丢了。
    if (await probe(port)) {
      const url = `http://${HOST}:${port}/`;
      console.log('');
      console.log(`  已有实例在 ${port} 端口运行，直接使用它：`);
      console.log('  ' + url);
      console.log('');
      openBrowser(url);
      process.exit(0);
    }

    if (tries < 10) {
      retry = true;
      listen(server, port + 1, tries + 1);
    } else {
      console.error('[启动失败] 端口都被占用了');
      process.exit(1);
    }
  });

  server.listen(port, HOST, () => {
    if (retry) return;
    const url = `http://${HOST}:${port}/`;
    console.log('');
    console.log('  任务面板已启动');
    console.log('  ' + url);
    console.log('');
    console.log('  · 上传按钮会把任务写入 data/tasks.json 并推送到 GitHub');
    console.log('  · 关闭这个窗口即停止服务');
    console.log('');
    openBrowser(url);
  });
}

listen(createServer(), BASE_PORT);
