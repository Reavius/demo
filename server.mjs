import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SEED } from './seed.js';
import { BAR } from './bar-data.js';
import { venueCore } from './core.js';
import { JsonStore } from './store.mjs';
import { createTelegramBot } from './telegram-bot.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const MAX_BODY = 6 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'mechty_admin';
const PERSONAL_DATA_READY = String(process.env.PERSONAL_DATA_READY || '').toLowerCase() === 'true';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');

if (ADMIN_PASSWORD.length < 14) {
  console.error('ОШИБКА: задайте ADMIN_PASSWORD длиной не менее 14 символов в переменных окружения или .env.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const store = new JsonStore(path.join(DATA_DIR, 'store.json'));
const core = venueCore({
  seed: SEED,
  store,
  bar: () => BAR,
  dataImg: false,
  upload: (mime, base64) => {
    const extension = mime === 'jpeg' ? 'jpg' : mime;
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${extension}`;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Файл больше 4 МБ.');
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer, { flag: 'wx' });
    return `/uploads/${filename}`;
  }
});

const passwordSalt = crypto.randomBytes(16);
const passwordHash = crypto.scryptSync(ADMIN_PASSWORD, passwordSalt, 64);
const sessions = new Map();
const loginAttempts = new Map();
const requestBuckets = new Map();

const adminChatIds = String(process.env.TELEGRAM_ADMIN_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const telegram = createTelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  adminChatIds,
  core,
  store,
  venueName: 'Мечты',
  siteUrl: process.env.PUBLIC_SITE_URL || '',
  bookingReady: PERSONAL_DATA_READY
});

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', ...extraHeaders });
  res.end(payload);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;
  const expires = sessions.get(token);
  if (!expires || expires < Date.now()) { sessions.delete(token); return null; }
  return token;
}

function cookieHeader(token, maxAge) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (NODE_ENV === 'production' || String(process.env.TRUST_PROXY || '') === '1') parts.push('Secure');
  return parts.join('; ');
}

function requestIp(req) {
  if (String(process.env.TRUST_PROXY || '') === '1') {
    const realIp = req.headers['x-real-ip'];
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean).at(-1);
    return String(realIp || forwarded || req.socket.remoteAddress || 'unknown').trim();
  }
  return String(req.socket.remoteAddress || 'unknown');
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const trustedForwardedHost = String(process.env.TRUST_PROXY || '') === '1' ? req.headers['x-forwarded-host'] : '';
    const forwardedHost = String(trustedForwardedHost || req.headers.host || '').split(',')[0].trim();
    return parsed.host === forwardedHost;
  } catch { return false; }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw Object.assign(new Error('Ожидается Content-Type: application/json.'), { status: 415 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Некорректный JSON.'), { status: 400 }); }
}

function rateLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function getBooking(id) {
  const inbox = store.get('inbox', {});
  return (inbox.book || []).find(item => item.id === id) || null;
}

function apiResult(method, pathname, body, isAdmin) {
  return core.handle(method, pathname, body, isAdmin);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';
  if (!['GET', 'POST'].includes(method)) return sendJson(res, 405, { error: 'Метод не поддерживается.' }, { allow: 'GET, POST' });
  if (method === 'POST' && !allowedOrigin(req)) return sendJson(res, 403, { error: 'Запрос с другого сайта запрещён.' });

  const isLogin = pathname === '/api/admin/login' && method === 'POST';
  if (method === 'POST' && ['/api/book', '/api/banquet', '/api/job'].includes(pathname) && !PERSONAL_DATA_READY) {
    return sendJson(res, 503, { error: 'Приём заявок временно отключён до заполнения политики конфиденциальности.' });
  }
  const ip = requestIp(req);
  if (isLogin && !rateLimit(loginAttempts, ip, 5, 15 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' }, { 'retry-after': '900' });
  }
  if (method === 'POST' && ['/api/book', '/api/banquet', '/api/job'].includes(pathname) && !rateLimit(requestBuckets, `${ip}:${pathname}`, 20, 10 * 60 * 1000)) {
    return sendJson(res, 429, { error: 'Слишком много заявок. Попробуйте позже или позвоните нам.' }, { 'retry-after': '600' });
  }

  let body = {};
  if (method === 'POST') {
    try { body = await readJson(req); }
    catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
  }

  if (isLogin) {
    const supplied = String(body.pw || '');
    const candidate = crypto.scryptSync(supplied, passwordSalt, 64);
    const valid = supplied.length <= 1024 && crypto.timingSafeEqual(candidate, passwordHash);
    if (!valid) return sendJson(res, 401, { error: 'Неверный пароль.' });
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    loginAttempts.delete(ip);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader(token, SESSION_TTL_MS / 1000) });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const token = getSession(req);
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
  }

  const isAdmin = Boolean(getSession(req));
  const result = apiResult(method, pathname, body, isAdmin);
  if (result.code !== 200) return sendJson(res, result.code, result.body);

  if (method === 'GET' && pathname === '/api/site') {
    const username = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
    if (PERSONAL_DATA_READY && process.env.TELEGRAM_BOT_TOKEN && adminChatIds.length && /^[A-Za-z0-9_]{5,32}$/.test(username)) {
      result.body.info = { ...result.body.info, bookingBotUrl: `https://t.me/${username}` };
    }
  }

  if (method === 'POST' && pathname === '/api/book') {
    const booking = getBooking(result.body.id);
    if (booking) {
      const inbox = store.get('inbox', {});
      const actual = (inbox.book || []).find(item => item.id === booking.id);
      if (actual && !actual.source) { actual.source = 'site'; store.set('inbox', inbox); }
      void telegram.notifyAdmins(booking, 'сайт');
    }
  }

  if (method === 'POST' && pathname === '/api/admin/status' && body.box === 'book') {
    const booking = getBooking(body.id);
    if (booking && ['ok', 'no'].includes(body.st)) void telegram.notifyGuest(booking, body.st);
  }

  return sendJson(res, 200, result.body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.av1': 'video/mp4', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};
const ROOT_FILES = new Set(['index.html', 'admin.html', 'privacy.html', 'robots.txt', 'venue.css', 'site.js', 'admin.js', 'sw.js', 'manifest.webmanifest', 'bar-data.js', 'seed.js', 'core.js', '.nojekyll']);
const PUBLIC_DIRS = new Set(['media', 'photos', 'icons', 'vendor', 'uploads']);

function staticPath(urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(urlPath); } catch { return null; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length || segments.some(part => part === '.' || part === '..' || part.startsWith('.'))) return null;
  if (segments.length > 1 && segments[0] === 'uploads') {
    const uploadPath = path.resolve(UPLOAD_DIR, ...segments.slice(1));
    return uploadPath.startsWith(`${UPLOAD_DIR}${path.sep}`) ? uploadPath : null;
  }
  if (segments.length === 1 && !ROOT_FILES.has(segments[0])) return null;
  if (segments.length > 1 && !PUBLIC_DIRS.has(segments[0])) return null;
  const filePath = path.resolve(ROOT, ...segments);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) return null;
  return filePath;
}

async function handleStatic(req, res, url) {
  const filePath = staticPath(url.pathname);
  if (!filePath) { res.writeHead(404); return res.end('Not found'); }
  let stat;
  try { stat = await fs.promises.stat(filePath); }
  catch { res.writeHead(404); return res.end('Not found'); }
  if (!stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin'
  };
  if (ext === '.html' || ['.js', '.css', '.webmanifest'].includes(ext)) headers['cache-control'] = 'no-cache';
  else headers['cache-control'] = 'public, max-age=86400';
  if (path.basename(filePath) === 'admin.html') headers['x-robots-tag'] = 'noindex, nofollow';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

export function createVenueServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'HEAD') return sendJson(res, 405, { error: 'Метод не поддерживается.' });
        return await handleApi(req, res, url);
      }
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }
      return await handleStatic(req, res, url);
    } catch (error) {
      console.error('[server] Ошибка запроса:', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера.' });
      else res.destroy();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createVenueServer();
  server.listen(PORT, HOST, () => {
    console.log(`Сайт «Мечты» запущен: http://${HOST}:${PORT}`);
    console.log(`Данные: ${path.join(DATA_DIR, 'store.json')}`);
    telegram.start();
  });
  const shutdown = async () => {
    server.close();
    await telegram.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
