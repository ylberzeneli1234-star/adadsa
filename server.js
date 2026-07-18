// ============================================
// messagebot — multi-tenant Facebook Messenger bot
// One Railway service, many pages, one webhook URL
// ============================================
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const basicAuth = require('express-basic-auth');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================
// ENV VARS
// ============================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'abc123';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const PORT = process.env.PORT || 8080;

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || '');

// Storage on /data volume if mounted, otherwise local (ephemeral!)
const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';
const PAGES_FILE = `${DATA_DIR}/pages.json`;
console.log(`💾 Data directory: ${DATA_DIR}`);
if (DATA_DIR !== '/data') {
  console.warn('⚠️  No /data volume mounted — fan lists will wipe on redeploy!');
}

const STARTED_AT = new Date();

// ============================================
// DEFAULTS (from env vars, fall back to hardcoded)
// Used when adding a new page with optional fields blank
// ============================================
function getDefaults() {
  return {
    whatsapp: process.env.DEFAULT_WHATSAPP || 'https://scrollgallery.com/?p=50328',
    photos: (process.env.DEFAULT_PHOTOS
      ? process.env.DEFAULT_PHOTOS.split(',').map(s => s.trim()).filter(Boolean)
      : [
          'https://i.imgur.com/2J3Jne9.png',
          'https://i.imgur.com/0gCjxrP.png',
          'https://i.imgur.com/aDQ1ScR.png',
          'https://i.imgur.com/MHT57vc.png'
        ]),
    title: process.env.DEFAULT_TITLE || 'Heyy darling 💕',
    subtitle: process.env.DEFAULT_SUBTITLE || "I'm on WhatsApp... lets talk",
    buttonText: process.env.DEFAULT_BUTTON_TEXT || 'My Photos 📞',
    broadcastTime: process.env.DEFAULT_BROADCAST_TIME || '07:30',
    timezone: process.env.DEFAULT_TIMEZONE || 'UTC',
    broadcastEnabled: false,        // NEW DEFAULT: paused
    spacingSeconds: parseInt(process.env.DEFAULT_SPACING_SECONDS) || 10,
    cleanupThreshold: 0             // NEW DEFAULT: disabled (never remove fans)
  };
}

// ============================================
// PAGES STORAGE (pages.json on volume)
// ============================================
function loadPages() {
  try { return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8')); }
  catch { return []; }
}
function savePages(pages) {
  fs.writeFileSync(PAGES_FILE, JSON.stringify(pages, null, 2));
}
function getPage(pageId) {
  return loadPages().find(p => p.pageId === pageId);
}
function updatePage(pageId, updates) {
  const pages = loadPages();
  const idx = pages.findIndex(p => p.pageId === pageId);
  if (idx < 0) return null;
  pages[idx] = { ...pages[idx], ...updates };
  savePages(pages);
  return pages[idx];
}
function addPage(data) {
  const pages = loadPages();
  if (pages.find(p => p.pageId === data.pageId)) return null;
  const d = getDefaults();
  const photos = (data.photos && data.photos.length) ? data.photos : d.photos;
  const newPage = {
    pageId: String(data.pageId).trim(),
    accessToken: String(data.accessToken).trim(),
    label: data.label || `Page ${data.pageId}`,
    title: data.title || d.title,
    subtitle: data.subtitle || d.subtitle,
    buttonText: data.buttonText || d.buttonText,
    whatsapp: data.whatsapp || d.whatsapp,
    photos: photos,
    currentPhoto: data.currentPhoto || photos[0],
    broadcastTime: data.broadcastTime || d.broadcastTime,
    timezone: data.timezone || d.timezone,
    broadcastEnabled: false,         // always paused on creation
    sendNowEnabled: data.sendNowEnabled !== undefined ? data.sendNowEnabled : true,
    spacingSeconds: data.spacingSeconds || d.spacingSeconds,
    cleanupThreshold: 0,             // always disabled on creation
    baselineFans: data.baselineFans || 0,
    group: data.group || '',         // PAGE GROUP (e.g. "Part 1", "Part 2")
    createdAt: new Date().toISOString()
  };
  pages.push(newPage);
  savePages(pages);
  return newPage;
}
function removePage(pageId) {
  const pages = loadPages().filter(p => p.pageId !== pageId);
  savePages(pages);
  try { fs.unlinkSync(`${DATA_DIR}/fans-${pageId}.json`); } catch {}
  try { fs.unlinkSync(`${DATA_DIR}/stats-${pageId}.json`); } catch {}
}

// ============================================
// PAGE GROUPS HELPERS
// ============================================
function getAllGroups(pages) {
  pages = pages || loadPages();
  const s = loadSettings();
  const saved = Array.isArray(s.groups) ? s.groups : [];
  const fromPages = pages.map(p => (p.group || '').trim()).filter(Boolean);
  const all = [...new Set([...saved, ...fromPages])];
  return all.sort();
}

function saveGroupName(name) {
  name = (name || '').trim();
  if (!name) return;
  const s = loadSettings();
  s.groups = Array.isArray(s.groups) ? s.groups : [];
  if (!s.groups.includes(name)) { s.groups.push(name); s.groups.sort(); saveSettings(s); }
}

function deleteGroupName(name) {
  const s = loadSettings();
  s.groups = (Array.isArray(s.groups) ? s.groups : []).filter(g => g !== name);
  saveSettings(s);
}

// ============================================
// SHARED LIBRARY (library.json on volume)
// ============================================
const LIBRARY_FILE = `${DATA_DIR}/library.json`;

// ============================================
// GLOBAL SETTINGS (settings.json)
// ============================================
const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { contentMode: 'classic' }; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }
function getGlobalContentMode() {
  const s = loadSettings();
  return s.contentMode === 'templates' ? 'templates' : 'classic';
}
function pageContentMode(page) {
  if (page && (page.contentMode === 'classic' || page.contentMode === 'templates')) {
    return page.contentMode;
  }
  return getGlobalContentMode();
}

// ── Send Mode (card / text / card+text) ──
function getGlobalSendMode() {
  const s = loadSettings();
  if (s.sendMode === 'text' || s.sendMode === 'card+text') return s.sendMode;
  return 'card';
}
function pageSendMode(page) {
  if (page && (page.sendMode === 'card' || page.sendMode === 'text' || page.sendMode === 'card+text')) {
    return page.sendMode;
  }
  return getGlobalSendMode();
}

function normalizeUrl(u) {
  u = (u || '').trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf('//') === 0) return 'https:' + u;
  return 'https://' + u;
}

function getMasterRedirect() {
  const s = loadSettings();
  const mr = s.masterRedirect || {};
  return { enabled: !!mr.enabled, url: mr.url || '' };
}

function renderMasterRedirectCard() {
  const mr = getMasterRedirect();
  if (mr.enabled && mr.url) {
    return `
    <div class="card" style="border:2px solid #f59e0b;background:#fffbeb;">
      <h2 style="color:#b45309;">⚠️ Master Redirect is ON — all cards go to one URL</h2>
      <p style="color:#92400e;font-size:13px;margin:6px 0;">Every card on every page (Classic and Templates) currently redirects fans here, ignoring each card's own URL — including cards already sent. Stays on until you turn it off.</p>
      <div style="font-family:monospace;font-size:13px;color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;margin:8px 0;word-break:break-all;">→ ${esc(mr.url)}</div>
      <form action="/master-redirect-off" method="POST" style="margin:0;">
        <button type="submit" class="btn" style="background:#b45309;color:#fff;">↩️ Turn OFF — back to each card's own URL</button>
      </form>
    </div>`;
  }
  return `
    <div class="card" style="border:2px solid #fde68a;">
      <h2>🔀 Master Redirect Override <span style="font-size:12px;font-weight:400;color:#92400e;">— send every card to ONE url temporarily</span></h2>
      <p style="color:#6b7280;font-size:13px;">Turn this on when you want all fans sent to a single link (e.g. a WhatsApp or Messenger URL) instead of each card's own redirect. Applies to every page — Classic and Templates — instantly, and to cards already in fans' inboxes. Turn it off anytime to go back to normal.</p>
      <form action="/master-redirect-on" method="POST" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input type="text" name="url" placeholder="https://wa.me/355691234567" value="${esc(mr.url)}" style="flex:1;min-width:260px;font-family:monospace;font-size:13px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;"/>
        <button type="submit" class="btn" style="background:#f59e0b;color:#fff;white-space:nowrap;" onclick="return confirm('Turn ON master redirect? Every card on every page will point to this one URL until you turn it off.')">⚡ Turn override ON</button>
      </form>
    </div>`;
}

function renderMasterRedirectBanner() {
  const mr = getMasterRedirect();
  if (!(mr.enabled && mr.url)) return '';
  return `
    <div class="card" style="border:2px solid #f59e0b;background:#fffbeb;">
      <h2 style="color:#b45309;">⚠️ Master Redirect is ON</h2>
      <p style="color:#92400e;font-size:13px;margin:6px 0;">All cards on all pages currently redirect fans to <strong style="font-family:monospace;word-break:break-all;">${esc(mr.url)}</strong>, ignoring their own URLs. Turn it off on the 🎴 Card Templates page to resume normal redirects.</p>
      <form action="/master-redirect-off" method="POST" style="margin:0;">
        <button type="submit" class="btn" style="background:#b45309;color:#fff;">↩️ Turn OFF master redirect</button>
      </form>
    </div>`;
}

const LIBRARY_SEED_PHOTOS = [
  'https://i.imgur.com/HeeRTyc.png',
  'https://i.imgur.com/2MOgc8a.png',
  'https://i.imgur.com/iroLLAh.png',
  'https://i.imgur.com/SRqUCwK.png',
  'https://i.imgur.com/WTFzSCt.png',
  'https://i.imgur.com/WysXBvK.png',
  'https://i.imgur.com/AXWkif2.png',
  'https://i.imgur.com/8QbpzZO.png',
  'https://i.imgur.com/sDraH1p.png',
  'https://i.imgur.com/D87Bhpa.png',
  'https://i.imgur.com/2J3Jne9.png',
  'https://i.imgur.com/MHT57vc.png'
];

const DEFAULT_SET = 'Scrollgallery';
const SECOND_SET = 'TheViralBox';

const LIBRARY_SEED_REDIRECT_SETS = {
  'Scrollgallery': [
    'https://scrollgallery.com/?p=50252',
    'https://scrollgallery.com/?p=50259',
    'https://scrollgallery.com/?p=50271',
    'https://scrollgallery.com/?p=50278',
    'https://scrollgallery.com/?p=50285',
    'https://scrollgallery.com/?p=50292',
    'https://scrollgallery.com/?p=50299',
    'https://scrollgallery.com/?p=50306',
    'https://scrollgallery.com/?p=50313',
    'https://scrollgallery.com/?p=50321',
    'https://scrollgallery.com/?p=50328',
    'https://scrollgallery.com/?p=50335',
    'https://scrollgallery.com/?p=50342',
    'https://scrollgallery.com/?p=50349',
    'https://scrollgallery.com/?p=50356',
    'https://scrollgallery.com/?p=50363',
    'https://scrollgallery.com/?p=50370',
    'https://scrollgallery.com/?p=50377',
    'https://scrollgallery.com/?p=50385',
    'https://scrollgallery.com/?p=50392'
  ],
  'TheViralBox': [
    'https://photos.theviralbox.info/archives/1945',
    'https://photos.theviralbox.info/archives/1953',
    'https://photos.theviralbox.info/archives/1960',
    'https://photos.theviralbox.info/archives/1967',
    'https://photos.theviralbox.info/archives/1979',
    'https://photos.theviralbox.info/archives/1986',
    'https://photos.theviralbox.info/archives/1993',
    'https://photos.theviralbox.info/archives/2000',
    'https://photos.theviralbox.info/archives/2007',
    'https://photos.theviralbox.info/archives/2014',
    'https://photos.theviralbox.info/archives/2021',
    'https://photos.theviralbox.info/archives/2028',
    'https://photos.theviralbox.info/archives/2035',
    'https://photos.theviralbox.info/archives/2042',
    'https://photos.theviralbox.info/archives/2049',
    'https://photos.theviralbox.info/archives/2056',
    'https://photos.theviralbox.info/archives/2063',
    'https://photos.theviralbox.info/archives/2070'
  ]
};

function loadLibrary() {
  let lib;
  try {
    lib = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    const seed = {
      photos: [...LIBRARY_SEED_PHOTOS],
      redirectSets: JSON.parse(JSON.stringify(LIBRARY_SEED_REDIRECT_SETS)),
      cardTemplates: [],
      textPool: []
    };
    try { saveLibrary(seed); } catch {}
    return seed;
  }
  const photos = Array.isArray(lib.photos) ? lib.photos : [];
  let redirectSets = lib.redirectSets && typeof lib.redirectSets === 'object' ? lib.redirectSets : null;
  if (!redirectSets) {
    const oldFlat = Array.isArray(lib.redirects) ? lib.redirects : [];
    redirectSets = { [DEFAULT_SET]: oldFlat, [SECOND_SET]: [] };
  }
  if (!Array.isArray(redirectSets[DEFAULT_SET])) redirectSets[DEFAULT_SET] = [];
  if (!Array.isArray(redirectSets[SECOND_SET])) redirectSets[SECOND_SET] = [];
  const cardTemplates = Array.isArray(lib.cardTemplates) ? lib.cardTemplates : [];
  const titles = Array.isArray(lib.titles) ? lib.titles : [];
  const subtitles = Array.isArray(lib.subtitles) ? lib.subtitles : [];
  const buttonTexts = Array.isArray(lib.buttonTexts) ? lib.buttonTexts : [];
  const textPool = Array.isArray(lib.textPool) ? lib.textPool : [];
  const normalized = { photos, redirectSets, cardTemplates, titles, subtitles, buttonTexts, textPool };
  if (!lib.redirectSets || !lib.cardTemplates) { try { saveLibrary(normalized); } catch {} }
  return normalized;
}
function saveLibrary(lib) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
}
function getSetNames(lib) {
  lib = lib || loadLibrary();
  const names = Object.keys(lib.redirectSets);
  const ordered = [DEFAULT_SET, SECOND_SET].filter(n => names.includes(n));
  names.forEach(n => { if (!ordered.includes(n)) ordered.push(n); });
  return ordered;
}
function pageSet(page, lib) {
  lib = lib || loadLibrary();
  const s = page.redirectSet;
  if (s && Array.isArray(lib.redirectSets[s])) return s;
  return DEFAULT_SET;
}

function pickRandom(arr, avoid) {
  if (!arr || arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  const pool = arr.filter(x => x !== avoid);
  const choices = pool.length ? pool : arr;
  return choices[Math.floor(Math.random() * choices.length)];
}

function templatesForSet(lib, setName) {
  lib = lib || loadLibrary();
  return (lib.cardTemplates || []).filter(t => (t.set || DEFAULT_SET) === setName);
}

function pickTemplatePhoto(t) {
  const active = (Array.isArray(t.activePhotos) && t.activePhotos.length) ? t.activePhotos : null;
  const pics = active || ((Array.isArray(t.photos) && t.photos.length) ? t.photos : (t.photo ? [t.photo] : []));
  if (!pics.length) return t.photo || '';
  return pics[Math.floor(Math.random() * pics.length)];
}

function parsePhotos(raw, legacy) {
  let arr = [];
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) {} }
  if (!arr.length && legacy) arr = [legacy];
  return arr.map(u => (u || '').trim()).filter(Boolean);
}

function randomizePage(page, opts = {}) {
  const doPhoto = opts.photo !== false;
  const doRedirect = opts.redirect !== false;
  const lib = loadLibrary();
  const setName = pageSet(page, lib);
  const tmpls = templatesForSet(lib, setName).filter(t => t.active !== false);

  const mode = pageContentMode(page);
  if (mode === 'templates' && tmpls.length && doPhoto && doRedirect) {
    const chosen = pickRandom(tmpls, (lib.cardTemplates || []).find(t => t.id === page.lastTemplateId));
    if (chosen) {
      const pic = pickTemplatePhoto(chosen);
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (pic && !photos.includes(pic)) photos.unshift(pic);
      return updatePage(page.pageId, {
        currentPhoto: pic || page.currentPhoto,
        title: chosen.title || page.title,
        subtitle: chosen.subtitle || page.subtitle,
        buttonText: chosen.buttonText || page.buttonText,
        whatsapp: chosen.redirect || page.whatsapp,
        lastPhoto: pic,
        lastRedirect: chosen.redirect,
        lastTemplateId: chosen.id,
        photos
      });
    }
  }

  const updates = {};
  if (doPhoto && lib.photos.length) {
    const newPhoto = pickRandom(lib.photos, page.lastPhoto || page.currentPhoto);
    if (newPhoto) {
      updates.currentPhoto = newPhoto;
      updates.lastPhoto = newPhoto;
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (!photos.includes(newPhoto)) photos.unshift(newPhoto);
      updates.photos = photos;
    }
  }
  if (doRedirect) {
    const pool = lib.redirectSets[setName] || [];
    if (pool.length) {
      const newRedirect = pickRandom(pool, page.lastRedirect || page.whatsapp);
      if (newRedirect) {
        updates.whatsapp = newRedirect;
        updates.lastRedirect = newRedirect;
      }
    }
  }
  if (lib.titles && lib.titles.length) {
    const newTitle = pickRandom(lib.titles, page.lastTitle || page.title);
    if (newTitle) { updates.title = newTitle; updates.lastTitle = newTitle; }
  }
  if (lib.subtitles && lib.subtitles.length) {
    const newSubtitle = pickRandom(lib.subtitles, page.lastSubtitle || page.subtitle);
    if (newSubtitle) { updates.subtitle = newSubtitle; updates.lastSubtitle = newSubtitle; }
  }
  if (lib.buttonTexts && lib.buttonTexts.length) {
    const newButton = pickRandom(lib.buttonTexts, page.lastButtonText || page.buttonText);
    if (newButton) { updates.buttonText = newButton; updates.lastButtonText = newButton; }
  }
  if (Object.keys(updates).length) {
    return updatePage(page.pageId, updates);
  }
  return page;
}

// ============================================
// FANS (per page)
// ============================================
function fansFile(pageId) { return `${DATA_DIR}/fans-${pageId}.json`; }
function loadFans(pageId) {
  try { return JSON.parse(fs.readFileSync(fansFile(pageId), 'utf8')); }
  catch { return []; }
}
function saveFansList(pageId, fans) {
  fs.writeFileSync(fansFile(pageId), JSON.stringify(fans));
}
function isFanSaved(pageId, psid) { return loadFans(pageId).includes(psid); }
function saveFan(pageId, psid) {
  const fans = loadFans(pageId);
  if (!fans.includes(psid)) {
    fans.push(psid);
    saveFansList(pageId, fans);
    trackFanAdded(pageId, psid);
    console.log(`[${pageId}] New fan: ${psid} | Total: ${fans.length}`);
  }
}

function trackFailureForFan(pageId, psid, reason) {
  const page = getPage(pageId);
  const threshold = (page && page.cleanupThreshold !== undefined) ? page.cleanupThreshold : 1;
  if (threshold === 0) return;
  const s = loadStats(pageId);
  s.fanFailures = s.fanFailures || {};
  s.fanFailures[psid] = (s.fanFailures[psid] || 0) + 1;
  const count = s.fanFailures[psid];
  if (count >= threshold) {
    const fans = loadFans(pageId);
    const filtered = fans.filter(p => p !== psid);
    if (filtered.length !== fans.length) {
      saveFansList(pageId, filtered);
      s.removedFans = s.removedFans || [];
      s.removedFans.push({ psid, reason: `${count} consecutive failures: ${reason || 'unreachable'}`, time: new Date().toISOString() });
      delete s.fanFailures[psid];
      console.log(`[${pageId}] Auto-removed fan ${psid} after ${count} failures (${reason}) | Remaining: ${filtered.length}`);
    }
  } else {
    console.log(`[${pageId}] Fan ${psid} failure ${count}/${threshold} (${reason}) — not removed yet`);
  }
  saveStats(pageId, s);
}

function clearFailuresForFan(pageId, psid) {
  const s = loadStats(pageId);
  if (s.fanFailures && s.fanFailures[psid]) {
    delete s.fanFailures[psid];
    saveStats(pageId, s);
  }
}

function removeFan(pageId, psid, reason) {
  const fans = loadFans(pageId);
  const filtered = fans.filter(p => p !== psid);
  if (filtered.length !== fans.length) {
    saveFansList(pageId, filtered);
    const s = loadStats(pageId);
    s.removedFans = s.removedFans || [];
    s.removedFans.push({ psid, reason: reason || 'manual', time: new Date().toISOString() });
    saveStats(pageId, s);
    console.log(`[${pageId}] Removed fan ${psid} (${reason}) | Remaining: ${filtered.length}`);
  }
}

// ============================================
// STATS (per page)
// ============================================
function statsFile(pageId) { return `${DATA_DIR}/stats-${pageId}.json`; }
function loadStats(pageId) {
  try { return JSON.parse(fs.readFileSync(statsFile(pageId), 'utf8')); }
  catch {
    return { clicks: [], messagesSent: 0, messagesFailed: 0, fansAdded: [], reads: [], readers: [], deliveries: [], delivered: [] };
  }
}
function saveStats(pageId, s) { fs.writeFileSync(statsFile(pageId), JSON.stringify(s)); }
function resetStats(pageId) {
  saveStats(pageId, { clicks: [], messagesSent: 0, messagesFailed: 0, fansAdded: [], reads: [], readers: [], deliveries: [], delivered: [], dailyMessages: {} });
}
function trackClick(pageId, psid) {
  const s = loadStats(pageId);
  s.clicks = s.clicks || [];
  s.clicks.push({ psid, time: new Date().toISOString() });
  saveStats(pageId, s);
}
function trackMessage(pageId, success) {
  const s = loadStats(pageId);
  if (success) s.messagesSent = (s.messagesSent || 0) + 1;
  else s.messagesFailed = (s.messagesFailed || 0) + 1;
  s.dailyMessages = s.dailyMessages || {};
  const today = todayDate();
  s.dailyMessages[today] = s.dailyMessages[today] || { sent: 0, failed: 0 };
  if (success) s.dailyMessages[today].sent++;
  else s.dailyMessages[today].failed++;
  saveStats(pageId, s);
}
function trackRead(pageId, psid, w) {
  const s = loadStats(pageId);
  s.reads = s.reads || []; s.readers = s.readers || [];
  s.reads.push({ psid, watermark: w, time: new Date().toISOString() });
  if (!s.readers.includes(psid)) s.readers.push(psid);
  saveStats(pageId, s);
}
function trackDelivery(pageId, psid, w) {
  const s = loadStats(pageId);
  s.deliveries = s.deliveries || []; s.delivered = s.delivered || [];
  s.deliveries.push({ psid, watermark: w, time: new Date().toISOString() });
  if (!s.delivered.includes(psid)) s.delivered.push(psid);
  saveStats(pageId, s);
}
function trackFanAdded(pageId, psid) {
  const s = loadStats(pageId);
  s.fansAdded = s.fansAdded || [];
  s.fansAdded.push({ psid, time: new Date().toISOString() });
  saveStats(pageId, s);
}

// ============================================
// HELPERS
// ============================================
function getCurrentPhoto(page) {
  if (page.currentPhoto) return page.currentPhoto;
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return page.photos[day % page.photos.length];
}

const DAILY_SUBTITLES = [
  "I'm on WhatsApp... lets talk",
  "Come chat with me 💬",
  "Message me on WhatsApp... I'm waiting 😊",
  "Let's talk on WhatsApp today 👇",
  "Come find me on WhatsApp 💕",
  "I'm on WhatsApp... come say hi 👋",
  "Let's chat on WhatsApp 💬",
  "Talk to me on WhatsApp 😘",
  "Come chat on WhatsApp today 💕",
  "Message me on WhatsApp 👇"
];
function getRotatingSubtitle() {
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return DAILY_SUBTITLES[day % DAILY_SUBTITLES.length];
}

const SPACING_PRESETS = [2, 5, 10, 15, 18, 30, 60];
function spacingLabel(s) {
  const perHr = Math.floor(3600 / s);
  let tag;
  if (s <= 2) tag = 'very risky';
  else if (s <= 5) tag = 'risky';
  else if (s <= 10) tag = 'moderate';
  else if (s <= 18) tag = 'safe';
  else tag = 'very safe';
  return `${s}s (~${perHr}/hr — ${tag})`;
}
function renderSpacingSelect(name, selected) {
  selected = selected || 10;
  const presets = [...SPACING_PRESETS];
  if (!presets.includes(selected)) presets.push(selected);
  presets.sort((a, b) => a - b);
  return `<select name="${name}">${
    presets.map(s => `<option value="${s}" ${s === selected ? 'selected' : ''}>${spacingLabel(s)}</option>`).join('')
  }</select>`;
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}
function getRecentDailyStats(pageId, days = 14) {
  const stats = loadStats(pageId);
  const daily = stats.dailyMessages || {};
  const result = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const day = daily[dateStr] || { sent: 0, failed: 0 };
    result.push({ date: dateStr, sent: day.sent, failed: day.failed });
  }
  return result;
}

function uptimeText() {
  const ms = Date.now() - STARTED_AT.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// MESSENGER API (per page)
// ============================================
function setupMessenger(page) {
  fetch(`https://graph.facebook.com/v2.6/me/messenger_profile?access_token=${page.accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      get_started: { payload: 'GET_STARTED' },
      greeting: [{ locale: 'default', text: 'Hey gorgeous! 💕 Tap Get Started to chat with us!' }]
    })
  }).then(r => r.json())
    .then(d => console.log(`[${page.label}] Messenger setup:`, d.result || d.error?.message || 'ok'))
    .catch(e => console.error(`[${page.label}] Messenger setup error:`, e.message));
}

function sendCard(page, psid, opts = {}) {
  const rawDest = normalizeUrl(opts.redirect || page.whatsapp || '');
  const trackUrl = `${PUBLIC_URL}/track?psid=${psid}&pageId=${page.pageId}`
    + (rawDest ? `&d=${encodeURIComponent(rawDest)}` : '');
  const title = opts.title || page.title;
  const subtitle = opts.subtitle || page.subtitle;
  const photo = opts.photo || getCurrentPhoto(page);
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${page.accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            image_aspect_ratio: 'square',
            elements: [{
              title, subtitle, image_url: photo,
              default_action: { type: 'web_url', url: trackUrl, webview_height_ratio: 'tall' },
              buttons: [{ type: 'web_url', url: trackUrl, title: page.buttonText }]
            }]
          }
        }
      }
    })
  }).then(r => r.json()).then(data => {
    if (data.error) {
      trackMessage(page.pageId, false);
      const code = data.error.code;
      const msg = data.error.message || '';
      console.log(`[${page.label}] Card failed (psid ${psid}, code ${code}):`, msg);
      const unreachable =
        code === 10 || code === 100 || code === 551 ||
        /outside [\w\s]*allowed window/i.test(msg) ||
        /no matching user/i.test(msg) ||
        /cannot receive messages/i.test(msg) ||
        /policy[- ]?enforcement/i.test(msg);
      if (unreachable && !opts.skipRemoval) {
        trackFailureForFan(page.pageId, psid, `FB error ${code}: ${msg.slice(0, 60)}`);
      }
    } else {
      trackMessage(page.pageId, true);
      clearFailuresForFan(page.pageId, psid);
    }
    return data;
  }).catch(err => {
    trackMessage(page.pageId, false);
    console.error(`[${page.label}] Card error (psid ${psid}):`, err.message);
    return { error: { message: err.message } };
  });
}

function sendTextMessage(page, psid, text) {
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${page.accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text } })
  }).then(r => r.json()).then(data => {
    if (data.error) { trackMessage(page.pageId, false); }
    else { trackMessage(page.pageId, true); }
    return data;
  }).catch(err => { trackMessage(page.pageId, false); return { error: { message: err.message } }; });
}

// ============================================
// BROADCAST PROGRESS TRACKER
// ============================================
const broadcastProgress = {};

function startBroadcastTracking(pageId, total, type) {
  broadcastProgress[pageId] = {
    total, done: 0, failed: 0,
    startedAt: Date.now(), finishedAt: null,
    type, status: total > 0 ? 'running' : 'complete'
  };
  if (total === 0) broadcastProgress[pageId].finishedAt = Date.now();
}
function tickBroadcast(pageId) {
  const b = broadcastProgress[pageId];
  if (!b) return;
  b.done++;
  if (b.done >= b.total) {
    b.status = 'complete';
    b.finishedAt = Date.now();
  }
}

function broadcastToPage(page, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds || 10) * 1000;

  // Determine send mode — explicit opts override page/global setting
  const effectiveSendMode = opts.textOnly ? 'text' : (opts.forceSendMode || pageSendMode(page));
  const lib = loadLibrary();
  const pool = lib.textPool || [];

  const type = effectiveSendMode === 'text' ? 'text' : effectiveSendMode === 'card+text' ? 'card+text' : 'card';
  startBroadcastTracking(page.pageId, fans.length, type);

  fans.forEach((psid, i) => {
    setTimeout(async () => {
      try {
        if (opts.textOnly && opts.text) {
          // Legacy: per-page saved text messages — always use their specific text
          await sendTextMessage(page, psid, opts.text);
        } else if (effectiveSendMode === 'text') {
          // Text Only mode — pick random from shared pool
          if (pool.length) {
            const text = pool[Math.floor(Math.random() * pool.length)];
            await sendText(page, psid, text, opts);
          }
        } else if (effectiveSendMode === 'card+text') {
          // Card + Text — send card first, then text 1.5s later
          await sendCard(page, psid, opts);
          if (pool.length) {
            await new Promise(r => setTimeout(r, 1500));
            const text = pool[Math.floor(Math.random() * pool.length)];
            await sendText(page, psid, text, opts);
          }
        } else {
          // Card Only (default)
          await sendCard(page, psid, opts);
        }
      } catch {}
      tickBroadcast(page.pageId);
    }, i * spacing);
  });
  return fans.length;
}

function sendText(page, psid, text, opts = {}) {
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${page.accessToken}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text: text }
    })
  }).then(r => r.json()).then(data => {
    if (data.error) {
      trackMessage(page.pageId, false);
      const code = data.error.code;
      const msg = data.error.message || '';
      console.log(`[${page.label}] Text failed (psid ${psid}, code ${code}):`, msg);
      const unreachable =
        code === 10 || code === 100 || code === 551 ||
        /outside [\w\s]*allowed window/i.test(msg) ||
        /no matching user/i.test(msg) ||
        /cannot receive messages/i.test(msg) ||
        /policy[- ]?enforcement/i.test(msg);
      if (unreachable && !opts.skipRemoval) {
        trackFailureForFan(page.pageId, psid, `FB error ${code}: ${msg.slice(0, 60)}`);
      }
    } else {
      trackMessage(page.pageId, true);
      clearFailuresForFan(page.pageId, psid);
    }
    return data;
  }).catch(err => {
    trackMessage(page.pageId, false);
    console.error(`[${page.label}] Text error (psid ${psid}):`, err.message);
    return { error: { message: err.message } };
  });
}

function broadcastTextToPage(page, text, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds || 10) * 1000;
  startBroadcastTracking(page.pageId, fans.length, 'text');
  fans.forEach((psid, i) => {
    setTimeout(async () => {
      try { await sendText(page, psid, text, opts); } catch {}
      tickBroadcast(page.pageId);
    }, i * spacing);
  });
  return fans.length;
}

// ============================================
// PUBLIC ROUTES — no auth
// ============================================
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (req.body.object !== 'page') return res.sendStatus(404);
  req.body.entry.forEach(entry => {
    const pageId = entry.id;
    const page = getPage(pageId);
    if (!page) {
      console.warn(`Webhook received for unknown page ${pageId}`);
      return;
    }
    (entry.messaging || []).forEach(event => {
      const psid = event.sender?.id;
      if (!psid) return;
      if (event.read) { trackRead(pageId, psid, event.read.watermark); return; }
      if (event.delivery) { trackDelivery(pageId, psid, event.delivery.watermark); return; }
      const isNewFan = !isFanSaved(pageId, psid);
      saveFan(pageId, psid);
      if (event.postback?.payload === 'GET_STARTED') {
        sendCard(page, psid);
      } else if (event.message && isNewFan) {
        sendCard(page, psid);
      }
    });
  });
  res.status(200).send('EVENT_RECEIVED');
});

app.get('/track', (req, res) => {
  const pageId = req.query.pageId;
  const psid = req.query.psid || 'unknown';
  const page = getPage(pageId);
  const mr = getMasterRedirect();
  let dest;
  if (mr.enabled && mr.url) dest = mr.url;
  else if (req.query.d) dest = req.query.d;
  else dest = page ? page.whatsapp : getDefaults().whatsapp;
  dest = normalizeUrl(dest);
  res.redirect(dest);
  if (page) {
    setImmediate(() => {
      try { trackClick(pageId, psid); }
      catch (e) { console.error(`[${page.label}] Click tracking failed:`, e.message); }
    });
  }
});

// ============================================
// 🔒 AUTH WALL
// ============================================
app.use(basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
  realm: 'messagebot'
}));

// ============================================
// CSS
// ============================================
const CSS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background: #f5f6fa; margin: 0; padding: 0; color: #2c3e50; }
  .topbar { background: #1a1d2e; color: #fff; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .topbar h1 { margin: 0; font-size: 22px; font-weight: 700; }
  .topbar .meta { font-size: 13px; opacity: 0.7; }
  .topbar select { background: #2c3142; color: #fff; border: 1px solid #3a4055; padding: 8px 12px; border-radius: 6px; font-size: 14px; }
  .container { max-width: 1400px; margin: 16px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 10px; padding: 22px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .card h2 { margin: 0 0 14px 0; font-size: 18px; color: #1a1d2e; border-bottom: 2px solid #f0f1f5; padding-bottom: 10px; }
  .card h3 { margin: 18px 0 10px 0; font-size: 15px; color: #4a5568; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .stat { background: #f7f8fc; padding: 14px; border-radius: 8px; border-left: 3px solid #3a8dde; }
  .stat .v { font-size: 26px; font-weight: 700; color: #1a1d2e; }
  .stat .l { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin: 10px 0 4px 0; }
  input[type=text], input[type=url], input[type=number], input[type=time], input[type=datetime-local], select, textarea { width: 100%; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; font-family: inherit; }
  textarea { min-height: 90px; resize: vertical; }
  .btn { display: inline-block; padding: 9px 16px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; text-decoration: none; color: #fff; background: #6b7280; margin-top: 8px; }
  .btn:hover { opacity: 0.9; }
  .btn-green { background: #28a745; }
  .btn-blue { background: #3a8dde; }
  .btn-red { background: #dc3545; }
  .btn-orange { background: #f59e0b; }
  .row { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 700px) { .row { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  th { background: #f7f8fc; font-weight: 600; color: #4a5568; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge-green { background: #d4edda; color: #155724; }
  .badge-gray { background: #e5e7eb; color: #4a5568; }
  .actions { display: flex; gap: 5px; flex-wrap: nowrap; }
  .qbtn { padding: 5px 9px; border: none; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; color: #fff; text-decoration: none; display: inline-block; white-space: nowrap; }
  .qbtn-pause { background: #f59e0b; }
  .qbtn-resume { background: #28a745; }
  .qbtn-send { background: #3a8dde; }
  .qbtn-open { background: #6b7280; }
  .qbtn:hover { opacity: 0.9; }
  .funnel { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
  .funnel .step { flex: 1; min-width: 140px; background: #f7f8fc; padding: 12px; border-radius: 8px; text-align: center; }
  .funnel .step .v { font-size: 22px; font-weight: 700; color: #1a1d2e; }
  .funnel .step .l { font-size: 11px; color: #6b7280; text-transform: uppercase; margin-top: 4px; }
  .funnel .step .pct { font-size: 11px; color: #28a745; margin-top: 2px; }
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .photo-grid .item { background: #f7f8fc; padding: 8px; border-radius: 8px; border: 2px solid transparent; }
  .photo-grid .item.current { border-color: #28a745; background: #d4edda; }
  .photo-grid .item .img-wrap { position: relative; width: 100%; aspect-ratio: 1 / 1; background: #e5e7eb; border-radius: 6px; overflow: hidden; }
  .photo-grid .item img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-grid .item .url-row { display: flex; gap: 4px; margin-top: 6px; }
  .photo-grid .item .url-row input { flex: 1; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 10px; font-family: monospace; background: #fff; }
  .photo-grid .item .url-row a { background: #dc3545; color: white; padding: 5px 8px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: 600; }
  .photo-grid .item .action-row { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .photo-grid .item .ph-btn { padding: 4px 8px; border: none; border-radius: 4px; font-size: 10px; font-weight: 600; cursor: pointer; text-decoration: none; color: #fff; display: inline-block; white-space: nowrap; }
  .photo-grid .item .ph-copy { background: #6b7280; }
  .photo-grid .item .ph-active { background: #3a8dde; }
  .photo-grid .item .ph-remove { background: #dc3545; }
  .photo-grid .item .badge-current { display: inline-block; background: #28a745; color: white; font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 4px; }
  .danger-zone { border: 1px solid #fca5a5; background: #fef2f2; }
  .danger-zone h2 { color: #991b1b; border-color: #fecaca; }
  .alert { padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; font-size: 14px; }
  .alert-success { background: #d4edda; color: #155724; }
  .alert-error { background: #f8d7da; color: #721c24; }
  .helper { font-size: 12px; color: #6b7280; margin-top: 4px; }
  details > summary { list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details[open] > summary .bp-arrow { transform: rotate(90deg); }
  details > summary:hover { background: #fffbeb; }
  details { margin: 10px 0; }
  summary { cursor: pointer; font-weight: 600; color: #4a5568; padding: 6px 0; }
  .group-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: #ede9fe; color: #6d28d9; }
  .group-badge.unassigned { background: #f1f5f9; color: #94a3b8; }
`;

function renderHead(title) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=1200, initial-scale=0.35, user-scalable=yes"/><title>${esc(title)}</title><style>${CSS}</style></head><body>`;
}

function renderTopbar(pages, selectedPageId) {
  const opts = pages.map(p =>
    `<option value="${esc(p.pageId)}" ${p.pageId === selectedPageId ? 'selected' : ''}>${esc(p.label)} (${esc(p.pageId)})</option>`
  ).join('');
  return `<div class="topbar">
    <h1>📨 messagebot</h1>
    <form method="GET" action="/" style="margin:0;">
      <select name="page" onchange="this.form.submit()">
        <option value="all" ${!selectedPageId || selectedPageId === 'all' ? 'selected' : ''}>🌍 All Pages (aggregate)</option>
        <option value="templates" ${selectedPageId === 'templates' ? 'selected' : ''}>🎴 Card Templates</option>
        ${opts}
      </select>
    </form>
    <div class="meta">Uptime: ${uptimeText()} · Pages: ${pages.length}</div>
  </div>`;
}

function renderAlerts(req) {
  const q = req.query;
  let alerts = '';
  if (q.saved) alerts += `<div class="alert alert-success">✅ Saved!</div>`;
  if (q.schedule_saved) alerts += `<div class="alert alert-success">✅ Schedule saved!</div>`;
  if (q.text_saved) alerts += `<div class="alert alert-success">✅ Text template saved!</div>`;
  if (q.lib_msg) alerts += `<div class="alert alert-success">✅ ${esc(q.lib_msg)}</div>`;
  if (q.added) alerts += `<div class="alert alert-success">✅ Page added! Webhook is now active for it.</div>`;
  if (q.removed) alerts += `<div class="alert alert-success">✅ Page removed.</div>`;
  if (q.error) alerts += `<div class="alert alert-error">❌ ${esc(q.error)}</div>`;
  return alerts;
}

// ============================================
// PAGE GROUPS MANAGER SECTION (rendered on All Pages view)
// ============================================
function renderGroupManager(pages) {
  const groups = getAllGroups(pages);
  const unassigned = pages.filter(p => !p.group || !p.group.trim());

  const pills = groups.map(g => {
    const count = pages.filter(p => p.group === g).length;
    const fans = pages.filter(p => p.group === g).reduce((acc, p) => acc + loadFans(p.pageId).length, 0);
    return `<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;gap:10px;">
      <div>
        <div style="font-weight:700;color:#6d28d9;font-size:14px;">${esc(g)}</div>
        <div style="font-size:11px;color:#7c3aed;">${count} pages \xb7 ${fans} fans</div>
      </div>
      <form action="/group-delete" method="POST" style="margin:0;">
        <input type="hidden" name="group" value="${esc(g)}"/>
        <button type="submit" title="Delete group" onclick="return confirm('Delete group &quot;${esc(g)}&quot;? Pages will become unassigned.')" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:16px;padding:0;line-height:1;">\xd7</button>
      </form>
    </div>`;
  }).join('');

  return `
    <div class="card" style="border:2px solid #c4b5fd;">
      <h2>\ud83d\udce6 Page Groups <span style="font-size:12px;font-weight:400;color:#7c3aed;">\u2014 send to Part 1, Part 2, Part 3 separately or all at once</span></h2>

      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        ${pills || '<span style="color:#94a3b8;font-size:13px;">No groups yet \u2014 create one below.</span>'}
        ${unassigned.length ? `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;">
          <div style="font-size:13px;color:#94a3b8;">\u2b1c Unassigned: <strong>${unassigned.length} pages</strong></div>
        </div>` : ''}
      </div>

      <form action="/group-create" method="POST" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="text" name="group" autocomplete="off" placeholder='New group name, e.g. "Part 1"' style="flex:1;min-width:200px;max-width:320px;padding:8px 12px;border:1px solid #c4b5fd;border-radius:6px;font-size:14px;"/>
        <button type="submit" class="btn" style="background:#6d28d9;color:#fff;margin-top:0;">\u2795 Create Group</button>
      </form>
    </div>`;
}

// ============================================
// SEND NOW GROUP SELECTOR (rendered above the pages table)
// ============================================
function renderGroupSendNow(pages) {
  const groups = getAllGroups(pages);
  const eligibleAll = pages.filter(p => p.sendNowEnabled !== false);

  const groupOptions = groups.map(g => {
    const gPages = pages.filter(p => p.group === g && p.sendNowEnabled !== false);
    const totalFans = gPages.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);
    return `<option value="${esc(g)}">${esc(g)} — ${gPages.length} pages · ${totalFans} fans</option>`;
  }).join('');

  const allFans = eligibleAll.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);

  return `
    <div style="margin-bottom:12px;padding:14px;background:#f0fdf4;border:2px solid #86efac;border-radius:8px;">
      <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:10px;">📣 Send Now <span style="font-weight:400;color:#16a34a;">— choose a group or send to all eligible pages</span></div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <!-- GROUP SEND -->
        ${groups.length > 0 ? `
        <form action="/send-now-group" method="POST" style="display:inline;margin:0;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <select name="group" style="padding:7px 10px;border:1px solid #86efac;border-radius:6px;font-size:13px;background:#fff;color:#166534;font-weight:600;">
              ${groupOptions}
            </select>
            <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Send Now to selected group?')">📣 Send to Group</button>
            <button type="submit" name="randomize" value="1" class="qbtn" style="background:#7c3aed;" onclick="return confirm('Randomize + Send to selected group?')">🎲📣 Randomize + Send Group</button>
          </div>
        </form>
        <span style="color:#cbd5e1;font-size:18px;">|</span>` : ''}

        <!-- SEND ALL -->
        <form action="/send-now-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#166534;" onclick="return confirm('SEND NOW to ALL eligible pages (${eligibleAll.length} pages · ${allFans} fans)?\\n\\nPages with Send Now PAUSED are skipped.')">📣 Send All (${eligibleAll.length} pages)</button>
        </form>
        <form action="/send-now-all?randomize=1" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#5b21b6;" onclick="return confirm('RANDOMIZE + SEND to ALL eligible pages (${eligibleAll.length} pages)?')">🎲📣 Randomize + Send All</button>
        </form>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <form action="/pause-sendnow-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#f59e0b;" onclick="return confirm('Pause Send Now on ALL pages?')">🚫 Pause Send Now (All)</button>
        </form>
        <form action="/resume-sendnow-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Resume Send Now on ALL pages?')">✅ Resume Send Now (All)</button>
        </form>
      </div>
    </div>`;
}

function renderPageLibrarySection(page) {
  const lib = loadLibrary();
  const pid = esc(page.pageId);
  const currentSet = pageSet(page, lib);
  const setNames = getSetNames(lib);
  const pool = lib.redirectSets[currentSet] || [];

  const photoThumbs = lib.photos.map((url, i) => {
    const active = url === page.currentPhoto;
    return `<a href="/set-active-from-library?page=${pid}&photoIndex=${i}" title="Set as active photo" style="position:relative;display:block;border:2px solid ${active ? '#28a745' : '#e2e8f0'};border-radius:8px;overflow:hidden;text-decoration:none;">
      <img src="${esc(url)}" style="width:100%;height:70px;object-fit:cover;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"/>
      <div style="display:none;width:100%;height:70px;align-items:center;justify-content:center;background:#f1f5f9;color:#94a3b8;font-size:9px;text-align:center;padding:3px;">${esc(url.split('/').pop())}</div>
      ${active ? '<div style="position:absolute;top:2px;right:2px;background:#28a745;color:#fff;font-size:9px;padding:1px 5px;border-radius:4px;">★ active</div>' : ''}
    </a>`;
  }).join('');

  const redirectBtns = pool.map((url, i) => {
    const active = url === page.whatsapp;
    const short = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return `<a href="/set-active-from-library?page=${pid}&redirectIndex=${i}" title="Set as active redirect" style="display:inline-flex;align-items:center;gap:4px;background:${active ? '#dcfce7' : '#fff'};border:1px solid ${active ? '#28a745' : '#e2e8f0'};border-radius:6px;padding:5px 9px;font-size:11px;font-family:monospace;text-decoration:none;color:${active ? '#166534' : '#475569'};">
      ${active ? '★ ' : ''}${esc(short)}
    </a>`;
  }).join('');

  const setButtons = setNames.map(name => {
    const isCurrent = name === currentSet;
    const count = (lib.redirectSets[name] || []).length;
    return `<form action="/set-page-redirect-set?page=${pid}" method="POST" style="margin:0;display:inline;">
      <input type="hidden" name="setName" value="${esc(name)}"/>
      <button type="submit" class="btn" style="background:${isCurrent ? '#16a34a' : '#e2e8f0'};color:${isCurrent ? '#fff' : '#475569'};border:${isCurrent ? '2px solid #15803d' : '2px solid transparent'};">
        ${isCurrent ? '✓ ' : ''}${esc(name)} (${count})
      </button>
    </form>`;
  }).join('');

  return `
    <div class="card" style="border:2px solid #ede9fe;">
      <h2>🎲 Quick Switch &amp; Randomize <span style="font-size:12px;font-weight:400;color:#8b5cf6;">— photo pool shared · redirect by set</span></h2>

      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:600;color:#065f46;margin-bottom:8px;">🌐 Redirect Set for this page:</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${setButtons}</div>
        <div style="font-size:11px;color:#047857;margin-top:8px;">Currently using: <strong>${esc(currentSet)}</strong></div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        ${(function(){
          var mode = pageContentMode(page);
          if (mode === 'templates') {
            var tcount = templatesForSet(loadLibrary(), currentSet).length;
            return `
        <div style="width:100%;font-size:12px;color:#7c3aed;margin-bottom:4px;">🎴 This page is in <strong>Templates</strong> mode — randomize picks a complete card from the ${esc(currentSet)} set (${tcount} templates).</div>
        <form action="/randomize-page?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;">🎴 Pick Random Template</button>
        </form>
        <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#7c3aed;color:#fff;" onclick="return confirm('Pick a random template, then immediately broadcast to all fans?')">🎴🚀 Random Template + Send</button>
        </form>`;
          }
          return `
        <div style="width:100%;font-size:12px;color:#6366f1;margin-bottom:4px;">📷 This page is in <strong>Classic</strong> mode — randomize picks a photo from the shared pool + a URL from the ${esc(currentSet)} set.</div>
        <form action="/randomize-page?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;">🎲 Randomize (Photo + URL)</button>
        </form>
        <form action="/randomize-page?page=${pid}&only=photo" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#a78bfa;color:#fff;">🎲 Photo Only</button>
        </form>
        <form action="/randomize-page?page=${pid}&only=redirect" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#a78bfa;color:#fff;">🎲 URL Only</button>
        </form>
        <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#7c3aed;color:#fff;" onclick="return confirm('Randomize photo + URL, then immediately broadcast to all fans?')">🎲🚀 Randomize + Send</button>
        </form>`;
        })()}
      </div>

      <div style="background:#faf5ff;border-radius:8px;padding:12px;margin-bottom:14px;font-size:12px;">
        <div><strong>Active now:</strong></div>
        <div style="margin-top:4px;color:#6b21a8;">📸 ${esc((page.currentPhoto || '(none)').split('/').pop())}</div>
        <div style="color:#6b21a8;">🔗 ${esc((page.whatsapp || '(none)').replace(/^https?:\/\//, ''))}</div>
      </div>

      <h3 style="font-size:14px;color:#1a1d2e;margin:0 0 8px;">📸 Tap a photo to set active (${lib.photos.length} — shared pool)</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(85px,1fr));gap:8px;margin-bottom:16px;">
        ${photoThumbs || '<span style="color:#94a3b8;font-size:12px;">Library empty.</span>'}
      </div>

      <h3 style="font-size:14px;color:#1a1d2e;margin:0 0 8px;">🔗 Tap a URL to set active — from "${esc(currentSet)}" set (${pool.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${redirectBtns || '<span style="color:#94a3b8;font-size:12px;">This set is empty.</span>'}
      </div>
      <div class="helper" style="margin-top:12px;">Photos are shared by all pages. Redirect URLs come from this page's assigned set.</div>
    </div>`;
}

function renderLibraryManager() {
  const lib = loadLibrary();
  const photoChips = lib.photos.map((url, i) => `
    <div style="position:relative;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;">
      <img src="${esc(url)}" style="width:100%;height:80px;object-fit:cover;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"/>
      <div style="display:none;width:100%;height:80px;align-items:center;justify-content:center;background:#f1f5f9;color:#94a3b8;font-size:10px;text-align:center;padding:4px;">${esc(url.split('/').pop())}</div>
      <a href="/library-remove-photo?index=${i}" onclick="return confirm('Remove this photo from the shared library?')" style="position:absolute;top:3px;right:3px;background:rgba(220,38,38,0.9);color:#fff;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:18px;text-align:center;text-decoration:none;">×</a>
      <div style="font-size:9px;color:#94a3b8;text-align:center;padding:2px;">#${i + 1}</div>
    </div>`).join('');

  const setNames = getSetNames(lib);
  const setSections = setNames.map(name => {
    const urls = lib.redirectSets[name] || [];
    const chips = urls.map((url, i) => {
      const short = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
      return `<div style="display:inline-flex;align-items:center;gap:4px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px;font-size:11px;font-family:monospace;">
        <span style="color:#475569;">${esc(short)}</span>
        <a href="/library-remove-redirect?set=${encodeURIComponent(name)}&index=${i}" onclick="return confirm('Remove this URL?')" style="color:#dc2626;text-decoration:none;font-weight:700;">×</a>
      </div>`;
    }).join('');
    const color = name === DEFAULT_SET ? '#3a8dde' : '#f59e0b';
    return `
      <div style="margin-top:14px;border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:8px;padding:12px;background:#fafbfc;">
        <h4 style="margin:0 0 8px;font-size:13px;color:#1a1d2e;">🌐 ${esc(name)} <span style="font-weight:400;color:#94a3b8;">(${urls.length} URLs)</span></h4>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
          ${chips || '<span style="color:#94a3b8;font-size:12px;">No URLs in this set yet.</span>'}
        </div>
        <form action="/library-add-redirect" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
          <input type="hidden" name="setName" value="${esc(name)}"/>
          <textarea name="redirectUrls" placeholder="Paste URL(s) for ${esc(name)} (one per line or comma-separated)" style="flex:1;min-width:240px;min-height:44px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-family:monospace;font-size:12px;"></textarea>
          <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add to ${esc(name)}</button>
        </form>
      </div>`;
  }).join('');

  // ── TEXT POOL SECTION ──
  const textPoolItems = lib.textPool || [];
  const textPoolChips = textPoolItems.map((text, i) =>
    `<div style="display:flex;align-items:flex-start;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;margin-bottom:6px;">
      <span style="background:#6366f1;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;margin-top:2px;">#${i + 1}</span>
      <div style="flex:1;font-size:13px;color:#1a1d2e;word-break:break-word;white-space:pre-wrap;">${esc(text)}</div>
      <a href="/library-remove-text-pool?index=${i}" onclick="return confirm('Remove this text?')" style="color:#dc2626;text-decoration:none;font-weight:700;font-size:16px;flex-shrink:0;line-height:1;">×</a>
    </div>`
  ).join('');

  return `
    <div class="card" style="border:2px solid #ede9fe;padding:0;overflow:hidden;">
      <details>
        <summary style="cursor:pointer;padding:14px 20px;display:flex;align-items:center;gap:10px;user-select:none;list-style:none;">
          <span style="font-size:14px;color:#8b5cf6;transition:transform 0.2s;display:inline-block;" class="bp-arrow">▶</span>
          <span style="font-size:16px;font-weight:700;color:#1a1d2e;">🗂️ Shared Library</span>
          <span style="font-size:12px;color:#94a3b8;margin-left:4px;">${lib.photos.length} photos · ${Object.values(lib.redirectSets).reduce((a,s)=>a+s.length,0)} redirect URLs · ${textPoolItems.length} texts</span>
        </summary>
        <div style="padding:0 20px 20px;">
          <div style="margin-top:16px;">
            <h3 style="margin:0 0 8px;font-size:14px;">📸 Shared Photos (${lib.photos.length})</h3>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:10px;">
              ${photoChips || '<span style="color:#94a3b8;font-size:12px;">No photos yet.</span>'}
            </div>
            <form action="/library-add-photo" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
              <textarea name="photoUrls" placeholder="Paste one or more image URLs (one per line or comma-separated)" style="flex:1;min-width:260px;min-height:48px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-family:monospace;font-size:12px;"></textarea>
              <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add Photo(s)</button>
            </form>
          </div>
          <div style="margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px;">
            <h3 style="margin:0 0 4px;font-size:14px;">🔗 Redirect Sets</h3>
            ${setSections}
          </div>

          <div style="margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px;">
            <h3 style="margin:0 0 4px;font-size:14px;">🔄 Classic Mode Rotation Pools <span style="font-weight:400;color:#94a3b8;font-size:12px;">— randomize picks one from each pool automatically</span></h3>

            ${[
              { key: 'titles', label: 'Card Titles', emoji: '📝', placeholder: 'Sandra 58 💕\nJennifer 56 🌹\nRebecca 54 ❤️', hint: 'One per line — the name shown at the top of the card' },
              { key: 'subtitles', label: 'Card Subtitles', emoji: '💬', placeholder: 'I live alone, may I send you a friend request?\nI\'m a widow 🖤 May I get to know you?', hint: 'One per line — the text under the name' },
              { key: 'buttonTexts', label: 'Button Texts', emoji: '🔘', placeholder: 'My Photos 📞\nCome See Me 💋\nSee My Gallery 📸', hint: 'One per line — the button label fans click' }
            ].map(({ key, label, emoji, placeholder, hint }) => {
              const items = lib[key] || [];
              const chips = items.map((item, i) =>
                `<div style="display:inline-flex;align-items:center;gap:4px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px;font-size:12px;max-width:100%;word-break:break-word;">
                  <span style="color:#1a1d2e;">${esc(item)}</span>
                  <a href="/library-remove-text?key=${encodeURIComponent(key)}&index=${i}" onclick="return confirm('Remove this item?')" style="color:#dc2626;text-decoration:none;font-weight:700;flex-shrink:0;">×</a>
                </div>`
              ).join('');
              return `
              <div style="margin-top:14px;border:1px solid #e2e8f0;border-left:4px solid #6366f1;border-radius:8px;padding:12px;background:#fafbfc;">
                <h4 style="margin:0 0 6px;font-size:13px;color:#1a1d2e;">${emoji} ${esc(label)} <span style="font-weight:400;color:#94a3b8;">(${items.length} items)</span></h4>
                <div style="font-size:11px;color:#6b7280;margin-bottom:8px;">${esc(hint)}</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
                  ${chips || '<span style="color:#94a3b8;font-size:12px;">No items yet — add some below.</span>'}
                </div>
                <form action="/library-add-text" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
                  <input type="hidden" name="key" value="${esc(key)}"/>
                  <textarea name="items" placeholder="${esc(placeholder)}" style="flex:1;min-width:240px;min-height:60px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;"></textarea>
                  <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add to ${esc(label)}</button>
                </form>
              </div>`;
            }).join('')}
          </div>

          <div style="margin-top:20px;border-top:2px solid #c7d2fe;padding-top:16px;">
            <h3 style="margin:0 0 4px;font-size:14px;">💬 Text Message Pool <span style="font-weight:400;color:#94a3b8;font-size:12px;">— used in Text Only and Card + Text send modes</span></h3>
            <div style="font-size:11px;color:#6b7280;margin-bottom:12px;">Each fan gets a random pick from this pool. One message per line when adding.</div>

            <div style="margin-bottom:12px;">
              ${textPoolChips || '<span style="color:#94a3b8;font-size:12px;">No text messages in pool yet — add some below.</span>'}
            </div>

            <form action="/library-add-text-pool" method="POST" style="margin-bottom:10px;">
              <textarea name="texts" placeholder="Paste text messages here — one per line\n\nExample:\nDid I make you shy, or are you just making me wait? 😏\nI keep checking for your reply… don't leave me wondering too long 🥺\nYou disappeared right when I was starting to like you 😉" style="width:100%;min-height:100px;padding:10px;border:1px solid #c7d2fe;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add Text Messages</button>
                <span style="font-size:12px;color:#6b7280;align-self:center;">Currently: <strong>${textPoolItems.length}</strong> messages in pool</span>
              </div>
            </form>

            ${textPoolItems.length > 0 ? `
            <form action="/library-clear-text-pool" method="POST" style="margin-top:4px;">
              <button type="submit" class="btn btn-red" style="font-size:12px;" onclick="return confirm('Remove ALL ${textPoolItems.length} text messages from the pool? This cannot be undone.')">🗑️ Clear Entire Text Pool (${textPoolItems.length})</button>
            </form>` : ''}
          </div>
        </div>
      </details>
    </div>`;
}

function renderTemplateManager(req) {
  const lib = loadLibrary();
  const setNames = getSetNames(lib);
  const templates = lib.cardTemplates || [];
  const setOptions = setNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

  const sections = setNames.map(setName => {
    const list = templates.filter(t => (t.set || DEFAULT_SET) === setName);
    const color = setName === DEFAULT_SET ? '#3a8dde' : '#f59e0b';
    const cards = list.map(t => {
      const otherSet = (t.set === SECOND_SET) ? DEFAULT_SET : SECOND_SET;
      const photoCount = (Array.isArray(t.photos) && t.photos.length) ? t.photos.length : (t.photo ? 1 : 0);
      const isActive = t.active !== false;
      const isLinked = !!t.linkedId;
      const partner = isLinked ? templates.find(x => x.id === t.linkedId) : null;
      const linkedBadge = isLinked
        ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:5px;padding:3px 7px;font-size:10px;font-weight:700;color:#166534;margin-bottom:6px;display:flex;align-items:center;gap:4px;">
            🔗 Linked to ${esc(otherSet)} ${partner ? '· <em style="font-weight:400;">' + esc(partner.title || partner.id) + '</em>' : '· (partner missing)'}
            <a href="/template-unlink?id=${t.id}" onclick="return confirm('Unlink this pair? Both cards become independent — edits will no longer sync.')" style="margin-left:auto;color:#dc2626;text-decoration:none;font-weight:700;font-size:12px;" title="Unlink">✕</a>
           </div>`
        : `<div style="background:#f1f5f9;border-radius:5px;padding:3px 7px;font-size:10px;color:#94a3b8;margin-bottom:6px;">⬜ Not linked — edits only affect this card</div>`;
      return `
      <div id="tmpl-${t.id}" style="background:#fff;border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:8px;overflow:hidden;${isActive ? '' : 'opacity:0.5;filter:grayscale(0.7);'}">
        <div style="width:100%;aspect-ratio:1/1;background:#f1f5f9;display:flex;align-items:center;justify-content:center;position:relative;">
          <img src="${esc(t.photo)}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display='none';this.parentElement.style.color='#94a3b8';this.parentElement.style.fontSize='12px';this.parentElement.textContent='no photo';"/>
          ${photoCount > 1 ? `<span style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;">📷 ${photoCount}</span>` : ''}
          ${isLinked ? `<span style="position:absolute;bottom:6px;right:6px;background:rgba(22,163,74,0.9);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;">🔗 LINKED</span>` : ''}
          ${isActive ? '' : `<span style="position:absolute;top:6px;right:6px;background:#64748b;color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px;">PAUSED</span>`}
        </div>
        <div style="padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#475569;margin-bottom:6px;cursor:pointer;"><input type="checkbox" class="tmpl-sel" value="${t.id}" onclick="event.stopPropagation();" style="width:auto;"/> Select</label>
          ${linkedBadge}
          <div style="font-weight:600;font-size:14px;color:#1a1d2e;">${esc(t.title || '(no title)')}</div>
          <div style="font-size:12px;color:#6b7280;margin:3px 0;line-height:1.5;">${esc(t.subtitle || '(no subtitle)')}</div>
          <div style="font-size:11px;color:#94a3b8;font-family:monospace;margin-top:4px;word-break:break-all;">🔘 ${esc(t.buttonText)} · 🔗 ${esc((t.redirect || '(no redirect)').replace(/^https?:\/\//, ''))}</div>
          <div style="display:flex;gap:6px;margin-top:10px;">
            <button type="button" class="qbtn" onclick="editTmpl('${t.id}')" style="background:#6366f1;flex:1;">✏️ Edit</button>
            <button type="button" class="qbtn tmpl-dup-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#0ea5e9;" title="Duplicate + link to ${esc(otherSet)}">⧉🔗</button>
            ${!isLinked ? `<button type="button" class="qbtn tmpl-link-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#16a34a;" title="Link to existing ${esc(otherSet)} card">🔗</button>` : ''}
            <a href="/template-delete?id=${t.id}" onclick="return confirm('Delete this template?')" class="qbtn" style="background:#dc2626;">🗑️</a>
          </div>
        </div>
      </div>`;
    }).join('');

    return `
      <div style="margin-top:18px;">
        <h3 style="font-size:15px;color:#1a1d2e;margin:0 0 4px;border-left:4px solid ${color};padding-left:8px;">🌐 ${esc(setName)} templates <span style="font-weight:400;color:#94a3b8;">(${list.length})</span></h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:8px;">
          ${cards || '<span style="color:#94a3b8;font-size:13px;padding:8px;">No templates for ' + esc(setName) + ' yet.</span>'}
        </div>
      </div>`;
  }).join('');

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectCard()}
    <div class="card">
      <h2>🎴 Card Templates</h2>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;font-size:13px;color:#1e40af;margin-top:10px;">
        <strong>Total: ${templates.length} templates</strong> · Scrollgallery: ${templates.filter(t => (t.set||DEFAULT_SET)===DEFAULT_SET).length} · TheViralBox: ${templates.filter(t => t.set===SECOND_SET).length}
      </div>
    </div>
    <div class="card" style="border:2px solid #c7d2fe;">
      <h2 id="form-title">➕ Add New Template</h2>
      <form action="/template-add" method="POST" id="tmpl-form" onsubmit="return validateTmplForm();">
        <input type="hidden" name="id" id="f-id" value=""/>
        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 12px;margin-bottom:14px;">
          <label style="font-weight:600;color:#0369a1;">⚡ Quick paste from sheet</label>
          <textarea id="f-rawrow" placeholder="Paste a row copied from your spreadsheet here, then click Fill fields." style="width:100%;min-height:54px;font-size:12px;margin-top:6px;font-family:monospace;"></textarea>
          <button type="button" class="btn" style="background:#0ea5e9;color:#fff;margin-top:6px;" onclick="fillFromRow()">⤵️ Fill fields from row</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>
            <label>Card Title (the name)</label>
            <input name="title" id="f-title" placeholder="e.g. Elizabeth 56 💕" style="width:100%;"/>
          </div>
        </div>
        <label style="margin-top:10px;display:block;">Card Subtitle</label>
        <input name="subtitle" id="f-subtitle" placeholder="e.g. You just seem like someone interesting..." style="width:100%;"/>
        <div style="margin-top:10px;">
          <label>Button Text</label>
          <input name="buttonText" id="f-button" placeholder="My Photos 📞" style="width:100%;"/>
        </div>
        <label style="margin-top:10px;display:block;">Photos</label>
        <input type="hidden" name="photos" id="f-photos" value="[]"/>
        <input type="hidden" name="activePhotos" id="f-active-photos" value="[]"/>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <input type="text" id="f-photo-add" placeholder="https://i.imgur.com/xxxxx.png" style="flex:1;font-family:monospace;font-size:12px;"/>
          <button type="button" class="btn btn-green" style="white-space:nowrap;" onclick="addPhotoToForm()">+ Add photo</button>
        </div>
        <div id="f-dropzone" style="margin-top:8px;border:2px dashed #cbd5e1;border-radius:8px;padding:14px;text-align:center;color:#94a3b8;font-size:13px;cursor:pointer;">📂 Drag &amp; drop a photo here (or click) to upload to Imgur</div>
        <div id="f-photo-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:10px;"></div>

        <div style="margin-top:14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;">
          <div style="font-size:13px;font-weight:700;color:#0369a1;margin-bottom:10px;">🔗 Redirect URLs — one per website <span style="font-weight:400;font-size:11px;color:#0284c7;">(fill the ones you have — one card is created per filled URL, all linked together)</span></div>
          ${setNames.map(name => {
            const color = name === DEFAULT_SET ? '#3a8dde' : '#f59e0b';
            const placeholder = name === DEFAULT_SET
              ? 'https://scrollgallery.com/?p=51185'
              : name === SECOND_SET
              ? 'https://photos.theviralbox.info/archives/2977'
              : 'https://...';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="background:${color};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;white-space:nowrap;min-width:110px;text-align:center;">${esc(name)}</span>
              <input name="redirect_${esc(name)}" id="f-redirect-${esc(name)}" placeholder="${esc(placeholder)}" style="flex:1;font-family:monospace;font-size:12px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;"/>
            </div>`;
          }).join('')}
          <div style="font-size:11px;color:#0369a1;margin-top:4px;">💡 Leave a URL blank to skip that website. Fill all to create cards for all sites at once.</div>
        </div>

        <!-- Hidden fields kept for edit mode (single-card editing) -->
        <input type="hidden" name="redirect" id="f-redirect" value=""/>
        <div id="f-linked-block" style="display:none;">
          <input type="hidden" name="linkedRedirect" id="f-linked-redirect" value=""/>
          <input type="hidden" name="linkedId" id="f-linked-id" value=""/>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;">
          <button type="submit" class="btn btn-green" id="f-submit">➕ Add Template</button>
          <button type="button" onclick="resetForm()" class="btn" style="background:#e2e8f0;color:#475569;display:none;" id="f-cancel">Cancel Edit</button>
        </div>
      </form>
    </div>
    <div class="card">
      <h2>📋 Existing Templates</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#f7f8fc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:6px;">
        <span style="font-size:12px;font-weight:600;color:#475569;">Tick cards, then:</span>
        <button type="button" class="btn" style="background:#f59e0b;color:#fff;" onclick="bulkSetActive(false)">⏸️ Pause selected</button>
        <button type="button" class="btn" style="background:#16a34a;color:#fff;" onclick="bulkSetActive(true)">▶️ Activate selected</button>
        <span style="width:1px;height:20px;background:#cbd5e1;display:inline-block;"></span>
        <button type="button" class="btn" style="background:#e2e8f0;color:#475569;" onclick="selectAllTmpls(true)">Select all</button>
        <button type="button" class="btn" style="background:#e2e8f0;color:#475569;" onclick="selectAllTmpls(false)">Clear</button>
        <span id="sel-count" style="font-size:12px;color:#94a3b8;font-weight:600;"></span>
      </div>
      ${sections}
    </div>
    <script>
    var TEMPLATES = ${JSON.stringify(templates)};
    var scrollY = 0;

    function saveScrollPos(){ scrollY = window.scrollY; }
    function restoreScrollPos(){ window.scrollTo(0, scrollY); }

    function fillFromRow() {
      var raw = document.getElementById('f-rawrow').value.trim();
      if (!raw) return alert('Paste a row first.');
      var delimiter = raw.includes('\\t') ? '\\t' : ',';
      var parts = raw.split(delimiter).map(function(s){ return s.trim(); }).filter(Boolean);
      if (parts.length >= 1) document.getElementById('f-title').value = parts[0];
      if (parts.length >= 2) document.getElementById('f-subtitle').value = parts[1];
      if (parts.length >= 3) document.getElementById('f-button').value = parts[2];
      var urls = parts.filter(function(s) { return s.match(/^https?:\\/\\//i); });
      if (urls.length > 0) {
        var curPhotos = getFormPhotos();
        urls.forEach(function(u) {
          if (u.match(/imgur|i\\.imgur|ibb|postimg|imgbb/i)) {
            if (curPhotos.indexOf(u) < 0) { curPhotos.push(u); }
          }
        });
        setFormPhotos(curPhotos);
        var nonPhoto = urls.filter(function(u) { return !u.match(/imgur|i\\.imgur|ibb|postimg|imgbb/i); });
        ${setNames.map((n, idx) => `if (nonPhoto.length > ${idx}) document.getElementById('f-redirect-${n}').value = nonPhoto[${idx}];`).join('\n        ')}
      }
    }

    function getFormPhotos(){ try{ return JSON.parse(document.getElementById('f-photos').value); }catch(e){ return []; } }
    function getFormActivePhotos(){ try{ return JSON.parse(document.getElementById('f-active-photos').value); }catch(e){ return []; } }
    function setFormPhotos(arr){ document.getElementById('f-photos').value = JSON.stringify(arr); renderPhotoGrid(); }
    function setFormActivePhotos(arr){ document.getElementById('f-active-photos').value = JSON.stringify(arr); renderPhotoGrid(); }

    function addPhotoToForm(){
      var url = document.getElementById('f-photo-add').value.trim();
      if (!url) return;
      var arr = getFormPhotos();
      if (arr.indexOf(url) < 0) arr.push(url);
      setFormPhotos(arr);
      document.getElementById('f-photo-add').value = '';
    }

    function renderPhotoGrid(){
      var photos = getFormPhotos();
      var active = getFormActivePhotos();
      var wrap = document.getElementById('f-photo-grid');
      wrap.innerHTML = photos.map(function(url, i){
        var isActive = active.length === 0 || active.indexOf(url) >= 0;
        return '<div style="background:#f7f8fc;border:1px solid '+(isActive?'#16a34a':'#e2e8f0')+';border-radius:8px;overflow:hidden;opacity:'+(isActive?'1':'0.4')+'">'
          + '<img src="'+url+'" style="width:100%;height:120px;object-fit:cover;display:block;" onerror="this.style.display=\\'none\\'"/>'
          + '<div style="padding:6px;display:flex;gap:4px;flex-wrap:wrap;">'
          + '<button type="button" class="ph-btn ph-active" onclick="togglePhotoActive('+i+')">'+(isActive?'✓ On':'Off')+'</button>'
          + '<button type="button" class="ph-btn ph-remove" onclick="removeFormPhoto('+i+')">×</button>'
          + '</div></div>';
      }).join('');
    }

    function removeFormPhoto(idx){
      var arr = getFormPhotos();
      var removed = arr.splice(idx, 1)[0];
      setFormPhotos(arr);
      var act = getFormActivePhotos().filter(function(u){ return u !== removed; });
      setFormActivePhotos(act);
    }

    function togglePhotoActive(idx){
      var photos = getFormPhotos();
      var act = getFormActivePhotos();
      var url = photos[idx];
      if (act.length === 0) { act = photos.filter(function(u){ return u !== url; }); }
      else {
        var pos = act.indexOf(url);
        if (pos >= 0) act.splice(pos, 1);
        else act.push(url);
        if (act.length === 0) act = photos.slice();
      }
      setFormActivePhotos(act);
    }

    function editTmpl(id) {
      var t = TEMPLATES.find(function(x){ return x.id === id; });
      if (!t) return alert('Template not found');
      saveScrollPos();
      document.getElementById('form-title').textContent = '✏️ Editing: ' + (t.title || t.id);
      document.getElementById('f-id').value = t.id;
      document.getElementById('f-title').value = t.title || '';
      document.getElementById('f-subtitle').value = t.subtitle || '';
      document.getElementById('f-button').value = t.buttonText || '';
      document.getElementById('f-redirect').value = t.redirect || '';
      ${setNames.map(n => `try{document.getElementById('f-redirect-${n}').value = t.set === '${n}' ? (t.redirect||'') : '';}catch(e){}`).join('\n      ')}
      var photos = Array.isArray(t.photos) ? t.photos : (t.photo ? [t.photo] : []);
      setFormPhotos(photos);
      var activeP = Array.isArray(t.activePhotos) ? t.activePhotos : [];
      setFormActivePhotos(activeP);
      document.getElementById('f-submit').textContent = '💾 Save Changes';
      document.getElementById('f-cancel').style.display = 'inline-block';
      if (t.linkedId) {
        document.getElementById('f-linked-block').style.display = 'block';
        document.getElementById('f-linked-id').value = t.linkedId;
      }
      document.getElementById('tmpl-form').scrollIntoView({ behavior: 'smooth' });
    }

    function resetForm() {
      document.getElementById('form-title').textContent = '➕ Add New Template';
      document.getElementById('f-id').value = '';
      document.getElementById('f-title').value = '';
      document.getElementById('f-subtitle').value = '';
      document.getElementById('f-button').value = '';
      document.getElementById('f-redirect').value = '';
      ${setNames.map(n => `try{document.getElementById('f-redirect-${n}').value = '';}catch(e){}`).join('\n      ')}
      setFormPhotos([]);
      setFormActivePhotos([]);
      document.getElementById('f-submit').textContent = '➕ Add Template';
      document.getElementById('f-cancel').style.display = 'none';
      document.getElementById('f-linked-block').style.display = 'none';
      document.getElementById('f-linked-id').value = '';
      document.getElementById('f-linked-redirect').value = '';
    }

    function validateTmplForm(){
      var title = document.getElementById('f-title').value.trim();
      if (!title) { alert('Title is required.'); return false; }
      return true;
    }

    function selectAllTmpls(on){
      document.querySelectorAll('.tmpl-sel').forEach(function(cb){ cb.checked = on; });
      updateSelCount();
    }
    function updateSelCount(){
      var c = document.querySelectorAll('.tmpl-sel:checked').length;
      document.getElementById('sel-count').textContent = c > 0 ? c + ' selected' : '';
    }
    function bulkSetActive(active){
      var ids = []; document.querySelectorAll('.tmpl-sel:checked').forEach(function(cb){ ids.push(cb.value); });
      if (ids.length === 0) return alert('No cards selected.');
      if (!confirm((active ? 'Activate' : 'Pause') + ' ' + ids.length + ' selected card(s)?')) return;
      var f = document.createElement('form'); f.method='POST'; f.action='/template-bulk-active';
      ids.forEach(function(id){ var inp=document.createElement('input'); inp.type='hidden'; inp.name='ids'; inp.value=id; f.appendChild(inp); });
      var inp2=document.createElement('input'); inp2.type='hidden'; inp2.name='active'; inp2.value=active?'true':'false'; f.appendChild(inp2);
      document.body.appendChild(f); f.submit();
    }

    document.addEventListener('click', function(e){
      if (e.target.classList.contains('tmpl-sel')) updateSelCount();
      var dup = e.target.closest('.tmpl-dup-btn');
      if (dup) {
        var tmplId = dup.dataset.id;
        var otherSet = dup.dataset.otherset;
        if (confirm('Duplicate + link this card to "' + otherSet + '"? Both cards will share photos, text, and active status. Only the redirect URL and set will differ.')) {
          window.location.href = '/template-duplicate-linked?id=' + tmplId + '&toSet=' + encodeURIComponent(otherSet);
        }
        return;
      }
      var linkBtn = e.target.closest('.tmpl-link-btn');
      if (linkBtn) {
        var thisId = linkBtn.dataset.id;
        var otherSetName = linkBtn.dataset.otherset;
        openLinkPicker(thisId, otherSetName);
        return;
      }
    });

    function openLinkPicker(thisId, otherSet){
      var candidates = TEMPLATES.filter(function(t){ return (t.set||'${DEFAULT_SET}') === otherSet && !t.linkedId && t.id !== thisId; });
      if (candidates.length === 0) return alert('No available cards in "' + otherSet + '" to link to. Create or unlink one first.');
      var list = candidates.map(function(t){
        return '<div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #e2e8f0;cursor:pointer;" onclick="doLink(\\''+thisId+'\\',\\''+t.id+'\\')"><div><strong>'+escH(t.title)+'</strong></div></div>';
      }).join('');
      var overlay = document.createElement('div');
      overlay.id = 'link-overlay';
      overlay.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)this.remove()"><div style="background:#fff;border-radius:12px;padding:20px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto;"><h3>🔗 Link to a card in '+escH(otherSet)+'</h3>'+list+'<button onclick="this.closest(\\'#link-overlay\\').remove()" class="btn" style="margin-top:12px;width:100%;">Cancel</button></div></div>';
      document.body.appendChild(overlay);
    }
    function doLink(fromId, toId){
      var el = document.getElementById('link-overlay'); if (el) el.remove();
      window.location.href = '/template-link?from=' + fromId + '&to=' + toId;
    }
    function escH(s){ var d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

    renderPhotoGrid();
    </script>
  </div>`;
}

// ============================================
// ALL PAGES VIEW
// ============================================
function renderAllPagesView(pages, req) {
  const todayStr = new Date().toISOString().split('T')[0];
  const globalMode = getGlobalContentMode();
  const globalSendMode = getGlobalSendMode();

  // Check if any broadcast is running
  let anyBroadcastRunning = false;

  const rows = pages.map(p => {
    const fans = loadFans(p.pageId);
    const stats = loadStats(p.pageId);
    const clicks = stats.clicks || [];
    const dailyClicks = clicks.filter(c => (c.time || '').startsWith(todayStr)).length;
    const dailySent = (stats.dailyMessages || {})[todayStr]?.sent || 0;
    const dailyFailed = (stats.dailyMessages || {})[todayStr]?.failed || 0;
    const mode = pageContentMode(p);
    const pSendMode = pageSendMode(p);
    const sNow = p.sendNowEnabled !== false;
    const modeBadge = mode === 'templates'
      ? '<span class="badge" style="background:#ede9fe;color:#6d28d9;">🎴 T</span>'
      : '<span class="badge" style="background:#dbeafe;color:#2563eb;">📷 C</span>';
    const sendModeBadge = pSendMode === 'text'
      ? '<span class="badge" style="background:#fce7f3;color:#be185d;">💬</span>'
      : pSendMode === 'card+text'
      ? '<span class="badge" style="background:#f0fdf4;color:#166534;">📷💬</span>'
      : '';
    const group = p.group ? `<span class="group-badge">${esc(p.group)}</span>` : '<span class="group-badge unassigned">—</span>';

    // Broadcast progress for this page
    const bp = broadcastProgress[p.pageId];
    const isRunning = bp && bp.status === 'running';
    const justFinished = bp && bp.status === 'complete' && bp.finishedAt && (Date.now() - bp.finishedAt < 300000);
    if (isRunning) anyBroadcastRunning = true;
    const pct = isRunning ? Math.round(bp.done / bp.total * 100) : 0;

    let statusCell;
    if (isRunning) {
      statusCell = `<div>
        <div style="font-size:11px;font-weight:700;color:#1e40af;">📡 ${bp.done}/${bp.total}</div>
        <div style="background:#bfdbfe;border-radius:4px;height:6px;width:80px;margin-top:3px;overflow:hidden;">
          <div style="background:#3a8dde;height:100%;width:${pct}%;border-radius:4px;transition:width 0.5s;"></div>
        </div>
      </div>`;
    } else if (justFinished) {
      const agoMin = Math.round((Date.now() - bp.finishedAt) / 60000);
      statusCell = `<div>
        <div style="font-size:11px;font-weight:700;color:#166534;">✅ Done ${bp.total}/${bp.total}</div>
        <div style="font-size:10px;color:#6b7280;">${agoMin < 1 ? 'just now' : agoMin + 'm ago'} · ${bp.type || 'card'}</div>
      </div>`;
    } else {
      statusCell = `<span class="badge ${p.broadcastEnabled ? 'badge-green' : 'badge-gray'}">${p.broadcastEnabled ? 'Auto ON' : 'Auto OFF'}</span>
        ${sNow ? '' : '<span class="badge badge-gray">Send ⏸</span>'}`;
    }

    return `<tr>
      <td style="white-space:nowrap;"><a href="/?page=${esc(p.pageId)}" style="font-weight:600;text-decoration:none;color:#3a8dde;">${esc(p.label)}</a></td>
      <td>${group}</td>
      <td>${fans.length}</td>
      <td>${dailySent}</td>
      <td>${dailyFailed}</td>
      <td>${dailyClicks}</td>
      <td>${modeBadge} ${sendModeBadge}</td>
      <td>${statusCell}</td>
      <td>
        <div class="actions">
          <form action="/send-now-page" method="POST" style="margin:0;">
            <input type="hidden" name="pageId" value="${esc(p.pageId)}"/>
            <button type="submit" class="qbtn qbtn-send" ${sNow ? '' : 'disabled style="opacity:0.4;"'}>📣</button>
          </form>
          <form action="/${p.broadcastEnabled ? 'pause' : 'resume'}-page" method="POST" style="margin:0;">
            <input type="hidden" name="pageId" value="${esc(p.pageId)}"/>
            <button type="submit" class="qbtn ${p.broadcastEnabled ? 'qbtn-pause' : 'qbtn-resume'}">${p.broadcastEnabled ? '⏸' : '▶'}</button>
          </form>
        </div>
      </td>
    </tr>`;
  }).join('');

  const totalFans = pages.reduce((s, p) => s + loadFans(p.pageId).length, 0);
  const totalSent = pages.reduce((s, p) => {
    const st = loadStats(p.pageId);
    return s + ((st.dailyMessages || {})[todayStr]?.sent || 0);
  }, 0);
  const totalFailed = pages.reduce((s, p) => {
    const st = loadStats(p.pageId);
    return s + ((st.dailyMessages || {})[todayStr]?.failed || 0);
  }, 0);
  const totalClicks = pages.reduce((s, p) => {
    const st = loadStats(p.pageId);
    return s + (st.clicks || []).filter(c => (c.time || '').startsWith(todayStr)).length;
  }, 0);
  const autoOn = pages.filter(p => p.broadcastEnabled).length;

  const groups = getAllGroups(pages);
  const eligibleAll = pages.filter(p => p.sendNowEnabled !== false);
  const allFans = eligibleAll.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);

  const groupOptions = groups.map(g => {
    const gPages = pages.filter(p => p.group === g && p.sendNowEnabled !== false);
    const gFans = gPages.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);
    return `<option value="${esc(g)}">${esc(g)} — ${gPages.length} pages · ${gFans} fans</option>`;
  }).join('');

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}

    <div class="grid" style="margin-bottom:18px;">
      <div class="stat"><div class="v">${pages.length}</div><div class="l">Pages</div></div>
      <div class="stat"><div class="v">${totalFans.toLocaleString()}</div><div class="l">Total Fans</div></div>
      <div class="stat"><div class="v">${totalSent.toLocaleString()}</div><div class="l">Sent Today</div></div>
      <div class="stat"><div class="v">${totalFailed.toLocaleString()}</div><div class="l">Failed Today</div></div>
      <div class="stat"><div class="v">${totalClicks}</div><div class="l">Clicks Today</div></div>
      <div class="stat"><div class="v">${autoOn}/${pages.length}</div><div class="l">Auto ON</div></div>
    </div>

    ${renderGroupManager(pages)}

    <!-- ═══ SEND NOW + BULK ACTIONS ═══ -->
    <div style="margin-bottom:12px;padding:14px;background:#f0fdf4;border:2px solid #86efac;border-radius:8px;">
      <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:10px;">📣 Send Now &amp; Bulk Actions</div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        ${groups.length > 0 ? `
        <form action="/send-now-group" method="POST" style="display:inline;margin:0;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <select name="group" style="padding:7px 10px;border:1px solid #86efac;border-radius:6px;font-size:13px;background:#fff;color:#166534;font-weight:600;">
              ${groupOptions}
            </select>
            <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Send Now to selected group?')">📣 Send Group</button>
            <button type="submit" name="randomize" value="1" class="qbtn" style="background:#7c3aed;" onclick="return confirm('Randomize + Send to selected group?')">🎲📣 Rand + Send Group</button>
          </div>
        </form>
        <span style="color:#cbd5e1;font-size:18px;">|</span>` : ''}

        <form action="/send-now-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#166534;" onclick="return confirm('SEND NOW to ALL ${eligibleAll.length} eligible pages (${allFans} fans)?')">📣 Send All (${eligibleAll.length})</button>
        </form>
        <form action="/send-now-all?randomize=1" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#5b21b6;" onclick="return confirm('RANDOMIZE + SEND to ALL?')">🎲📣 Rand + Send All</button>
        </form>

        <span style="color:#cbd5e1;font-size:18px;">|</span>

        <form action="/pause-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#f59e0b;" onclick="return confirm('Pause daily broadcast on ALL pages?')">⏸ Pause All</button>
        </form>
        <form action="/resume-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#28a745;" onclick="return confirm('Resume daily broadcast on ALL pages?')">▶ Resume All</button>
        </form>
        <form action="/randomize-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#8b5cf6;" onclick="return confirm('Randomize all pages?')">🎲 Randomize All</button>
        </form>
        <form action="/reset-stats-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#dc3545;" onclick="return confirm('Reset ALL stats?')">🗑️ Reset All Stats</button>
        </form>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <form action="/pause-sendnow-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#f59e0b;" onclick="return confirm('Pause Send Now on ALL pages?')">🚫 Pause Send Now (All)</button>
        </form>
        <form action="/resume-sendnow-all" method="POST" style="display:inline;margin:0;">
          <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Resume Send Now on ALL pages?')">✅ Resume Send Now (All)</button>
        </form>
      </div>
    </div>

    ${renderLibraryManager()}

    <div style="margin-bottom:12px;padding:12px;background:#faf5ff;border:2px solid #e9d5ff;border-radius:8px;">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:700;color:#6b21a8;">🎚️ Global Card Source:</span>
        <form action="/set-global-mode" method="POST" style="margin:0;display:inline;">
          <input type="hidden" name="mode" value="classic"/>
          <button type="submit" class="qbtn" style="background:${globalMode === 'classic' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'classic' ? '#fff' : '#475569'};">${globalMode === 'classic' ? '✓ ' : ''}📷 Classic</button>
        </form>
        <form action="/set-global-mode" method="POST" style="margin:0;display:inline;">
          <input type="hidden" name="mode" value="templates"/>
          <button type="submit" class="qbtn" style="background:${globalMode === 'templates' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'templates' ? '#fff' : '#475569'};">${globalMode === 'templates' ? '✓ ' : ''}🎴 Templates</button>
        </form>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:700;color:#6b21a8;">📤 Global Send Mode:</span>
        ${['card', 'text', 'card+text'].map(m => {
          const labels = { 'card': '📷 Card Only', 'text': '💬 Text Only', 'card+text': '📷💬 Card + Text' };
          const active = globalSendMode === m;
          return `<form action="/set-global-send-mode" method="POST" style="margin:0;display:inline;">
            <input type="hidden" name="mode" value="${m}"/>
            <button type="submit" class="qbtn" style="background:${active ? '#16a34a' : '#cbd5e1'};color:${active ? '#fff' : '#475569'};">${active ? '✓ ' : ''}${labels[m]}</button>
          </form>`;
        }).join('')}
        ${globalSendMode !== 'card' ? `<span style="font-size:11px;color:#7c3aed;">(${(loadLibrary().textPool || []).length} texts in pool)</span>` : ''}
      </div>
    </div>

    <div class="card">
      <h2>📊 All Pages</h2>
      <div style="overflow-x:auto;">
      <table>
        <tr><th>Label</th><th>Group</th><th>Fans</th><th>Sent</th><th>Failed</th><th>Clicks</th><th>Mode</th><th>Status</th><th></th></tr>
        ${rows}
      </table>
      </div>
    </div>

    <div class="card">
      <h2>➕ Add New Page</h2>
      <form action="/add-page" method="POST">
        <div class="row">
          <div><label>Page ID</label><input name="pageId" required placeholder="123456789012345"/></div>
          <div><label>Access Token</label><input name="accessToken" required placeholder="EAAG…"/></div>
        </div>
        <label>Label</label><input name="label" placeholder="My Page Name"/>
        <label>Group</label>
        <select name="group">
          <option value="">(No group)</option>
          ${getAllGroups(pages).map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
        </select>
        <button type="submit" class="btn btn-green" style="margin-top:12px;">➕ Add Page</button>
      </form>
    </div>

    <div class="card" style="border:2px solid #bae6fd;">
      <h2>☁️ Backup / Restore <span style="font-size:12px;font-weight:400;color:#0284c7;">— all pages, fans, settings, library, stats</span></h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="/backup" class="btn btn-blue" download="messagebot-backup.json">⬇️ Download Full Backup</a>
      </div>
      <form action="/restore-backup" method="POST" enctype="multipart/form-data" style="margin-top:12px;">
        <label>⬆️ Restore from backup JSON</label>
        <input type="file" name="backupFile" accept=".json" style="margin-top:4px;"/>
        <button type="submit" class="btn btn-orange" onclick="return confirm('Restore from backup? This will REPLACE all current data.')">⬆️ Restore</button>
      </form>
    </div>

    ${anyBroadcastRunning ? '<meta http-equiv="refresh" content="10"/>' : ''}
  </div>`;
}

// ============================================
// SINGLE PAGE VIEW
// ============================================

// ============================================
// SINGLE PAGE VIEW
// ============================================
function renderPageView(page, req) {
  const fans = loadFans(page.pageId);
  const stats = loadStats(page.pageId);
  const pid = esc(page.pageId);
  const mr = getMasterRedirect();
  const lib = loadLibrary();
  const groups = getAllGroups();
  const currentSet = pageSet(page, lib);
  const setNames = getSetNames(lib);
  const mode = pageContentMode(page);
  const sMode = pageSendMode(page);
  const hasContentOverride = page.contentMode === 'classic' || page.contentMode === 'templates';
  const hasSendOverride = page.sendMode === 'card' || page.sendMode === 'text' || page.sendMode === 'card+text';
  const photo = getCurrentPhoto(page);
  const destination = mr.enabled && mr.url ? mr.url : page.whatsapp;

  const broadcastInfo = broadcastProgress[page.pageId];
  const broadcastBar = broadcastInfo && broadcastInfo.status === 'running' ? `
    <div class="card" style="border:2px solid #3a8dde;background:#eff6ff;">
      <h2 style="color:#1e40af;">📡 Broadcast in progress…</h2>
      <div style="margin:8px 0;font-size:13px;color:#1e40af;">
        ${broadcastInfo.done} / ${broadcastInfo.total} sent
        · Type: ${broadcastInfo.type || 'card'}
        · ETA: ~${Math.max(0, Math.ceil(((broadcastInfo.total - broadcastInfo.done) * (page.spacingSeconds || 10)) / 60))} min
      </div>
      <div style="background:#bfdbfe;border-radius:8px;height:14px;overflow:hidden;"><div style="background:#3a8dde;height:100%;width:${Math.round(broadcastInfo.done/broadcastInfo.total*100)}%;border-radius:8px;transition:width 0.3s;"></div></div>
      <div style="font-size:11px;color:#2563eb;margin-top:6px;">Page auto-refreshes — or <a href="/?page=${pid}">manual refresh</a></div>
      <meta http-equiv="refresh" content="10;url=/?page=${pid}"/>
    </div>` : '';

  const textMsgs = (Array.isArray(page.textMessages) ? page.textMessages : []);

  // ── Set buttons ──
  const setButtons = setNames.map(name => {
    const isCurrent = name === currentSet;
    const count = (lib.redirectSets[name] || []).length;
    return `<form action="/set-page-redirect-set?page=${pid}" method="POST" style="margin:0;display:inline;">
      <input type="hidden" name="setName" value="${esc(name)}"/>
      <button type="submit" class="qbtn" style="background:${isCurrent ? '#16a34a' : '#cbd5e1'};color:${isCurrent ? '#fff' : '#475569'};">${isCurrent ? '✓ ' : ''}${esc(name)} (${count})</button>
    </form>`;
  }).join('');

  // ── Template count ──
  const tmplCount = templatesForSet(lib, currentSet).filter(t => t.active !== false).length;

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}
    ${broadcastBar}

    <!-- ═══ TOP CONTROL PANEL ═══ -->
    <div class="card" style="border:2px solid #e2e8f0;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        <div>
          <div style="font-size:20px;font-weight:700;color:#1a1d2e;margin-bottom:2px;">${esc(page.label)}</div>
          <div style="font-size:12px;color:#94a3b8;font-family:monospace;">ID: ${pid}</div>
        </div>
        <div style="text-align:center;background:#f0fdf4;border:2px solid #86efac;border-radius:10px;padding:10px 20px;">
          <div style="font-size:28px;font-weight:800;color:#166534;">${fans.length}</div>
          <div style="font-size:11px;color:#16a34a;text-transform:uppercase;font-weight:600;">Fans${page.baselineFans ? ` (${(page.baselineFans||0)+fans.length} total)` : ''}</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #f0f1f5;">
        <form action="/send-now-page" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <button type="submit" class="btn btn-green" ${page.sendNowEnabled !== false ? '' : 'disabled style="opacity:0.4;"'} onclick="return confirm('Send to ${fans.length} fans now?')">📣 Send Now</button>
        </form>
        <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#7c3aed;color:#fff;" ${page.sendNowEnabled !== false ? '' : 'disabled style="opacity:0.4;"'} onclick="return confirm('Randomize + broadcast?')">🎲📣 Randomize + Send</button>
        </form>
        <form action="/${page.sendNowEnabled !== false ? 'pause' : 'resume'}-sendnow-page?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn ${page.sendNowEnabled !== false ? 'btn-orange' : 'btn-green'}">${page.sendNowEnabled !== false ? '🚫 Pause Send Now' : '✅ Resume Send Now'}</button>
        </form>
        <form action="/randomize-page?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;">🎴 Pick Random Template</button>
        </form>
      </div>

      <!-- Redirect Set -->
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #f0f1f5;">
        <span style="font-size:12px;font-weight:700;color:#065f46;">🌐 Redirect Set:</span>
        ${setButtons}
        <span style="font-size:11px;color:#6b7280;">(${tmplCount} active templates in ${esc(currentSet)})</span>
      </div>

      <!-- Group + Token + Auto -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #f0f1f5;">
        <div style="min-width:140px;">
          <div style="font-size:11px;font-weight:600;color:#4a5568;margin-bottom:3px;">Group</div>
          <form action="/update-settings?page=${pid}" method="POST" id="group-form" style="margin:0;display:flex;gap:4px;">
            <input type="hidden" name="label" value="${esc(page.label)}"/>
            <input type="hidden" name="accessToken" value="${esc(page.accessToken)}"/>
            <input type="hidden" name="broadcastTime" value="${esc(page.broadcastTime || '07:30')}"/>
            <input type="hidden" name="timezone" value="${esc(page.timezone || 'UTC')}"/>
            <input type="hidden" name="spacingSeconds" value="${page.spacingSeconds || 10}"/>
            <input type="hidden" name="baselineFans" value="${page.baselineFans || 0}"/>
            <input type="hidden" name="cleanupThreshold" value="${page.cleanupThreshold !== undefined ? page.cleanupThreshold : 1}"/>
            <select name="group" onchange="this.form.submit()" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
              <option value="">(None)</option>
              ${groups.map(g => `<option value="${esc(g)}" ${page.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
            </select>
          </form>
        </div>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:11px;font-weight:600;color:#4a5568;margin-bottom:3px;">Access Token</div>
          <form action="/update-settings?page=${pid}" method="POST" style="margin:0;display:flex;gap:4px;">
            <input type="hidden" name="label" value="${esc(page.label)}"/>
            <input type="hidden" name="broadcastTime" value="${esc(page.broadcastTime || '07:30')}"/>
            <input type="hidden" name="timezone" value="${esc(page.timezone || 'UTC')}"/>
            <input type="hidden" name="spacingSeconds" value="${page.spacingSeconds || 10}"/>
            <input type="hidden" name="baselineFans" value="${page.baselineFans || 0}"/>
            <input type="hidden" name="group" value="${esc(page.group || '')}"/>
            <input type="hidden" name="cleanupThreshold" value="${page.cleanupThreshold !== undefined ? page.cleanupThreshold : 1}"/>
            <input name="accessToken" value="${esc(page.accessToken)}" style="flex:1;padding:6px 8px;font-size:12px;font-family:monospace;"/>
            <button type="submit" class="qbtn" style="background:#3a8dde;">💾</button>
          </form>
        </div>
        <div>
          <form action="/${page.broadcastEnabled ? 'pause' : 'resume'}-page" method="POST" style="margin:0;">
            <input type="hidden" name="pageId" value="${pid}"/>
            <button type="submit" class="btn ${page.broadcastEnabled ? 'btn-orange' : 'btn-green'}" style="font-size:12px;">${page.broadcastEnabled ? '⏸ Auto OFF' : '▶ Auto ON'}</button>
          </form>
        </div>
      </div>

      <!-- Import Fans + Clear -->
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">
        <form action="/import-fans?page=${pid}" method="POST" style="margin:0;display:flex;gap:6px;align-items:flex-start;flex:1;min-width:250px;">
          <textarea name="fans" placeholder="Paste fan PSIDs — one per line or comma-separated" style="flex:1;min-height:38px;max-height:60px;padding:7px;font-family:monospace;font-size:11px;resize:vertical;"></textarea>
          <button type="submit" class="qbtn" style="background:#16a34a;padding:8px 12px;">⬆️ Import</button>
        </form>
        <a href="/export-fans?page=${pid}" class="qbtn" style="background:#3a8dde;padding:8px 12px;text-decoration:none;" download="fans-${pid}.txt">⬇️ Export</a>
        <form action="/clear-fans?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="qbtn" style="background:#dc2626;padding:8px 12px;" onclick="return confirm('Remove ALL ${fans.length} fans? Cannot be undone!')">🗑️ Clear Fans</button>
        </form>
      </div>
    </div>

    <!-- ═══ CONTENT MODE + SEND MODE ═══ -->
    <div class="card" style="border:2px solid #e9d5ff;">
      <h2>🎚️ Content Mode &amp; Send Mode</h2>
      <div style="margin-bottom:14px;">
        <div style="font-size:13px;font-weight:700;color:#6b21a8;margin-bottom:6px;">Card Source: ${hasContentOverride ? '<span style="background:#fbbf24;color:#92400e;padding:2px 8px;border-radius:6px;font-size:11px;margin-left:4px;">PAGE OVERRIDE</span>' : '<span style="color:#16a34a;font-size:11px;margin-left:4px;">(using global)</span>'}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;">
            <input type="hidden" name="mode" value="classic"/>
            <button type="submit" class="qbtn" style="background:${mode === 'classic' ? '#16a34a' : '#cbd5e1'};color:${mode === 'classic' ? '#fff' : '#475569'};">${mode === 'classic' ? '✓ ' : ''}📷 Classic</button>
          </form>
          <form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;">
            <input type="hidden" name="mode" value="templates"/>
            <button type="submit" class="qbtn" style="background:${mode === 'templates' ? '#16a34a' : '#cbd5e1'};color:${mode === 'templates' ? '#fff' : '#475569'};">${mode === 'templates' ? '✓ ' : ''}🎴 Templates</button>
          </form>
          ${hasContentOverride ? `<form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;">
            <input type="hidden" name="mode" value="global"/>
            <button type="submit" class="qbtn" style="background:#fbbf24;color:#92400e;">↩ Use Global</button>
          </form>` : ''}
        </div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:700;color:#6b21a8;margin-bottom:6px;">Send Mode: ${hasSendOverride ? '<span style="background:#fbbf24;color:#92400e;padding:2px 8px;border-radius:6px;font-size:11px;margin-left:4px;">PAGE OVERRIDE</span>' : '<span style="color:#16a34a;font-size:11px;margin-left:4px;">(using global)</span>'}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          ${['card', 'text', 'card+text'].map(m => {
            const labels = { 'card': '📷 Card Only', 'text': '💬 Text Only', 'card+text': '📷💬 Card + Text' };
            const active = sMode === m;
            return `<form action="/set-page-send-mode?page=${pid}" method="POST" style="margin:0;">
              <input type="hidden" name="mode" value="${m}"/>
              <button type="submit" class="qbtn" style="background:${active ? '#16a34a' : '#cbd5e1'};color:${active ? '#fff' : '#475569'};">${active ? '✓ ' : ''}${labels[m]}</button>
            </form>`;
          }).join('')}
          ${hasSendOverride ? `<form action="/set-page-send-mode?page=${pid}" method="POST" style="margin:0;">
            <input type="hidden" name="mode" value="global"/>
            <button type="submit" class="qbtn" style="background:#fbbf24;color:#92400e;">↩ Use Global</button>
          </form>` : ''}
          ${sMode !== 'card' ? `<span style="font-size:11px;color:#7c3aed;">(${(lib.textPool || []).length} texts in pool)</span>` : ''}
        </div>
      </div>
    </div>

    <!-- ═══ CARD PREVIEW + EDIT ═══ -->
    <div class="card">
      <h2>📷 Card Preview &amp; Edit</h2>
      <div style="display:flex;gap:20px;flex-wrap:wrap;">
        <div style="max-width:260px;flex-shrink:0;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
          <div style="aspect-ratio:1/1;background:#f1f5f9;overflow:hidden;">
            <img src="${esc(photo)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=padding:20px;text-align:center;color:#94a3b8;>No image</div>';"/>
          </div>
          <div style="padding:10px;">
            <div style="font-weight:600;font-size:14px;">${esc(page.title)}</div>
            <div style="font-size:12px;color:#6b7280;margin:3px 0 8px;">${esc(page.subtitle)}</div>
            <div style="text-align:center;padding:8px;background:#3a8dde;color:#fff;border-radius:6px;font-size:13px;font-weight:600;">${esc(page.buttonText)}</div>
            ${mr.enabled && mr.url ? '<div style="font-size:10px;color:#f59e0b;text-align:center;margin-top:4px;">⚠️ Master redirect ON</div>' : ''}
          </div>
        </div>
        <div style="flex:1;min-width:240px;">
          <form action="/update-page?page=${pid}" method="POST">
            <label>Title</label><input name="title" value="${esc(page.title)}"/>
            <label>Subtitle</label><input name="subtitle" value="${esc(page.subtitle)}"/>
            <label>Button Text</label><input name="buttonText" value="${esc(page.buttonText)}"/>
            <label>Redirect URL</label><input name="whatsapp" value="${esc(page.whatsapp)}" style="font-family:monospace;font-size:12px;"/>
            <button type="submit" class="btn btn-green">💾 Save Card</button>
          </form>
        </div>
      </div>
    </div>

    <!-- ═══ SAVED TEXT MESSAGES ═══ -->
    <div class="card" style="border:2px solid #ddd6fe;">
      <h2>💬 Saved Text Messages <span style="font-size:12px;font-weight:400;color:#7c3aed;">— independent of send mode</span></h2>
      <form action="/save-text-message?page=${pid}" method="POST" style="margin-bottom:14px;display:flex;gap:8px;align-items:flex-start;">
        <textarea name="text" rows="2" placeholder="Type a message to save…" style="flex:1;"></textarea>
        <button type="submit" class="btn btn-green" style="white-space:nowrap;">💾 Save</button>
      </form>
      ${textMsgs.length === 0 ? '<div style="color:#94a3b8;font-size:13px;">No saved messages yet.</div>' :
        textMsgs.map((m, i) => `
          <div style="background:#f7f8fc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:flex-start;gap:10px;">
            <div style="flex:1;font-size:13px;color:#1a1d2e;white-space:pre-wrap;">${esc(m.text)}</div>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <form action="/send-text-message-now?page=${pid}" method="POST" style="margin:0;">
                <input type="hidden" name="index" value="${i}"/>
                <button type="submit" class="qbtn qbtn-send" onclick="return confirm('Send to ALL ${fans.length} fans?')">📣</button>
              </form>
              <form action="/delete-text-message?page=${pid}" method="POST" style="margin:0;">
                <input type="hidden" name="index" value="${i}"/>
                <button type="submit" class="qbtn" style="background:#dc2626;" onclick="return confirm('Delete?')">🗑️</button>
              </form>
            </div>
          </div>
        `).join('')
      }
    </div>

    <!-- ═══ PAGE PHOTOS ═══ -->
    <div class="card">
      <h2>📸 Photos <span style="font-size:12px;font-weight:400;color:#94a3b8;">(${(page.photos||[]).length} on this page)</span></h2>
      <div class="photo-grid">
        ${(page.photos || []).map((url, i) => {
          const isCurrent = url === page.currentPhoto;
          return `<div class="item ${isCurrent ? 'current' : ''}">
            <div class="img-wrap">
              <img src="${esc(url)}" onerror="this.style.display='none'"/>
            </div>
            <div class="url-row">
              <input readonly value="${esc(url)}"/>
              <a href="/remove-photo?page=${pid}&index=${i}" onclick="return confirm('Remove?')">×</a>
            </div>
            <div class="action-row">
              ${isCurrent ? '<span class="badge-current">★ ACTIVE</span>' :
                `<a href="/set-photo?page=${pid}&index=${i}" class="ph-btn ph-active">Set Active</a>`}
            </div>
          </div>`;
        }).join('')}
      </div>
      <form action="/add-photo?page=${pid}" method="POST" style="margin-top:14px;display:flex;gap:8px;">
        <input name="photoUrl" placeholder="https://i.imgur.com/xxxxx.png" style="flex:1;"/>
        <button type="submit" class="btn btn-green">+ Add</button>
      </form>
    </div>

    <!-- ═══ SETTINGS ═══ -->
    <div class="card">
      <h2>⚙️ Settings</h2>
      <form action="/update-settings?page=${pid}" method="POST">
        <div class="row">
          <div><label>Label</label><input name="label" value="${esc(page.label)}"/></div>
          <div><label>Access Token</label><input name="accessToken" value="${esc(page.accessToken)}"/></div>
        </div>
        <div class="row">
          <div><label>Broadcast Time</label><input name="broadcastTime" type="time" value="${esc(page.broadcastTime || '07:30')}"/></div>
          <div><label>Timezone</label>
            <select name="timezone">
              ${['UTC','US/Eastern','US/Central','US/Mountain','US/Pacific','Europe/London','Europe/Berlin','Asia/Kolkata','Asia/Tokyo','Australia/Sydney','America/New_York','America/Chicago','America/Denver','America/Los_Angeles'].map(tz =>
                `<option value="${tz}" ${page.timezone === tz ? 'selected' : ''}>${tz}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <div class="row">
          <div><label>Fan Spacing</label>${renderSpacingSelect('spacingSeconds', page.spacingSeconds || 10)}</div>
          <div><label>Baseline Fans</label><input name="baselineFans" type="number" value="${page.baselineFans || 0}" min="0"/></div>
        </div>
        <div class="row">
          <div><label>Group</label>
            <select name="group">
              <option value="">(No group)</option>
              ${groups.map(g => `<option value="${esc(g)}" ${page.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
            </select>
          </div>
          <div><label>Auto-remove after N fails <span style="font-weight:400;color:#6b7280;">(0=never)</span></label>
            <input name="cleanupThreshold" type="number" value="${page.cleanupThreshold !== undefined ? page.cleanupThreshold : 1}" min="0"/>
          </div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
          <button type="submit" class="btn btn-green">💾 Save Settings</button>
          <form action="/${page.broadcastEnabled ? 'pause' : 'resume'}-page" method="POST" style="margin:0;">
            <input type="hidden" name="pageId" value="${pid}"/>
            <button type="submit" class="btn ${page.broadcastEnabled ? 'btn-orange' : 'btn-green'}">${page.broadcastEnabled ? '⏸ Pause Auto' : '▶ Resume Auto'}</button>
          </form>
          <form action="/setup-messenger-page?page=${pid}" method="POST" style="margin:0;">
            <button type="submit" class="btn btn-blue">🔧 Setup Messenger</button>
          </form>
        </div>
      </form>
    </div>

    <!-- ═══ FAN LIST ═══ -->
    <div class="card">
      <h2>📋 Fan List <span style="font-size:13px;font-weight:400;color:#6b7280;">(${fans.length})</span></h2>
      <details>
        <summary style="cursor:pointer;font-weight:600;color:#4a5568;font-size:13px;">Show all fans</summary>
        <div style="max-height:300px;overflow-y:auto;background:#f7f8fc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;margin-top:8px;">
          ${fans.length === 0 ? '<div style="color:#94a3b8;font-size:12px;">No fans yet.</div>' :
            fans.map(psid => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid #f0f1f5;">
              <span style="font-family:monospace;font-size:12px;flex:1;">${esc(psid)}</span>
              <a href="/remove-fan?page=${pid}&psid=${esc(psid)}" onclick="return confirm('Remove?')" style="font-size:11px;color:#dc2626;text-decoration:none;">×</a>
            </div>`).join('')
          }
        </div>
      </details>
    </div>

    <!-- ═══ DANGER ZONE ═══ -->
    <div class="card danger-zone">
      <h2>⚠️ Danger Zone</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <form action="/reset-stats?page=${pid}" method="POST" style="margin:0;">
          <button type="submit" class="btn btn-red" onclick="return confirm('Reset all stats?')">🗑️ Reset Stats</button>
        </form>
        <form action="/remove-page" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <button type="submit" class="btn btn-red" onclick="return confirm('Permanently remove this page and all data?')">🗑️ Remove Page</button>
        </form>
      </div>
    </div>

    <!-- ═══ SCHEDULED SEND ═══ -->
    <div class="card">
      <h2>📅 Scheduled Send</h2>
      <form action="/schedule-send?page=${pid}" method="POST" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div><label>Send at</label><input type="datetime-local" name="sendAt"/></div>
        <button type="submit" class="btn btn-blue">📅 Schedule</button>
      </form>
      ${page.scheduledSend ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;margin-top:8px;font-size:13px;color:#1e40af;">⏰ ${esc(page.scheduledSend)}<form action="/cancel-schedule?page=${pid}" method="POST" style="display:inline;margin-left:10px;"><button type="submit" class="qbtn" style="background:#dc2626;">Cancel</button></form></div>` : ''}
    </div>
  </div>`;
}

// ============================================
// MAIN ROUTE
// ============================================
app.get('/', (req, res) => {
  const pages = loadPages();
  const selected = req.query.page;
  let body;
  if (selected === 'templates') {
    body = renderHead('messagebot — Templates') + renderTopbar(pages, 'templates') + renderTemplateManager(req) + '</body></html>';
  } else if (selected && selected !== 'all') {
    const page = pages.find(p => p.pageId === selected);
    if (!page) return res.redirect('/?error=Page+not+found');
    body = renderHead(`messagebot — ${page.label}`) + renderTopbar(pages, selected) + renderPageView(page, req) + '</body></html>';
  } else {
    body = renderHead('messagebot — All Pages') + renderTopbar(pages, 'all') + renderAllPagesView(pages, req) + '</body></html>';
  }
  res.send(body);
});

// ============================================
// PAGE MANAGEMENT ROUTES
// ============================================
app.post('/add-page', (req, res) => {
  const { pageId, accessToken, label, group } = req.body;
  if (!pageId || !accessToken) return res.redirect('/?error=Page+ID+and+Access+Token+required');
  const data = { pageId, accessToken, label };
  if (group) { data.group = group; saveGroupName(group); }
  const page = addPage(data);
  if (!page) return res.redirect('/?error=Page+already+exists');
  setupMessenger(page);
  res.redirect('/?added=1');
});

app.post('/remove-page', (req, res) => {
  removePage(req.body.pageId);
  res.redirect('/?removed=1');
});

app.post('/update-page', (req, res) => {
  const pid = req.query.page;
  const { title, subtitle, buttonText, whatsapp } = req.body;
  updatePage(pid, { title, subtitle, buttonText, whatsapp: normalizeUrl(whatsapp) });
  res.redirect(`/?page=${pid}&saved=1`);
});

app.post('/update-settings', (req, res) => {
  const pid = req.query.page;
  const { label, accessToken, broadcastTime, timezone, spacingSeconds, baselineFans, group, cleanupThreshold } = req.body;
  const updates = {
    label: label || 'Unnamed',
    accessToken,
    broadcastTime: broadcastTime || '07:30',
    timezone: timezone || 'UTC',
    spacingSeconds: parseInt(spacingSeconds) || 10,
    baselineFans: parseInt(baselineFans) || 0,
    group: (group || '').trim(),
    cleanupThreshold: parseInt(cleanupThreshold) || 0
  };
  if (updates.group) saveGroupName(updates.group);
  updatePage(pid, updates);
  res.redirect(`/?page=${pid}&saved=1`);
});

app.post('/setup-messenger-page', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (page) setupMessenger(page);
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// GROUP ROUTES
// ============================================
app.post('/group-create', (req, res) => {
  const name = (req.body.group || '').trim();
  if (name) saveGroupName(name);
  res.redirect('/?saved=1');
});

app.post('/group-delete', (req, res) => {
  const name = (req.body.group || '').trim();
  if (name) {
    deleteGroupName(name);
    const pages = loadPages();
    pages.forEach(p => { if (p.group === name) updatePage(p.pageId, { group: '' }); });
  }
  res.redirect('/?saved=1');
});

// ============================================
// BULK SEND / PAUSE / RESUME
// ============================================
app.post('/send-now-page', (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  if (page.sendNowEnabled === false) return res.redirect(`/?page=${page.pageId}&error=Send+Now+is+paused`);
  broadcastToPage(page);
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/send-now-group', (req, res) => {
  const group = req.body.group;
  const randomize = req.body.randomize === '1';
  const pages = loadPages().filter(p => p.group === group && p.sendNowEnabled !== false);
  pages.forEach(p => {
    if (randomize) {
      const updated = randomizePage(p);
      broadcastToPage(updated || p);
    } else {
      broadcastToPage(p);
    }
  });
  res.redirect(`/?saved=1&lib_msg=Sent+to+${pages.length}+pages+in+${encodeURIComponent(group)}`);
});

app.post('/send-now-all', (req, res) => {
  const randomize = req.query.randomize === '1' || req.body.randomize === '1';
  const pages = loadPages().filter(p => p.sendNowEnabled !== false);
  pages.forEach(p => {
    if (randomize) {
      const updated = randomizePage(p);
      broadcastToPage(updated || p);
    } else {
      broadcastToPage(p);
    }
  });
  res.redirect(`/?saved=1&lib_msg=Sent+to+${pages.length}+eligible+pages`);
});

app.post('/pause-page', (req, res) => {
  updatePage(req.body.pageId, { broadcastEnabled: false });
  const redir = req.query.page || req.body.pageId;
  res.redirect(redir ? `/?page=${redir}&saved=1` : '/?saved=1');
});
app.post('/resume-page', (req, res) => {
  updatePage(req.body.pageId, { broadcastEnabled: true });
  const redir = req.query.page || req.body.pageId;
  res.redirect(redir ? `/?page=${redir}&saved=1` : '/?saved=1');
});
app.post('/pause-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { broadcastEnabled: false }));
  res.redirect('/?saved=1');
});
app.post('/resume-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { broadcastEnabled: true }));
  res.redirect('/?saved=1');
});
app.post('/pause-sendnow-page', (req, res) => {
  const pid = req.query.page;
  updatePage(pid, { sendNowEnabled: false });
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/resume-sendnow-page', (req, res) => {
  const pid = req.query.page;
  updatePage(pid, { sendNowEnabled: true });
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/pause-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: false }));
  res.redirect('/?saved=1');
});
app.post('/resume-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: true }));
  res.redirect('/?saved=1');
});
app.post('/reset-stats', (req, res) => {
  resetStats(req.query.page);
  res.redirect(`/?page=${req.query.page}&saved=1`);
});
app.post('/reset-stats-all', (req, res) => {
  loadPages().forEach(p => resetStats(p.pageId));
  res.redirect('/?saved=1');
});

// ============================================
// GLOBAL MODE + SEND MODE ROUTES
// ============================================
app.post('/set-global-mode', (req, res) => {
  const mode = req.body.mode === 'templates' ? 'templates' : 'classic';
  const s = loadSettings();
  s.contentMode = mode;
  saveSettings(s);
  const redir = req.query.page || '';
  res.redirect(redir ? `/?page=${redir}&saved=1` : '/?saved=1');
});
app.post('/set-page-mode', (req, res) => {
  const pid = req.query.page;
  const mode = req.body.mode;
  if (mode === 'global') {
    const page = getPage(pid);
    if (page) {
      const updates = { ...page };
      delete updates.contentMode;
      const pages = loadPages();
      const idx = pages.findIndex(p => p.pageId === pid);
      if (idx >= 0) { pages[idx] = updates; savePages(pages); }
    }
  } else {
    updatePage(pid, { contentMode: mode === 'templates' ? 'templates' : 'classic' });
  }
  res.redirect(`/?page=${pid}&saved=1`);
});

// ── Send Mode routes ──
app.post('/set-global-send-mode', (req, res) => {
  const mode = req.body.mode;
  const valid = ['card', 'text', 'card+text'];
  const s = loadSettings();
  s.sendMode = valid.includes(mode) ? mode : 'card';
  saveSettings(s);
  res.redirect('/?saved=1');
});

app.post('/set-page-send-mode', (req, res) => {
  const pid = req.query.page;
  const mode = req.body.mode;
  if (mode === 'global') {
    const page = getPage(pid);
    if (page) {
      const updates = { ...page };
      delete updates.sendMode;
      const pages = loadPages();
      const idx = pages.findIndex(p => p.pageId === pid);
      if (idx >= 0) { pages[idx] = updates; savePages(pages); }
    }
  } else {
    const valid = ['card', 'text', 'card+text'];
    updatePage(pid, { sendMode: valid.includes(mode) ? mode : 'card' });
  }
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// PHOTO ROUTES
// ============================================
app.get('/set-photo', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (page && page.photos && page.photos[req.query.index]) {
    updatePage(pid, { currentPhoto: page.photos[req.query.index] });
  }
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/add-photo', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  const url = (req.body.photoUrl || '').trim();
  if (page && url) {
    const photos = Array.isArray(page.photos) ? [...page.photos] : [];
    if (!photos.includes(url)) photos.push(url);
    updatePage(pid, { photos });
  }
  res.redirect(`/?page=${pid}&saved=1`);
});
app.get('/remove-photo', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  const idx = parseInt(req.query.index);
  if (page && !isNaN(idx) && Array.isArray(page.photos)) {
    const photos = [...page.photos];
    photos.splice(idx, 1);
    const updates = { photos };
    if (page.currentPhoto === page.photos[idx] && photos.length) updates.currentPhoto = photos[0];
    updatePage(pid, updates);
  }
  res.redirect(`/?page=${pid}&saved=1`);
});
app.get('/set-active-from-library', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const lib = loadLibrary();
  const updates = {};
  if (req.query.photoIndex !== undefined) {
    const url = lib.photos[parseInt(req.query.photoIndex)];
    if (url) {
      updates.currentPhoto = url;
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (!photos.includes(url)) photos.unshift(url);
      updates.photos = photos;
    }
  }
  if (req.query.redirectIndex !== undefined) {
    const setName = pageSet(page, lib);
    const pool = lib.redirectSets[setName] || [];
    const url = pool[parseInt(req.query.redirectIndex)];
    if (url) updates.whatsapp = url;
  }
  if (Object.keys(updates).length) updatePage(pid, updates);
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// LIBRARY ROUTES
// ============================================
app.post('/library-add-photo', (req, res) => {
  const lib = loadLibrary();
  const raw = req.body.photoUrls || '';
  const urls = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  urls.forEach(url => { if (!lib.photos.includes(url)) lib.photos.push(url); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + urls.length + '+photo(s)');
});
app.get('/library-remove-photo', (req, res) => {
  const lib = loadLibrary();
  const idx = parseInt(req.query.index);
  if (!isNaN(idx) && idx >= 0 && idx < lib.photos.length) lib.photos.splice(idx, 1);
  saveLibrary(lib);
  res.redirect('/?lib_msg=Photo+removed');
});
app.post('/library-add-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.body.setName || DEFAULT_SET;
  if (!lib.redirectSets[setName]) lib.redirectSets[setName] = [];
  const raw = req.body.redirectUrls || '';
  const urls = raw.split(/[\n,]+/).map(s => normalizeUrl(s.trim())).filter(Boolean);
  urls.forEach(url => { if (!lib.redirectSets[setName].includes(url)) lib.redirectSets[setName].push(url); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + urls.length + '+URL(s)+to+' + encodeURIComponent(setName));
});
app.get('/library-remove-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.query.set || DEFAULT_SET;
  const idx = parseInt(req.query.index);
  if (lib.redirectSets[setName] && !isNaN(idx) && idx >= 0 && idx < lib.redirectSets[setName].length) {
    lib.redirectSets[setName].splice(idx, 1);
  }
  saveLibrary(lib);
  res.redirect('/?lib_msg=URL+removed+from+' + encodeURIComponent(setName));
});
app.get('/set-page-redirect-set', (req, res) => {
  const pid = req.query.page;
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/set-page-redirect-set', (req, res) => {
  const pid = req.query.page;
  const setName = req.body.setName || DEFAULT_SET;
  updatePage(pid, { redirectSet: setName });
  res.redirect(`/?page=${pid}&saved=1`);
});

// ── Text rotation pools ──
app.post('/library-add-text', (req, res) => {
  const lib = loadLibrary();
  const key = req.body.key;
  if (!['titles', 'subtitles', 'buttonTexts'].includes(key)) return res.redirect('/?error=Invalid+key');
  if (!Array.isArray(lib[key])) lib[key] = [];
  const raw = req.body.items || '';
  const items = raw.split(/\n/).map(s => s.trim()).filter(Boolean);
  items.forEach(item => { if (!lib[key].includes(item)) lib[key].push(item); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + items.length + '+item(s)');
});
app.get('/library-remove-text', (req, res) => {
  const lib = loadLibrary();
  const key = req.query.key;
  const idx = parseInt(req.query.index);
  if (['titles', 'subtitles', 'buttonTexts'].includes(key) && Array.isArray(lib[key]) && !isNaN(idx) && idx >= 0 && idx < lib[key].length) {
    lib[key].splice(idx, 1);
  }
  saveLibrary(lib);
  res.redirect('/?lib_msg=Item+removed');
});

// ── Text Message Pool routes ──
app.post('/library-add-text-pool', (req, res) => {
  const lib = loadLibrary();
  if (!Array.isArray(lib.textPool)) lib.textPool = [];
  const raw = req.body.texts || '';
  const items = raw.split(/\n/).map(s => s.trim()).filter(Boolean);
  items.forEach(item => lib.textPool.push(item));
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + items.length + '+text+message(s)+to+pool');
});

app.get('/library-remove-text-pool', (req, res) => {
  const lib = loadLibrary();
  const idx = parseInt(req.query.index);
  if (Array.isArray(lib.textPool) && !isNaN(idx) && idx >= 0 && idx < lib.textPool.length) {
    lib.textPool.splice(idx, 1);
  }
  saveLibrary(lib);
  res.redirect('/?lib_msg=Text+message+removed+from+pool');
});

app.post('/library-clear-text-pool', (req, res) => {
  const lib = loadLibrary();
  lib.textPool = [];
  saveLibrary(lib);
  res.redirect('/?lib_msg=Text+pool+cleared');
});

// ============================================
// RANDOMIZE ROUTES
// ============================================
app.post('/randomize-page', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const only = req.query.only;
  const opts = {};
  if (only === 'photo') opts.redirect = false;
  if (only === 'redirect') opts.photo = false;
  randomizePage(page, opts);
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/randomize-and-send', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  if (page.sendNowEnabled === false) return res.redirect(`/?page=${pid}&error=Send+Now+is+paused`);
  const updated = randomizePage(page);
  broadcastToPage(updated || page);
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/randomize-all', (req, res) => {
  loadPages().forEach(p => randomizePage(p));
  res.redirect('/?saved=1');
});

// ============================================
// TEXT MESSAGE ROUTES (per-page saved messages — separate from pool)
// ============================================
app.post('/save-text-message', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const text = (req.body.text || '').trim();
  if (!text) return res.redirect(`/?page=${pid}&error=Empty+message`);
  const msgs = Array.isArray(page.textMessages) ? [...page.textMessages] : [];
  msgs.push({ text, createdAt: new Date().toISOString() });
  updatePage(pid, { textMessages: msgs });
  res.redirect(`/?page=${pid}&text_saved=1`);
});
app.post('/send-text-message-now', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const msgs = Array.isArray(page.textMessages) ? page.textMessages : [];
  const idx = parseInt(req.body.index);
  if (isNaN(idx) || !msgs[idx]) return res.redirect(`/?page=${pid}&error=Message+not+found`);
  broadcastToPage(page, { textOnly: true, text: msgs[idx].text });
  res.redirect(`/?page=${pid}&saved=1`);
});
app.post('/delete-text-message', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const msgs = Array.isArray(page.textMessages) ? [...page.textMessages] : [];
  const idx = parseInt(req.body.index);
  if (!isNaN(idx) && idx >= 0 && idx < msgs.length) msgs.splice(idx, 1);
  updatePage(pid, { textMessages: msgs });
  res.redirect(`/?page=${pid}&saved=1`);
});

app.post('/send-text-now', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (!page) return res.redirect('/?error=Page+not+found');
  const text = (req.body.text || '').trim();
  if (!text) return res.redirect(`/?page=${pid}&error=Empty+text`);
  broadcastTextToPage(page, text);
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// TEMPLATE ROUTES
// ============================================
app.post('/template-add', (req, res) => {
  const lib = loadLibrary();
  const id = req.body.id || `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const photos = parsePhotos(req.body.photos);
  const activePhotos = parsePhotos(req.body.activePhotos);
  const title = (req.body.title || '').trim();
  const subtitle = (req.body.subtitle || '').trim();
  const buttonText = (req.body.buttonText || '').trim();

  const setNames = getSetNames(lib);
  const redirectsBySet = {};
  setNames.forEach(name => {
    const val = (req.body['redirect_' + name] || '').trim();
    if (val) redirectsBySet[name] = normalizeUrl(val);
  });
  const legacyRedirect = (req.body.redirect || '').trim();

  if (req.body.id) {
    // EDIT existing template
    const existing = lib.cardTemplates.find(t => t.id === id);
    if (existing) {
      existing.title = title || existing.title;
      existing.subtitle = subtitle || existing.subtitle;
      existing.buttonText = buttonText || existing.buttonText;
      if (photos.length) { existing.photos = photos; existing.photo = photos[0]; }
      existing.activePhotos = activePhotos;

      const newRedirect = redirectsBySet[existing.set || DEFAULT_SET] || legacyRedirect;
      if (newRedirect) existing.redirect = normalizeUrl(newRedirect);

      // Sync to linked partner
      if (existing.linkedId) {
        const partner = lib.cardTemplates.find(t => t.id === existing.linkedId);
        if (partner) {
          partner.title = existing.title;
          partner.subtitle = existing.subtitle;
          partner.buttonText = existing.buttonText;
          partner.photos = existing.photos;
          partner.photo = existing.photo;
          partner.activePhotos = existing.activePhotos;
          const partnerRedirect = redirectsBySet[partner.set || DEFAULT_SET];
          if (partnerRedirect) partner.redirect = normalizeUrl(partnerRedirect);
        }
      }
    }
    saveLibrary(lib);
    return res.redirect('/?page=templates&saved=1');
  }

  // ADD new template(s) — one per filled redirect
  const filledSets = Object.entries(redirectsBySet);
  if (filledSets.length === 0 && legacyRedirect) {
    filledSets.push([DEFAULT_SET, normalizeUrl(legacyRedirect)]);
  }
  if (filledSets.length === 0) {
    filledSets.push([DEFAULT_SET, '']);
  }

  const newIds = [];
  filledSets.forEach(([setName, redirect]) => {
    const newId = `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    lib.cardTemplates.push({
      id: newId, set: setName, title, subtitle, buttonText,
      redirect: redirect || '',
      photos, photo: photos[0] || '', activePhotos, active: true
    });
    newIds.push(newId);
  });

  if (newIds.length > 1) {
    newIds.forEach((nid, i) => {
      const t = lib.cardTemplates.find(x => x.id === nid);
      if (t) t.linkedId = newIds[i === 0 ? 1 : 0];
    });
  }

  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-delete', (req, res) => {
  const lib = loadLibrary();
  const id = req.query.id;
  const tmpl = lib.cardTemplates.find(t => t.id === id);
  if (tmpl && tmpl.linkedId) {
    const partner = lib.cardTemplates.find(t => t.id === tmpl.linkedId);
    if (partner) delete partner.linkedId;
  }
  lib.cardTemplates = lib.cardTemplates.filter(t => t.id !== id);
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.post('/template-bulk-active', (req, res) => {
  const lib = loadLibrary();
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  const active = req.body.active === 'true';
  ids.forEach(id => {
    const t = lib.cardTemplates.find(x => x.id === id);
    if (t) {
      t.active = active;
      if (t.linkedId) {
        const partner = lib.cardTemplates.find(x => x.id === t.linkedId);
        if (partner) partner.active = active;
      }
    }
  });
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-duplicate-linked', (req, res) => {
  const lib = loadLibrary();
  const src = lib.cardTemplates.find(t => t.id === req.query.id);
  if (!src) return res.redirect('/?page=templates&error=Template+not+found');
  const toSet = req.query.toSet || SECOND_SET;
  const newId = `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dup = { ...src, id: newId, set: toSet, redirect: '', linkedId: src.id };
  src.linkedId = newId;
  lib.cardTemplates.push(dup);
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-link', (req, res) => {
  const lib = loadLibrary();
  const from = lib.cardTemplates.find(t => t.id === req.query.from);
  const to = lib.cardTemplates.find(t => t.id === req.query.to);
  if (!from || !to) return res.redirect('/?page=templates&error=Template+not+found');
  from.linkedId = to.id;
  to.linkedId = from.id;
  to.title = from.title;
  to.subtitle = from.subtitle;
  to.buttonText = from.buttonText;
  to.photos = from.photos;
  to.photo = from.photo;
  to.activePhotos = from.activePhotos;
  to.active = from.active;
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-unlink', (req, res) => {
  const lib = loadLibrary();
  const tmpl = lib.cardTemplates.find(t => t.id === req.query.id);
  if (tmpl && tmpl.linkedId) {
    const partner = lib.cardTemplates.find(t => t.id === tmpl.linkedId);
    if (partner) delete partner.linkedId;
    delete tmpl.linkedId;
    saveLibrary(lib);
  }
  res.redirect('/?page=templates&saved=1');
});

// ============================================
// MASTER REDIRECT ROUTES
// ============================================
app.post('/master-redirect-on', (req, res) => {
  const url = normalizeUrl((req.body.url || '').trim());
  if (!url) return res.redirect('/?page=templates&error=URL+required');
  const s = loadSettings();
  s.masterRedirect = { enabled: true, url };
  saveSettings(s);
  res.redirect('/?page=templates&saved=1');
});
app.post('/master-redirect-off', (req, res) => {
  const s = loadSettings();
  if (s.masterRedirect) s.masterRedirect.enabled = false;
  saveSettings(s);
  res.redirect('/?page=templates&saved=1');
});

// ============================================
// FAN MANAGEMENT
// ============================================
app.post('/import-fans', (req, res) => {
  const pid = req.query.page;
  const raw = req.body.fans || '';
  const psids = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  psids.forEach(psid => {
    if (!isFanSaved(pid, psid)) { saveFan(pid, psid); added++; }
  });
  res.redirect(`/?page=${pid}&lib_msg=Imported+${added}+new+fans+(${psids.length - added}+duplicates+skipped)`);
});
app.get('/export-fans', (req, res) => {
  const pid = req.query.page;
  const fans = loadFans(pid);
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="fans-${pid}.txt"`);
  res.send(fans.join('\n'));
});
app.get('/remove-fan', (req, res) => {
  removeFan(req.query.page, req.query.psid, 'manual');
  res.redirect(`/?page=${req.query.page}&saved=1`);
});
app.post('/clear-fans', (req, res) => {
  const pid = req.query.page;
  saveFansList(pid, []);
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// SCHEDULED SEND
// ============================================
app.post('/schedule-send', (req, res) => {
  const pid = req.query.page;
  const sendAt = req.body.sendAt;
  if (!sendAt) return res.redirect(`/?page=${pid}&error=Pick+a+date/time`);
  updatePage(pid, { scheduledSend: sendAt });
  res.redirect(`/?page=${pid}&schedule_saved=1`);
});
app.post('/cancel-schedule', (req, res) => {
  const pid = req.query.page;
  const page = getPage(pid);
  if (page) {
    const updates = { ...page };
    delete updates.scheduledSend;
    const pages = loadPages();
    const idx = pages.findIndex(p => p.pageId === pid);
    if (idx >= 0) { pages[idx] = updates; savePages(pages); }
  }
  res.redirect(`/?page=${pid}&saved=1`);
});

// ============================================
// BACKUP / RESTORE
// ============================================
app.get('/backup', (req, res) => {
  const pages = loadPages();
  const backup = {
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    library: loadLibrary(),
    pages: pages.map(p => ({
      ...p,
      fans: loadFans(p.pageId),
      stats: loadStats(p.pageId)
    }))
  };
  res.json(backup);
});

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
app.post('/restore-backup', upload.single('backupFile'), (req, res) => {
  try {
    if (!req.file) return res.redirect('/?error=No+file+uploaded');
    const backup = JSON.parse(req.file.buffer.toString('utf8'));
    if (backup.settings) saveSettings(backup.settings);
    if (backup.library) saveLibrary(backup.library);
    if (Array.isArray(backup.pages)) {
      backup.pages.forEach(p => {
        const { fans, stats, ...pageData } = p;
        const pages = loadPages();
        const idx = pages.findIndex(x => x.pageId === pageData.pageId);
        if (idx >= 0) pages[idx] = { ...pages[idx], ...pageData };
        else pages.push(pageData);
        savePages(pages);
        if (Array.isArray(fans)) saveFansList(pageData.pageId, fans);
        if (stats) saveStats(pageData.pageId, stats);
      });
    }
    res.redirect('/?saved=1&lib_msg=Backup+restored');
  } catch (e) {
    res.redirect('/?error=Invalid+backup+file:+' + encodeURIComponent(e.message));
  }
});

// ============================================
// BROADCAST PROGRESS API
// ============================================
app.get('/broadcast-progress', (req, res) => {
  res.json(broadcastProgress);
});

// ============================================
// DAILY CRON
// ============================================
function runDailyBroadcasts() {
  const pages = loadPages();
  const now = new Date();
  pages.forEach(page => {
    if (!page.broadcastEnabled) return;
    const time = page.broadcastTime || '07:30';
    const [h, m] = time.split(':').map(Number);
    const tz = page.timezone || 'UTC';
    let pageNow;
    try {
      pageNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    } catch { pageNow = now; }

    if (pageNow.getHours() === h && pageNow.getMinutes() === m) {
      console.log(`[CRON] Broadcasting to ${page.label} (${page.pageId})`);
      const updated = randomizePage(page);
      broadcastToPage(updated || page);
    }
  });
}
cron.schedule('* * * * *', runDailyBroadcasts);

// ── Scheduled sends check ──
cron.schedule('* * * * *', () => {
  const pages = loadPages();
  const now = new Date();
  pages.forEach(page => {
    if (!page.scheduledSend) return;
    const scheduled = new Date(page.scheduledSend);
    if (now >= scheduled) {
      console.log(`[SCHEDULED] Firing for ${page.label} (${page.pageId})`);
      const updated = randomizePage(page);
      broadcastToPage(updated || page);
      const p = getPage(page.pageId);
      if (p) {
        const u = { ...p };
        delete u.scheduledSend;
        const allPages = loadPages();
        const idx = allPages.findIndex(x => x.pageId === page.pageId);
        if (idx >= 0) { allPages[idx] = u; savePages(allPages); }
      }
    }
  });
});

// ============================================
// STARTUP
// ============================================
app.listen(PORT, () => {
  console.log(`🤖 messagebot running on port ${PORT}`);
  if (PUBLIC_URL) console.log(`🌐 Webhook URL: ${PUBLIC_URL}/webhook`);

  const pages = loadPages();
  console.log(`📄 ${pages.length} page(s) loaded`);
  pages.forEach(p => {
    const fans = loadFans(p.pageId);
    console.log(`  · ${p.label} (${p.pageId}) — ${fans.length} fans — auto:${p.broadcastEnabled ? 'ON' : 'OFF'} at ${p.broadcastTime || '07:30'} ${p.timezone || 'UTC'}`);
  });

  // Setup Messenger for all pages on boot
  setTimeout(() => {
    pages.forEach(p => setupMessenger(p));
  }, 3000);
});
