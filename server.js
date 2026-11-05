const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ---------------------------------------------------------------
// GITHUB STORAGE
// Render > Environment এ:
//   FFX-G      = আপনার GitHub Token (Contents: Read and write)
//   FFX-REPO   = username/repo   (না দিলে Render নিজে থেকে বসিয়ে নেয়)
//   FFX-BRANCH = ডাটা রাখার branch (না দিলে ffx-data, অটো বানাবে)
// ---------------------------------------------------------------
const GH_TOKEN = process.env['FFX-G'] || process.env.FFX_G || '';
const GH_REPO = (process.env['FFX-REPO'] || process.env.FFX_REPO || process.env.RENDER_GIT_REPO_SLUG || '').trim();
const GH_BRANCH = (process.env['FFX-BRANCH'] || process.env.FFX_BRANCH || 'ffx-data').trim();
const GH_API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const GH_DIR = 'ffx-data';
const USE_GH = !!GH_TOKEN;

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

// ---------------------------------------------------------------
// ADMIN SETTINGS
// Render > Environment এ Key = FFX-PASS, Value = আপনার পাসওয়ার্ড
// (FFX_PASS নামেও কাজ করবে)
// GitHub সেট না থাকলে ছবি ও সেটিংস লোকাল DATA_DIR এ (না দিলে ./data) সেভ হবে
// ---------------------------------------------------------------
const ADMIN_PASSWORD = process.env['FFX-PASS'] || process.env.FFX_PASS || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 ঘণ্টা
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

// এই ফাইলগুলো কখনো পাবলিকলি দেখানো হবে না
const BLOCKED_NAMES = new Set(['server.js', 'package.json', 'package-lock.json', 'admin.html']);

// ---------------------------------------------------------------
// CONFIG (লোগো, FF Like ব্যানার, প্রাইস)
// ---------------------------------------------------------------
const DEFAULT_PACKAGES = [
  { label: '200 FF LIKE- প্রতিদিন ১ আইডিতে ১বার', name: '200 FF LIKE', price: 30 },
  { label: '3000 FF LIKE- 15 দিন এ পাবেন', name: '3000 FF LIKE', price: 450 },
  { label: '6000 FF LIKE- 30 দিন এ পাবেন', name: '6000 FF LIKE', price: 900 },
  { label: '12000 FF LIKE- 60 দিন এ পাবেন', name: '12000 FF LIKE', price: 1800 }
];

const DEFAULT_BANNERS = ['default:Banner 1.jpg', 'default:Banner 2.jpg', 'default:Banner 3.jpg'];
const DEFAULT_QUICK = [
  { label: 'Telegram', url: '' },
  { label: 'Join Group', url: '' },
  { label: 'YouTube', url: '' }
];
const MAX_BANNERS = 10;

let config = { logo: null, ffBanner: null, ffPackages: null, banners: null, quick: null };
let renderCache = null; // { mtime, cfgVersion, raw, gz }
let cfgVersion = 0;

const SAFE_FILE = /^[a-z0-9._-]+$/i;

function sanitizePackages(list) {
  if (!Array.isArray(list)) throw new Error('প্যাকেজ লিস্ট ঠিক নেই');
  if (list.length < 1) throw new Error('কমপক্ষে ১টি প্যাকেজ রাখতে হবে');
  if (list.length > 40) throw new Error('সর্বোচ্চ ৪০টি প্যাকেজ রাখা যাবে');
  return list.map(function (p, i) {
    const label = String((p && p.label) || '').trim().slice(0, 140);
    let name = String((p && p.name) || '').trim().slice(0, 100);
    const price = Number(p && p.price);
    if (!label) throw new Error('প্যাকেজ ' + (i + 1) + ': নাম/বিবরণ ফাঁকা');
    if (!Number.isFinite(price) || price < 0 || price > 10000000) throw new Error('প্যাকেজ ' + (i + 1) + ': প্রাইস ঠিক নেই');
    if (!name) name = label;
    return { label: label, name: name, price: Math.round(price * 100) / 100 };
  });
}

function sanitizeBanners(list) {
  if (!Array.isArray(list)) throw new Error('ব্যানার লিস্ট ঠিক নেই');
  if (list.length < 1) throw new Error('কমপক্ষে ১টি ব্যানার রাখতে হবে');
  if (list.length > MAX_BANNERS) throw new Error('সর্বোচ্চ ' + MAX_BANNERS + 'টি ব্যানার রাখা যাবে');
  return list.map(function (e) {
    e = String(e);
    if (DEFAULT_BANNERS.indexOf(e) !== -1 || SAFE_FILE.test(e)) return e;
    throw new Error('ব্যানারের নাম ঠিক নেই');
  });
}

function cleanUrl(u) {
  u = String(u == null ? '' : u).trim().slice(0, 300);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/^https?:\/\/[^\s<>"']+$/i.test(u)) throw new Error('লিংক ঠিক নেই');
  return u;
}

function sanitizeQuick(list) {
  if (!Array.isArray(list) || list.length !== 3) throw new Error('বাটনের তথ্য ঠিক নেই');
  return list.map(function (q, i) {
    return {
      label: String((q && q.label) || '').trim().slice(0, 30) || DEFAULT_QUICK[i].label,
      url: cleanUrl(q && q.url)
    };
  });
}

function bannerSrc(e) {
  return e.indexOf('default:') === 0 ? '/' + encodeURI(e.slice(8)) : '/uploads/' + e;
}
function bannerList() { return config.banners || DEFAULT_BANNERS; }
function isUploaded(e) { return typeof e === 'string' && e.indexOf('default:') !== 0 && SAFE_FILE.test(e); }

function loadLocal() {
  config = { logo: null, ffBanner: null, ffPackages: null, banners: null, quick: null };
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof j.logo === 'string' && SAFE_FILE.test(j.logo) && fs.existsSync(path.join(UPLOAD_DIR, j.logo))) config.logo = j.logo;
    if (typeof j.ffBanner === 'string' && SAFE_FILE.test(j.ffBanner) && fs.existsSync(path.join(UPLOAD_DIR, j.ffBanner))) config.ffBanner = j.ffBanner;
    if (j.ffPackages) config.ffPackages = sanitizePackages(j.ffPackages);
    if (j.banners) {
      const b = sanitizeBanners(j.banners).filter(function (e) { return !isUploaded(e) || fs.existsSync(path.join(UPLOAD_DIR, e)); });
      config.banners = b.length ? b : null;
    }
    if (j.quick) config.quick = sanitizeQuick(j.quick);
  } catch (e) { /* প্রথমবার ফাইল নাও থাকতে পারে */ }
  cfgVersion++;
  renderCache = null;
}

function writeLocalConfig(obj) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

// ---------------------------------------------------------------
// GITHUB API
// ---------------------------------------------------------------
const storage = { mode: USE_GH ? 'github' : 'local', ok: !USE_GH, error: null, repo: GH_REPO, branch: GH_BRANCH };
const shas = {}; // path -> সর্বশেষ জানা sha
let chain = Promise.resolve();
function enqueue(fn) { const run = chain.then(fn); chain = run.catch(function () {}); return run; }

function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
function contentsUrl(p) { return '/repos/' + GH_REPO + '/contents/' + encPath(p); }

async function gh(method, urlPath, body, accept) {
  const headers = {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ffx-admin'
  };
  if (body) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(GH_API + urlPath, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new Error('GitHub এর সাথে যোগাযোগ করা যাচ্ছে না, একটু পরে আবার চেষ্টা করুন');
  }
}

function ghErr(status) {
  if (status === 401) return new Error('GitHub টোকেন (FFX-G) ঠিক নেই বা মেয়াদ শেষ');
  if (status === 403) return new Error('GitHub: অনুমতি নেই বা রেট লিমিট। টোকেনে Contents → Read and write দিন');
  if (status === 404) return new Error('GitHub: repo (' + GH_REPO + ') পাওয়া যায়নি বা টোকেনের এই repo তে অ্যাক্সেস নেই');
  return new Error('GitHub সমস্যা (' + status + ')');
}

async function ensureBranch() {
  const b = await gh('GET', '/repos/' + GH_REPO + '/branches/' + encodeURIComponent(GH_BRANCH));
  if (b.ok) return;
  if (b.status !== 404) throw ghErr(b.status);
  // branch নেই: repo র ডিফল্ট branch থেকে নতুন বানাই
  const rp = await gh('GET', '/repos/' + GH_REPO);
  if (!rp.ok) throw ghErr(rp.status);
  const def = (await rp.json()).default_branch;
  const ref = await gh('GET', '/repos/' + GH_REPO + '/git/ref/heads/' + encodeURIComponent(def));
  if (!ref.ok) throw ghErr(ref.status);
  const sha = (await ref.json()).object.sha;
  const mk = await gh('POST', '/repos/' + GH_REPO + '/git/refs', { ref: 'refs/heads/' + GH_BRANCH, sha: sha });
  if (!mk.ok && mk.status !== 422) throw ghErr(mk.status);
}

async function ghPut(p, buf, msg) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { message: msg, content: buf.toString('base64'), branch: GH_BRANCH };
    if (shas[p]) body.sha = shas[p];
    const r = await gh('PUT', contentsUrl(p), body);
    if (r.ok) { shas[p] = (await r.json()).content.sha; return; }
    if (attempt === 0 && (r.status === 409 || r.status === 422)) {
      const g = await gh('GET', contentsUrl(p) + '?ref=' + encodeURIComponent(GH_BRANCH));
      if (g.ok) shas[p] = (await g.json()).sha; else delete shas[p];
      continue;
    }
    throw ghErr(r.status);
  }
  throw new Error('GitHub এ সেভ করা যায়নি, আবার চেষ্টা করুন');
}

async function ghDelete(p, msg) {
  const g = await gh('GET', contentsUrl(p) + '?ref=' + encodeURIComponent(GH_BRANCH));
  if (g.status === 404) return;
  if (!g.ok) throw ghErr(g.status);
  const sha = (await g.json()).sha;
  const r = await gh('DELETE', contentsUrl(p), { message: msg, sha: sha, branch: GH_BRANCH });
  delete shas[p];
  if (!r.ok && r.status !== 404) throw ghErr(r.status);
}

async function ghDownload(p) {
  const r = await gh('GET', contentsUrl(p) + '?ref=' + encodeURIComponent(GH_BRANCH), null, 'application/vnd.github.raw+json');
  if (!r.ok) throw ghErr(r.status);
  return Buffer.from(await r.arrayBuffer());
}

// চালু হওয়ার সময় GitHub থেকে সব নামিয়ে আনে
let retryTimer = null;
async function initStorage() {
  loadLocal(); // আগে লোকাল কপি, GitHub এ সমস্যা হলে এটাই চলবে
  if (!USE_GH) return;
  if (!GH_REPO) {
    storage.ok = false;
    storage.error = 'repo নাম পাওয়া যায়নি। Render Environment এ FFX-REPO = username/repo দিন';
    return;
  }
  try {
    await ensureBranch();
    const r = await gh('GET', contentsUrl(GH_DIR + '/config.json') + '?ref=' + encodeURIComponent(GH_BRANCH));
    if (r.ok) {
      const j = await r.json();
      shas[GH_DIR + '/config.json'] = j.sha;
      const remote = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const remoteFiles = [remote.logo, remote.ffBanner].concat(Array.isArray(remote.banners) ? remote.banners : []);
      for (const n of remoteFiles) {
        if (typeof n === 'string' && SAFE_FILE.test(n) && !fs.existsSync(path.join(UPLOAD_DIR, n))) {
          fs.writeFileSync(path.join(UPLOAD_DIR, n), await ghDownload(GH_DIR + '/uploads/' + n));
        }
      }
      writeLocalConfig(remote);
      loadLocal();
    } else if (r.status === 404) {
      // GitHub এ এখনো কিছু নেই: লোকালে যা আছে তা ওখানে তুলে দিই
      if (config.logo || config.ffBanner || config.ffPackages || config.banners || config.quick) {
        await enqueue(async function () {
          const localFiles = [config.logo, config.ffBanner].concat(config.banners || []).filter(isUploaded);
          for (const n of localFiles) {
            await ghPut(GH_DIR + '/uploads/' + n, fs.readFileSync(path.join(UPLOAD_DIR, n)), 'Initial sync');
          }
          await ghPut(GH_DIR + '/config.json', Buffer.from(JSON.stringify(config, null, 2)), 'Initial sync');
        });
      }
    } else {
      throw ghErr(r.status);
    }
    storage.ok = true;
    storage.error = null;
  } catch (e) {
    storage.ok = false;
    storage.error = e.message || 'GitHub সংযোগ হয়নি';
    console.log('GitHub init error:', storage.error);
    if (!retryTimer) {
      retryTimer = setTimeout(function () { retryTimer = null; ready = initStorage(); }, 30000);
      retryTimer.unref();
    }
  }
}

// কনফিগ বদলানো: আগে GitHub, তারপর লোকাল
async function commit(next, msg, add, del) {
  if (USE_GH && !storage.ok) throw new Error('GitHub এর সাথে এখনো সংযোগ হয়নি। উপরের "আবার চেষ্টা করুন" চাপুন।');
  if (USE_GH) {
    await enqueue(async function () {
      const done = [];
      try {
        for (const f of add) { await ghPut(GH_DIR + '/uploads/' + f.name, f.buf, msg); done.push(f.name); }
        await ghPut(GH_DIR + '/config.json', Buffer.from(JSON.stringify(next, null, 2)), msg);
      } catch (e) {
        for (const n of done) { try { await ghDelete(GH_DIR + '/uploads/' + n, 'Rollback'); } catch (_) {} }
        throw e;
      }
    });
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  add.forEach(function (f) { fs.writeFileSync(path.join(UPLOAD_DIR, f.name), f.buf); });
  writeLocalConfig(next);
  config = next;
  cfgVersion++;
  renderCache = null;
  del.forEach(function (n) {
    removeUpload(n);
    if (USE_GH) enqueue(function () { return ghDelete(GH_DIR + '/uploads/' + n, 'Remove old image'); }).catch(function () {});
  });
}

let ready = initStorage();

// ---------------------------------------------------------------
// মেইন সাইটের HTML (FFX.html) এ সেটিংস বসিয়ে পাঠানো
// ---------------------------------------------------------------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function packagesHtml(list) {
  return list.map(function (p) {
    return '        <button type="button" class="pk" data-name="' + esc(p.name) + '" data-price="' + esc(p.price) +
      '"><span>' + esc(p.label) + '</span><b>BDT ' + esc(p.price) + '</b></button>';
  }).join('\n');
}

function applySiteConfig(html) {
  // হোম ব্যানার স্লাইডার
  if (config.banners) {
    const slides = config.banners.map(function (e, i) {
      return '      <div class="slide"><img src="' + esc(bannerSrc(e)) + '" alt="Banner ' + (i + 1) + '" draggable="false" decoding="async"></div>';
    }).join('\n');
    const dots = config.banners.map(function (e, i) { return '<i' + (i === 0 ? ' class="on"' : '') + '></i>'; }).join('');
    html = html.replace(/(<div class="track" id="track">)[\s\S]*?(<\/div>\s*<div class="dots" id="dots">)[\s\S]*?(<\/div>)/, function (m, a, b, c) {
      return a + '\n' + slides + '\n    ' + b + dots + c;
    });
  }
  // Telegram / Join Group / YouTube বাটন
  if (config.quick) {
    const icons = ['tg', 'grp', 'yt'], keys = ['telegram-channel', 'telegram-group', 'youtube-channel'], small = ['Support', 'Group', 'Channel'];
    const items = config.quick.map(function (x, i) {
      return '    <a class="q" href="#" data-link="' + keys[i] + '"><span class="ic"><svg class="f"><use href="#' + icons[i] + '"/></svg></span><span><small>' + small[i] + '</small><b>' + esc(x.label) + '</b></span></a>';
    }).join('\n');
    html = html.replace(/(<div class="quick">)[\s\S]*?(<\/div>)/, function (m, a, b) { return a + '\n' + items + '\n  ' + b; });
    const L = { tgCh: config.quick[0].url, tgGrp: config.quick[1].url, yt: config.quick[2].url };
    if (L.tgCh || L.tgGrp || L.yt) {
      html = html.replace('window.ACCOUNT_CONFIG = window.ACCOUNT_CONFIG || {};', function (m) {
        return m + '\nwindow.__LINKS = ' + JSON.stringify(L).replace(/</g, '\\u003c') + ';';
      });
      html = html.split("bindLinks('[data-link=\"telegram-channel\"]', validTgCh);").join("bindLinks('[data-link=\"telegram-channel\"]', (window.__LINKS && window.__LINKS.tgCh) || validTgCh);");
      html = html.split("bindLinks('[data-link=\"telegram-group\"]', validTgGrp);").join("bindLinks('[data-link=\"telegram-group\"]', (window.__LINKS && window.__LINKS.tgGrp) || validTgGrp);");
      html = html.split("bindLinks('[data-link=\"youtube-channel\"]', validYtCh);").join("bindLinks('[data-link=\"youtube-channel\"]', (window.__LINKS && window.__LINKS.yt) || validYtCh);");
    }
  }
  return html;
}

function getHomePage(cb) {
  const file = path.join(ROOT_DIR, 'FFX.html');
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) return cb(null);
    if (renderCache && renderCache.mtime === st.mtimeMs && renderCache.cfgVersion === cfgVersion) return cb(renderCache);
    fs.readFile(file, 'utf8', function (e2, html) {
      if (e2) return cb(null);
      if (config.logo) html = html.split('Main logo.jpg').join('/uploads/' + config.logo);
      if (config.ffBanner) html = html.split('FF LIKES.jpg').join('/uploads/' + config.ffBanner);
      if (config.ffPackages) {
        html = html.replace(/(<div class="pk-grid" id="pkGrid">)[\s\S]*?(<\/div>)/, function (m, a, b) {
          return a + '\n' + packagesHtml(config.ffPackages) + '\n      ' + b;
        });
      }
      html = applySiteConfig(html);
      const raw = Buffer.from(html, 'utf8');
      zlib.gzip(raw, function (e3, gz) {
        renderCache = { mtime: st.mtimeMs, cfgVersion: cfgVersion, raw: raw, gz: e3 ? null : gz };
        cb(renderCache);
      });
    });
  });
}

function sendHome(req, res) {
  getHomePage(function (page) {
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const headers = {
      'Content-Type': MIME_TYPES['.html'],
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Vary': 'Accept-Encoding'
    };
    const wantsGzip = page.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (wantsGzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(wantsGzip ? page.gz : page.raw);
  });
}

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
const SECRET = crypto.createHash('sha256').update('ffx-admin-secret:' + ADMIN_PASSWORD).digest();

function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}
function sign(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function makeToken() { const exp = Date.now() + SESSION_MS; return { token: exp + '.' + sign(exp), expires: exp }; }
function checkToken(t) {
  if (!ADMIN_PASSWORD || typeof t !== 'string') return false;
  const parts = t.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return false;
  if (Number(parts[0]) < Date.now()) return false;
  return safeEq(parts[1], sign(parts[0]));
}
function isAuthed(req) {
  const h = req.headers['authorization'] || '';
  return checkToken(h.startsWith('Bearer ') ? h.slice(7).trim() : '');
}

// ভুল পাসওয়ার্ড দিয়ে বারবার চেষ্টা আটকানো
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // ip -> { n, first }
let globalFails = { n: 0, first: Date.now() };
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}
function lockedFor(ip) {
  const now = Date.now();
  if (now - globalFails.first > LOCK_MS) globalFails = { n: 0, first: now };
  if (globalFails.n >= 40) return LOCK_MS - (now - globalFails.first);
  const f = fails.get(ip);
  if (!f) return 0;
  if (now - f.first > LOCK_MS) { fails.delete(ip); return 0; }
  return f.n >= 5 ? LOCK_MS - (now - f.first) : 0;
}
function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > LOCK_MS) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
  globalFails.n++;
}
setInterval(function () {
  const now = Date.now();
  fails.forEach(function (v, k) { if (now - v.first > LOCK_MS) fails.delete(k); });
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const txt = await readBody(req, limit || 64 * 1024);
  try { return JSON.parse(txt || '{}'); } catch (e) { throw new Error('bad_json'); }
}

function currentView() {
  return {
    logo: config.logo ? '/uploads/' + config.logo : null,
    ffBanner: config.ffBanner ? '/uploads/' + config.ffBanner : null,
    packages: config.ffPackages || DEFAULT_PACKAGES,
    banners: bannerList().map(function (e) { return { id: e, src: bannerSrc(e), isDefault: !isUploaded(e) }; }),
    bannersCustom: !!config.banners,
    quick: config.quick || DEFAULT_QUICK,
    quickCustom: !!config.quick,
    maxBanners: MAX_BANNERS,
    defaults: { logo: '/Main logo.jpg', ffBanner: '/FF LIKES.jpg', packages: DEFAULT_PACKAGES },
    storage: { mode: storage.mode, ok: storage.ok, error: storage.error, repo: storage.repo, branch: storage.branch },
    persistent: USE_GH || !!process.env.DATA_DIR
  };
}

function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function removeUpload(name) {
  if (name && SAFE_FILE.test(name)) fs.unlink(path.join(UPLOAD_DIR, name), function () {});
}

const KINDS = { logo: { key: 'logo', prefix: 'logo' }, ffBanner: { key: 'ffBanner', prefix: 'ff-banner' } };

// ---------------------------------------------------------------
// API
// ---------------------------------------------------------------
async function handleApi(req, res, pathname) {
  try {
    if (req.method === 'POST' && pathname === '/api/admin/login') {
      if (!ADMIN_PASSWORD) return sendJson(res, 503, { error: 'Render এ FFX-PASS সেট করা নেই। Environment এ FFX-PASS যোগ করে আবার Deploy করুন।' });
      const ip = clientIp(req);
      const wait = lockedFor(ip);
      if (wait > 0) return sendJson(res, 429, { error: 'অনেকবার ভুল হয়েছে। ' + Math.ceil(wait / 60000) + ' মিনিট পরে আবার চেষ্টা করুন।' });
      const body = await readJson(req, 4096);
      if (typeof body.password === 'string' && safeEq(body.password, ADMIN_PASSWORD)) {
        fails.delete(ip);
        const t = makeToken();
        return sendJson(res, 200, { token: t.token, expires: t.expires });
      }
      recordFail(ip);
      await new Promise(function (r) { setTimeout(r, 500); });
      return sendJson(res, 401, { error: 'পাসওয়ার্ড ঠিক নেই' });
    }

    if (!pathname.startsWith('/api/admin/')) return sendJson(res, 404, { error: 'Not found' });
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'লগইন করুন' });

    if (req.method === 'GET' && pathname === '/api/admin/config') {
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/packages') {
      const body = await readJson(req, 128 * 1024);
      const next = Object.assign({}, config, { ffPackages: sanitizePackages(body.packages) });
      await commit(next, 'Update FF Like packages', [], []);
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/upload') {
      const body = await readJson(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
      const kind = KINDS[body.kind];
      if (!kind) return sendJson(res, 400, { error: 'ভুল ধরন' });
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
      if (!m) return sendJson(res, 400, { error: 'শুধু PNG, JPG বা WEBP ছবি দিন' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: 'ছবি ৩MB এর বেশি বড়' });
      const ext = detectImage(buf);
      if (!ext) return sendJson(res, 400, { error: 'ছবিটা ঠিক নেই' });
      const fname = kind.prefix + '-' + Date.now() + '.' + ext;
      const old = config[kind.key];
      const next = Object.assign({}, config);
      next[kind.key] = fname;
      await commit(next, 'Update ' + kind.prefix, [{ name: fname, buf: buf }], old ? [old] : []);
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/quick') {
      const body = await readJson(req, 8 * 1024);
      const next = Object.assign({}, config, { quick: sanitizeQuick(body.items) });
      await commit(next, 'Update quick buttons', [], []);
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/banner') {
      const body = await readJson(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
      const act = body.action;
      const list = bannerList().slice();
      const add = [], del = [];
      const idx = Number(body.index);
      const readImg = function () {
        const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
        if (!m) throw new Error('শুধু PNG, JPG বা WEBP ছবি দিন');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_UPLOAD_BYTES) throw new Error('ছবি ৩MB এর বেশি বড়');
        const ext = detectImage(buf);
        if (!ext) throw new Error('ছবিটা ঠিক নেই');
        return { name: 'banner-' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.' + ext, buf: buf };
      };
      const okIdx = function (i) { return Number.isInteger(i) && i >= 0 && i < list.length; };
      if (act === 'add') {
        if (list.length >= MAX_BANNERS) throw new Error('সর্বোচ্চ ' + MAX_BANNERS + 'টি ব্যানার রাখা যাবে');
        const f = readImg(); add.push(f); list.push(f.name);
      } else if (act === 'replace') {
        if (!okIdx(idx)) throw new Error('ব্যানার পাওয়া যায়নি');
        const f = readImg(); add.push(f);
        const old = list[idx]; list[idx] = f.name;
        if (isUploaded(old)) del.push(old);
      } else if (act === 'delete') {
        if (list.length <= 1) throw new Error('কমপক্ষে ১টি ব্যানার রাখতে হবে');
        if (!okIdx(idx)) throw new Error('ব্যানার পাওয়া যায়নি');
        const old = list.splice(idx, 1)[0];
        if (isUploaded(old)) del.push(old);
      } else if (act === 'move') {
        const to = idx + (body.dir === 'up' ? -1 : 1);
        if (!okIdx(idx) || to < 0 || to >= list.length) throw new Error('সরানো যাচ্ছে না');
        const t = list[idx]; list[idx] = list[to]; list[to] = t;
      } else {
        throw new Error('ভুল কাজ');
      }
      const next = Object.assign({}, config, { banners: list });
      await commit(next, 'Update banners', add, del);
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/reset') {
      const body = await readJson(req, 4096);
      const next = Object.assign({}, config);
      let del = [];
      if (body.kind === 'packages') {
        next.ffPackages = null;
      } else if (body.kind === 'quick') {
        next.quick = null;
      } else if (body.kind === 'banners') {
        del = (config.banners || []).filter(isUploaded);
        next.banners = null;
      } else {
        const kind = KINDS[body.kind];
        if (!kind) return sendJson(res, 400, { error: 'ভুল ধরন' });
        if (config[kind.key]) del = [config[kind.key]];
        next[kind.key] = null;
      }
      await commit(next, 'Reset ' + String(body.kind), [], del);
      return sendJson(res, 200, currentView());
    }

    if (req.method === 'POST' && pathname === '/api/admin/resync') {
      ready = initStorage();
      await ready;
      return sendJson(res, 200, currentView());
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e && e.message === 'too_large') return sendJson(res, 413, { error: 'ডাটা অনেক বড়' });
    if (e && e.message === 'bad_json') return sendJson(res, 400, { error: 'ভুল ডাটা' });
    return sendJson(res, 400, { error: (e && e.message) || 'কিছু একটা সমস্যা হয়েছে' });
  }
}

// ---------------------------------------------------------------
// SERVER
// ---------------------------------------------------------------
const server = http.createServer((req, res) => {
  ready.then(function () { handle(req, res); }).catch(function () {
    try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('500 Internal Server Error'); } catch (e) {}
  });
});

function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURI(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  // API
  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname);
  }

  // ADMIN PANEL
  if (pathname === '/admin' || pathname === '/admin/') {
    const f = path.join(ROOT_DIR, 'admin.html');
    return fs.readFile(f, function (err, data) {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('admin.html পাওয়া যায়নি');
      }
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.html'],
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(data);
    });
  }

  // আপলোড করা ছবি (লোগো / ব্যানার)
  if (pathname.startsWith('/uploads/')) {
    const name = pathname.slice('/uploads/'.length);
    if (!SAFE_FILE.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    return serveFile(path.join(UPLOAD_DIR, name), res, 'public, max-age=31536000, immutable');
  }

  // HOME
  if (pathname === '/' || pathname === '' || pathname === '/index.html' || pathname === '/FFX.html') {
    return sendHome(req, res);
  }

  // Prevent directory traversal + কনফিডেনশিয়াল ফাইল ব্লক
  const filePath = path.normalize(path.join(ROOT_DIR, pathname));
  const rel = path.relative(ROOT_DIR, filePath);
  const base = path.basename(filePath).toLowerCase();
  const insideData = filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  if (insideData || BLOCKED_NAMES.has(base) || base.startsWith('.') || rel.split(path.sep).some(function (p) { return p === 'node_modules' || p.startsWith('.'); })) {
    return sendHome(req, res); // আগের মতো: পাওয়া না গেলে হোম পেজ
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback: If route not found, serve FFX.html
      return sendHome(req, res);
    }
    serveFile(filePath, res, 'public, max-age=3600');
  });
}

function serveFile(filePath, res, cache) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const stream = fs.createReadStream(filePath);
  stream.on('open', () => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', cache || 'public, max-age=3600');
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } else {
      res.end();
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  if (!ADMIN_PASSWORD) console.log('⚠️  FFX-PASS সেট করা নেই — /admin লগইন বন্ধ থাকবে');
  console.log(USE_GH ? 'Storage: GitHub (' + (GH_REPO || '?') + ' @ ' + GH_BRANCH + ')' : 'Storage: লোকাল (FFX-G সেট করা নেই)');
});
