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
// Returns sorted unique group names — from settings (registered groups) + any pages already assigned
function getAllGroups(pages) {
  pages = pages || loadPages();
  const s = loadSettings();
  const saved = Array.isArray(s.groups) ? s.groups : [];
  const fromPages = pages.map(p => (p.group || '').trim()).filter(Boolean);
  const all = [...new Set([...saved, ...fromPages])];
  return all.sort();
}

// Save a group name into settings so it persists even before pages are assigned
function saveGroupName(name) {
  name = (name || '').trim();
  if (!name) return;
  const s = loadSettings();
  s.groups = Array.isArray(s.groups) ? s.groups : [];
  if (!s.groups.includes(name)) { s.groups.push(name); s.groups.sort(); saveSettings(s); }
}

// Remove a group name from settings
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
      cardTemplates: []
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
  const normalized = { photos, redirectSets, cardTemplates };
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
  const pics = (Array.isArray(t.photos) && t.photos.length) ? t.photos : (t.photo ? [t.photo] : []);
  if (!pics.length) return '';
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
  startBroadcastTracking(page.pageId, fans.length, 'card');
  fans.forEach((psid, i) => {
    setTimeout(async () => {
      try { await sendCard(page, psid, opts); } catch {}
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
  .container { max-width: 1200px; margin: 24px auto; padding: 0 16px; }
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
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${esc(title)}</title><style>${CSS}</style></head><body>`;
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

  const groupOpts = ['', ...groups].map(g =>
    `<option value="${esc(g)}">${g || '\u2014 unassigned \u2014'}</option>`
  ).join('');

  const rows = pages.map(p => {
    return `<tr class="grp-row" data-label="${esc((p.label||'').toLowerCase())}">
      <td style="width:32px;text-align:center;">
        <input type="checkbox" class="grp-chk" value="${esc(p.pageId)}" style="width:16px;height:16px;cursor:pointer;accent-color:#6d28d9;"/>
      </td>
      <td><strong>${esc(p.label)}</strong><br/><span style="font-size:11px;color:#6b7280;">${esc(p.pageId)}</span></td>
      <td><span class="group-badge ${p.group ? '' : 'unassigned'}" id="gbadge-${esc(p.pageId)}">${esc(p.group || 'unassigned')}</span></td>
    </tr>`;
  }).join('');

  return `
    <div class="card" style="border:2px solid #c4b5fd;">
      <h2>\ud83d\udce6 Page Groups <span style="font-size:12px;font-weight:400;color:#7c3aed;">\u2014 send to Part 1, Part 2, Part 3 separately or all at once</span></h2>
      <p style="color:#6b7280;font-size:13px;">Assign pages to groups so you can Send Now to one group at a time. Create a group first, then tick pages and assign them in one click \u2014 no redirects.</p>

      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        ${pills || '<span style="color:#94a3b8;font-size:13px;">No groups yet \u2014 create one below.</span>'}
        ${unassigned.length ? `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;">
          <div style="font-size:13px;color:#94a3b8;">\u2b1c Unassigned: <strong>${unassigned.length} pages</strong></div>
        </div>` : ''}
      </div>

      <form action="/group-create" method="POST" style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">
        <input type="text" name="group" autocomplete="off" placeholder='New group name, e.g. "Part 1"' style="flex:1;min-width:200px;max-width:320px;padding:8px 12px;border:1px solid #c4b5fd;border-radius:6px;font-size:14px;"/>
        <button type="submit" class="btn" style="background:#6d28d9;color:#fff;margin-top:0;">\u2795 Create Group</button>
      </form>

      <details id="grp-assign-details">
        <summary style="cursor:pointer;font-weight:600;color:#6d28d9;padding:6px 0;">\u25b6 Assign pages to groups (${pages.length} pages)</summary>
        <div style="margin-top:10px;">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;background:#f5f3ff;border:1px solid #c4b5fd;border-radius:8px;margin-bottom:10px;">
            <button type="button" onclick="grpSelectAll(true)" class="qbtn" style="background:#6d28d9;">\u2611 Select All</button>
            <button type="button" onclick="grpSelectAll(false)" class="qbtn" style="background:#94a3b8;">\u2610 Clear</button>
            <input type="text" id="grp-filter" autocomplete="off" placeholder="\ud83d\udd0e Filter pages\u2026" oninput="grpFilter(this.value)" style="padding:5px 10px;border:1px solid #c4b5fd;border-radius:6px;font-size:13px;width:180px;"/>
            <span style="color:#cbd5e1;font-size:18px;">|</span>
            <select id="grp-target" style="padding:6px 10px;border:1px solid #6d28d9;border-radius:6px;font-size:13px;color:#6d28d9;font-weight:600;background:#fff;">
              ${groupOpts}
            </select>
            <button type="button" onclick="grpAssignSelected()" class="qbtn" style="background:#6d28d9;padding:6px 14px;font-size:13px;">\u2713 Assign Selected</button>
            <span id="grp-sel-count" style="font-size:12px;color:#7c3aed;font-weight:600;"></span>
            <span id="grp-status" style="font-size:12px;font-weight:600;"></span>
          </div>
          <table>
            <thead><tr><th style="width:32px;"></th><th>Page</th><th>Current Group</th></tr></thead>
            <tbody id="grp-tbody">${rows}</tbody>
          </table>
        </div>
      </details>
    </div>
    <script>
      function grpFilter(q) {
        q = (q || '').toLowerCase();
        document.querySelectorAll('.grp-row').forEach(function(r) {
          r.style.display = r.getAttribute('data-label').indexOf(q) !== -1 ? '' : 'none';
        });
      }
      function grpSelectAll(on) {
        document.querySelectorAll('.grp-chk').forEach(function(c) {
          if (c.closest('tr').style.display !== 'none') c.checked = on;
        });
        grpUpdateCount();
      }
      function grpUpdateCount() {
        var n = document.querySelectorAll('.grp-chk:checked').length;
        var el = document.getElementById('grp-sel-count');
        if (el) el.textContent = n ? n + ' selected' : '';
      }
      function grpAssignSelected() {
        var checked = document.querySelectorAll('.grp-chk:checked');
        var ids = []; for (var i = 0; i < checked.length; i++) ids.push(checked[i].value);
        if (!ids.length) { alert('Tick at least one page first.'); return; }
        var group = document.getElementById('grp-target').value;
        var label = group || 'unassigned';
        if (!confirm('Assign ' + ids.length + ' page(s) to "' + label + '"?')) return;
        var status = document.getElementById('grp-status');
        status.style.color = '#6b7280'; status.textContent = 'Saving\u2026';
        fetch('/group-assign-bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageIds: ids, group: group })
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d && d.ok) {
            status.style.color = '#16a34a';
            status.textContent = '\u2713 ' + d.updated + ' pages \u2192 "' + label + '"';
            ids.forEach(function(pid) {
              var badge = document.getElementById('gbadge-' + pid);
              if (badge) {
                badge.textContent = group || 'unassigned';
                badge.className = 'group-badge' + (group ? '' : ' unassigned');
              }
              var chk = document.querySelector('.grp-chk[value="' + pid + '"]');
              if (chk) chk.checked = false;
            });
            grpUpdateCount();
            setTimeout(function() { status.textContent = ''; }, 3000);
          } else {
            status.style.color = '#dc2626';
            status.textContent = '\u2717 ' + ((d && d.error) || 'failed');
          }
        })
        .catch(function(e) { status.style.color = '#dc2626'; status.textContent = '\u2717 ' + e.message; });
      }
      document.addEventListener('change', function(e) {
        if (e.target && e.target.classList.contains('grp-chk')) grpUpdateCount();
      });
    </script>`;
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

  return `
    <div class="card" style="border:2px solid #ede9fe;">
      <h2>🗂️ Shared Library</h2>
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
            <button class="qbtn tmpl-edit-btn" data-id="${t.id}" style="background:#6366f1;flex:1;">✏️ Edit</button>
            <button class="qbtn tmpl-dup-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#0ea5e9;" title="Duplicate + link to ${esc(otherSet)}">⧉🔗</button>
            ${!isLinked ? `<button class="qbtn tmpl-link-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#16a34a;" title="Link to existing ${esc(otherSet)} card">🔗</button>` : ''}
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
      var formPhotos = [];
      function escAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }
      function imgFail(el){ el.style.display='none'; var p=el.parentElement; p.style.color='#94a3b8'; p.style.fontSize='10px'; p.textContent='no img'; }
      function uploadImageFile(file) {
        if (!file || !file.type || file.type.indexOf('image/') !== 0) { alert('Please drop an image file.'); return; }
        var dz = document.getElementById('f-dropzone');
        var orig = '📂 Drag & drop a photo here (or click) to upload to Imgur';
        dz.textContent = '⏳ Uploading to Imgur...';
        var reader = new FileReader();
        reader.onload = function() {
          fetch('/upload-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: reader.result }) })
            .then(function(r){ return r.json(); })
            .then(function(d){
              if (d && d.url) { formPhotos.push(d.url); renderPhotoGrid(); dz.textContent = '✅ Added! Drop another, or click.'; setTimeout(function(){ dz.textContent = orig; }, 1800); }
              else { dz.textContent = orig; alert('Upload failed: ' + ((d && d.error) || 'unknown error')); }
            })
            .catch(function(e){ dz.textContent = orig; alert('Upload error: ' + e.message); });
        };
        reader.readAsDataURL(file);
      }
      function setupDropzone() {
        var dz = document.getElementById('f-dropzone');
        if (!dz) return;
        var fi = document.createElement('input');
        fi.type = 'file'; fi.accept = 'image/*'; fi.style.display = 'none';
        document.body.appendChild(fi);
        dz.addEventListener('click', function(){ fi.click(); });
        fi.addEventListener('change', function(){ if (fi.files[0]) { uploadImageFile(fi.files[0]); fi.value = ''; } });
        dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.style.background = '#eef2ff'; });
        dz.addEventListener('dragleave', function(e){ e.preventDefault(); dz.style.background = 'transparent'; });
        dz.addEventListener('drop', function(e){ e.preventDefault(); dz.style.background = 'transparent'; if (e.dataTransfer.files[0]) uploadImageFile(e.dataTransfer.files[0]); });
      }
      function renderPhotoGrid() {
        document.getElementById('f-photos').value = JSON.stringify(formPhotos);
        var grid = document.getElementById('f-photo-grid');
        grid.innerHTML = formPhotos.map(function(u, i){
          var uid = 'pgurl_' + i;
          return '<div style="border:2px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.06);">'
            + '<div style="position:relative;aspect-ratio:1/1;background:#f1f5f9;">'
            + '<img src="'+escAttr(u)+'" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="imgFail(this)"/>'
            + '<button type="button" class="pg-remove-btn" data-idx="'+i+'" style="position:absolute;top:7px;right:7px;background:#dc2626;color:#fff;border:none;border-radius:50%;width:28px;height:28px;font-size:16px;line-height:1;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.3);">\u00d7</button>'
            + '<div style="position:absolute;bottom:7px;left:7px;background:rgba(0,0,0,0.55);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;">Photo '+(i+1)+'</div>'
            + '</div>'
            + '<div style="padding:8px;background:#f8fafc;border-top:1px solid #e2e8f0;">'
            + '<input id="'+uid+'" type="text" value="'+escAttr(u)+'" readonly style="width:100%;font-size:10px;font-family:monospace;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;background:#fff;color:#1e40af;cursor:pointer;" title="Click to select full URL" onclick="this.select();"/>'
            + '<button type="button" class="pg-copy-btn" data-uid="'+uid+'" style="width:100%;margin-top:5px;background:#6b7280;color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;padding:5px;cursor:pointer;">📋 Copy URL</button>'
            + '</div>'
            + '</div>';
        }).join('') || '<span style="color:#94a3b8;font-size:12px;">No photos added yet.</span>';
      }
      function addPhotoToForm() { var inp = document.getElementById('f-photo-add'); var v = (inp.value || '').trim(); if (!v) return; formPhotos.push(v); inp.value = ''; renderPhotoGrid(); }
      function removePhotoFromForm(i) { formPhotos.splice(i, 1); renderPhotoGrid(); }
      function validateTmplForm() { if (!formPhotos.length) { alert('Add at least one photo.'); return false; } return true; }
      function dupTmpl(id, toSet) {
        var t = getTmpl(id); if (!t) return;
        var url = prompt('Enter the ' + toSet + ' gallery URL for the duplicate. The two cards will be LINKED — editing one syncs photos/title/subtitle/button to the other.', '');
        if (url === null) return; url = (url || '').trim();
        if (!url) { alert('A URL is required.'); return; }
        window.location.href = '/template-duplicate?id=' + encodeURIComponent(id) + '&to=' + encodeURIComponent(toSet) + '&url=' + encodeURIComponent(url);
      }
      function updateSelCount() { var n = document.querySelectorAll('.tmpl-sel:checked').length; var el = document.getElementById('sel-count'); if (el) el.textContent = n ? (n + ' selected') : ''; }
      function selectAllTmpls(on) { var b = document.querySelectorAll('.tmpl-sel'); for (var i = 0; i < b.length; i++) b[i].checked = on; updateSelCount(); }
      function bulkSetActive(makeActive) {
        var sel = document.querySelectorAll('.tmpl-sel:checked'); var ids = []; for (var i = 0; i < sel.length; i++) ids.push(sel[i].value);
        if (!ids.length) { alert('Tick the cards you want first.'); return; }
        fetch('/templates-bulk-active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, active: makeActive }) })
          .then(function(r){ return r.json(); }).then(function(){ location.href = '/?page=templates'; }).catch(function(e){ alert('Error: ' + e.message); });
      }
      function fillFromRow() {
        var raw = document.getElementById('f-rawrow').value || '';
        if (!raw.trim()) { alert('Paste a row first.'); return; }
        var TAB = String.fromCharCode(9), NL = String.fromCharCode(10), CR = String.fromCharCode(13);

        // Split by tabs AND newlines — handles long rows that wrap
        var cells = raw.replace(new RegExp(CR,'g'),'').split(new RegExp('['+TAB+NL+']'))
          .map(function(c){ return c.trim(); })
          .filter(function(c){ return c.length > 0; });

        var imgurById = {};  // id -> full url  (dedup by image ID not full string)
        var imgurOrder = []; // to preserve order
        var scrollUrl = '', viralUrl = '';
        var textCells = [];

        cells.forEach(function(v) {
          if (!v) return;
          if (v.indexOf('http') === 0) {
            if (v.indexOf('imgur.com') !== -1) {
              // Extract imgur image ID (e.g. "LFAlEEp" from "https://i.imgur.com/LFAlEEp.jpeg")
              var m = (new RegExp('imgur\\.com\\/([A-Za-z0-9]+)(?:\\.[a-zA-Z]+)?')).exec(v);
              if (m) {
                var imgId = m[1];
                if (!imgurById[imgId]) {
                  // Use original URL but ensure it has an extension
                  var url = v.split('?')[0].split('#')[0]; // strip query/hash
                  if (!(new RegExp('\\.(jpg|jpeg|png|gif|webp)$','i')).test(url)) url = url + '.jpeg';
                  imgurById[imgId] = url;
                  imgurOrder.push(imgId);
                }
              }
            }
            else if (v.indexOf('theviralbox') !== -1) { if (!viralUrl) viralUrl = v; }
            else if (v.indexOf('scrollgallery') !== -1) { if (!scrollUrl) scrollUrl = v; }
          } else {
            textCells.push(v);
          }
        });

        var imgurUrls = imgurOrder.map(function(id){ return imgurById[id]; });

        // Fill text fields
        if (textCells[0]) document.getElementById('f-title').value = textCells[0];
        if (textCells[1]) document.getElementById('f-subtitle').value = textCells[1];
        if (textCells.length >= 3) document.getElementById('f-button').value = textCells[textCells.length - 1];

        // Add all imgur photos
        imgurUrls.forEach(function(u) {
          if (!formPhotos.includes(u)) formPhotos.push(u);
        });
        if (imgurUrls.length > 0) renderPhotoGrid();

        // Fill per-set redirect fields (new multi-URL form)
        if (scrollUrl) {
          var sgField = document.getElementById('f-redirect-Scrollgallery');
          if (sgField) sgField.value = scrollUrl;
        }
        if (viralUrl) {
          var tvField = document.getElementById('f-redirect-TheViralBox');
          if (tvField) tvField.value = viralUrl;
        }
        // Also fill any other fields if URL contains the set name (future websites)
        [scrollUrl, viralUrl].forEach(function(u) {
          if (!u) return;
          var allInputs = document.querySelectorAll('[id^="f-redirect-"]');
          for (var i = 0; i < allInputs.length; i++) {
            var setName = allInputs[i].id.replace('f-redirect-','').toLowerCase();
            if (u.toLowerCase().indexOf(setName) !== -1) allInputs[i].value = u;
          }
        });
        // Fallback: old single redirect field
        var redirect = scrollUrl || viralUrl;
        if (redirect && document.getElementById('f-redirect')) {
          document.getElementById('f-redirect').value = redirect;
        }

        // Show visible summary below button
        var summary = document.getElementById('f-row-summary');
        if (!summary) {
          summary = document.createElement('div');
          summary.id = 'f-row-summary';
          summary.style.cssText = 'margin-top:8px;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:600;';
          document.getElementById('f-rawrow').parentNode.appendChild(summary);
        }
        var parts = [];
        if (imgurUrls.length) parts.push('📸 ' + imgurUrls.length + ' photo(s) found: ' + imgurOrder.join(', '));
        if (redirect) parts.push('🔗 redirect: ' + redirect.replace('https://','').slice(0,40));
        if (textCells[0]) parts.push('📝 title: ' + textCells[0]);
        if (textCells.length >= 3) parts.push('🔘 button: ' + textCells[textCells.length-1]);
        summary.style.background = imgurUrls.length ? '#dcfce7' : '#fef9c3';
        summary.style.color = imgurUrls.length ? '#166534' : '#854d0e';
        summary.innerHTML = parts.length ? parts.join('<br/>') : '⚠️ Nothing recognized — check format';
      }
      function editTmpl(id) {
        var t = getTmpl(id); if (!t) return;
        document.getElementById('f-id').value = t.id;
        document.getElementById('f-title').value = t.title || '';
        document.getElementById('f-subtitle').value = t.subtitle || '';
        formPhotos = (Array.isArray(t.photos) && t.photos.length) ? t.photos.slice() : (t.photo ? [t.photo] : []);
        renderPhotoGrid();
        document.getElementById('f-button').value = t.buttonText || '';
        document.getElementById('tmpl-form').action = '/template-edit';
        document.getElementById('form-title').textContent = '✏️ Edit Template';
        document.getElementById('f-submit').textContent = '💾 Save Changes';
        document.getElementById('f-cancel').style.display = 'inline-block';

        // Fill per-set redirect fields
        // First clear all per-set fields
        var allRedirectFields = document.querySelectorAll('[id^="f-redirect-"]');
        for (var i = 0; i < allRedirectFields.length; i++) allRedirectFields[i].value = '';
        // Fill this card's own set
        var ownField = document.getElementById('f-redirect-' + (t.set || 'Scrollgallery'));
        if (ownField) ownField.value = t.redirect || '';
        // Fill linked group members' redirect fields
        var allTmpls = window.__tmplData || {};
        Object.keys(allTmpls).forEach(function(tid) {
          var other = allTmpls[tid];
          if (tid === t.id) return;
          var isLinked = (t.linkGroup && other.linkGroup === t.linkGroup) || other.id === t.linkedId || t.linkedId === other.id;
          if (isLinked) {
            var field = document.getElementById('f-redirect-' + (other.set || ''));
            if (field) field.value = other.redirect || '';
          }
        });
        // Also set hidden single redirect for fallback
        var hiddenRedirect = document.getElementById('f-redirect');
        if (hiddenRedirect) hiddenRedirect.value = t.redirect || '';

        // Update linked block for legacy pairs
        var lb = document.getElementById('f-linked-block');
        var lrid = document.getElementById('f-linked-id');
        var lrurl = document.getElementById('f-linked-redirect');
        if (lb) lb.style.display = 'none';
        if (lrid) lrid.value = t.linkedId || '';
        if (lrurl) lrurl.value = '';

        // Update submit button label based on how many linked cards exist
        var linkedCount = 0;
        Object.keys(allTmpls).forEach(function(tid) {
          if (tid === t.id) return;
          var other = allTmpls[tid];
          if ((t.linkGroup && other.linkGroup === t.linkGroup) || other.id === t.linkedId) linkedCount++;
        });
        if (linkedCount > 0) document.getElementById('f-submit').textContent = '💾 Save + Sync to ' + linkedCount + ' linked card(s)';

        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      function resetForm() {
        document.getElementById('tmpl-form').reset();
        document.getElementById('f-id').value = '';
        document.getElementById('tmpl-form').action = '/template-add';
        document.getElementById('form-title').textContent = '➕ Add New Template';
        document.getElementById('f-submit').textContent = '➕ Add Template';
        document.getElementById('f-cancel').style.display = 'none';
        document.getElementById('f-linked-block').style.display = 'none';
        document.getElementById('f-linked-id').value = '';
        document.getElementById('f-redirect-label').textContent = '';
        formPhotos = []; renderPhotoGrid();
      }
      (function(){
        var nid = new URLSearchParams(location.search).get('new');
        if (!nid) return;
        var el = document.getElementById('tmpl-' + nid);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'box-shadow 0.3s'; el.style.boxShadow = '0 0 0 3px #6366f1';
        setTimeout(function(){ el.style.boxShadow = 'none'; }, 2600);
      })();
      renderPhotoGrid(); setupDropzone();
      // Save scroll position before any navigation, restore on reload
      (function() {
        var key = 'tmpl_scroll';
        var saved = sessionStorage.getItem(key);
        if (saved) { sessionStorage.removeItem(key); setTimeout(function(){ window.scrollTo(0, parseInt(saved)); }, 80); }
        window.addEventListener('beforeunload', function() {
          if (location.search.indexOf('page=templates') !== -1) sessionStorage.setItem(key, window.scrollY);
        });
      })();
      document.addEventListener('change', function(e){ if (e.target && e.target.classList && e.target.classList.contains('tmpl-sel')) updateSelCount(); });
      // Button click delegation — avoids ALL quoting issues with onclick attributes
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('.tmpl-edit-btn, .tmpl-dup-btn, .tmpl-link-btn, .pg-copy-btn, .pg-remove-btn, .link-pick-btn, .link-modal-close');
        if (!btn) return;
        if (btn.classList.contains('tmpl-edit-btn')) { editTmpl(btn.getAttribute('data-id')); }
        else if (btn.classList.contains('tmpl-dup-btn')) { dupTmpl(btn.getAttribute('data-id'), btn.getAttribute('data-otherset')); }
        else if (btn.classList.contains('tmpl-link-btn')) { showLinkPicker(btn.getAttribute('data-id'), btn.getAttribute('data-otherset')); }
        else if (btn.classList.contains('pg-copy-btn')) {
          var el = document.getElementById(btn.getAttribute('data-uid'));
          if (el) { el.select(); document.execCommand('copy'); btn.textContent = '✓ Copied!'; btn.style.background = '#16a34a'; setTimeout(function(){ btn.textContent = '📋 Copy URL'; btn.style.background = '#6b7280'; }, 1400); }
        }
        else if (btn.classList.contains('pg-remove-btn')) { removePhotoFromForm(parseInt(btn.getAttribute('data-idx'))); }
        else if (btn.classList.contains('link-pick-btn')) {
          var srcId = btn.getAttribute('data-src');
          var partnerId = btn.getAttribute('data-partner');
          closeLinkPicker();
          doLink(srcId, partnerId);
        }
        else if (btn.classList.contains('link-modal-close')) { closeLinkPicker(); }
      });
      // Close modal if clicking backdrop
      document.addEventListener('click', function(e) {
        var modal = document.getElementById('link-picker-modal');
        if (modal && e.target === modal) closeLinkPicker();
      });
      function closeLinkPicker() {
        var m = document.getElementById('link-picker-modal');
        if (m) m.remove();
      }
      function showLinkPicker(srcId, otherSet) {
        // Force-load template data if not yet initialized (getTmpl is lazy)
        getTmpl(srcId);
        var allTemplates = window.__tmplData || {};
        // Get src card info
        var src = allTemplates[srcId];
        if (!src) return;
        // Get all cards from the other set that are not already linked
        var candidates = Object.values(allTemplates).filter(function(t) {
          return t.set === otherSet && !t.linkedId;
        });
        var cards = candidates.map(function(t) {
          return '<div style="display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;background:#fff;" class="link-pick-row">'
            + '<img src="' + (t.photo||'') + '" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="imgFail(this)"/>'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-weight:700;font-size:13px;color:#1a1d2e;">' + (t.title||'(no title)') + '</div>'
            + '<div style="font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (t.subtitle||'') + '</div>'
            + '<div style="font-size:10px;color:#94a3b8;font-family:monospace;margin-top:2px;">' + (t.redirect||'').replace('https://','') + '</div>'
            + '</div>'
            + '<button class="link-pick-btn qbtn" data-src="' + srcId + '" data-partner="' + t.id + '" style="background:#6d28d9;white-space:nowrap;">🔗 Link</button>'
            + '</div>';
        }).join('');
        var html = '<div id="link-picker-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;">'
          + '<div style="background:#fff;border-radius:12px;width:100%;max-width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.3);">'
          + '<div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;">'
          + '<div>'
          + '<div style="font-weight:700;font-size:16px;color:#1a1d2e;">🔗 Link to ' + otherSet + ' card</div>'
          + '<div style="font-size:12px;color:#6b7280;margin-top:2px;">Linking: <strong>' + (src.title||srcId) + '</strong> → pick a ' + otherSet + ' card below</div>'
          + '</div>'
          + '<button class="link-modal-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:#94a3b8;padding:0;line-height:1;">×</button>'
          + '</div>'
          + '<div style="overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px;">'
          + (candidates.length ? cards : '<div style="text-align:center;padding:32px;color:#94a3b8;">No unlinked ' + otherSet + ' cards available.<br/>Duplicate first, or create a new ' + otherSet + ' card.</div>')
          + '</div>'
          + '</div>'
          + '</div>';
        document.body.insertAdjacentHTML('beforeend', html);
      }
      function doLink(srcId, partnerId) {
        fetch('/template-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: srcId, partnerId: partnerId }) })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d && d.ok) { location.href = '/?page=templates&lib_msg=Cards+linked+successfully'; }
            else { alert('Link failed: ' + ((d && d.error) || 'unknown')); }
          })
          .catch(function(e){ alert('Error: ' + e.message); });
      }
      // All template data in ONE safe block — avoids inline script tags per card breaking on special chars
      // getTmpl is lazy: reads the JSON element on first call (it's parsed by then since script runs after DOM)
      function getTmpl(id){
        if (!window.__tmplData) {
          var el = document.getElementById('tmpl-data-json');
          window.__tmplData = el ? JSON.parse(el.textContent) : {};
        }
        return window.__tmplData[id] || null;
      }
    </script>
    <script type="application/json" id="tmpl-data-json">${JSON.stringify(
      Object.fromEntries((lib.cardTemplates || []).map(t => [t.id, t]))
    ).replace(/<\/script>/gi, '<\\/script>')}</script>
  </div>`;
}

function renderAllPagesView(pages, req) {
  const todayStr = new Date().toISOString().split('T')[0];
  const globalMode = getGlobalContentMode();
  let agg = { fans: 0, clicks: 0, clicksToday: 0, sent: 0, failed: 0, delivered: 0, readers: 0 };
  const rows = pages.map(p => {
    const fans = loadFans(p.pageId);
    const stats = loadStats(p.pageId);
    const clicks = (stats.clicks || []).length;
    const clicksToday = (stats.clicks || []).filter(c => c.time.startsWith(todayStr)).length;
    const sent = stats.messagesSent || 0;
    const failed = stats.messagesFailed || 0;
    const delivered = (stats.delivered || []).length;
    const readers = (stats.readers || []).length;
    agg.fans += fans.length;
    agg.clicks += clicks;
    agg.clicksToday += clicksToday;
    agg.sent += sent;
    agg.failed += failed;
    agg.delivered += delivered;
    agg.readers += readers;
    const status = p.broadcastEnabled
      ? `<span class="badge badge-green">Active</span>`
      : `<span class="badge badge-gray">Paused</span>`;
    const sendNowOn = p.sendNowEnabled !== false;
    const sendNowBadge = sendNowOn
      ? `<span class="badge badge-green" style="font-size:9px;">SendNow ON</span>`
      : `<span class="badge badge-gray" style="font-size:9px;">SendNow OFF</span>`;
    const groupBadge = p.group
      ? `<span class="group-badge">${esc(p.group)}</span>`
      : `<span class="group-badge unassigned">—</span>`;
    const pauseBtn = p.broadcastEnabled
      ? `<form action="/toggle-page" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-pause">⏸️ Pause</button></form>`
      : `<form action="/toggle-page" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-resume">▶️ Resume</button></form>`;
    const sendNowToggle = sendNowOn
      ? `<form action="/toggle-sendnow" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn" style="background:#f59e0b;">🚫 Pause SN</button></form>`
      : `<form action="/toggle-sendnow" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-resume">✅ Resume SN</button></form>`;
    return `<tr class="page-row" draggable="true" data-id="${esc(p.pageId)}">
      <td style="width:28px;text-align:center;cursor:grab;color:#cbd5e1;font-size:18px;padding:10px 4px;" class="drag-handle" title="Drag to reorder">⠿</td>
      <td><strong>${esc(p.label)}</strong><br/><span style="font-size:11px;color:#6b7280;">${esc(p.pageId)}</span><br/>${groupBadge}</td>
      <td>${fans.length}</td>
      <td>${clicksToday} / ${clicks}</td>
      <td style="white-space:nowrap;font-size:13px;">${sent} ✅ · ${failed} ❌</td>
      <td>${status}<br/>${sendNowBadge}</td>
      <td><span class="bp-cell" data-bp="${esc(p.pageId)}" style="font-size:12px;color:#94a3b8;">—</span></td>
      <td>
        <div class="actions">
          ${pauseBtn}
          ${sendNowToggle}
          <a href="/send-now?page=${esc(p.pageId)}" class="qbtn qbtn-send" onclick="return confirm('Send to ${fans.length} fans on ${esc(p.label)} now?')">🚀 Send</a>
          <a href="/?page=${esc(p.pageId)}" class="qbtn qbtn-open">⚙️ Open</a>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}

    <div class="card">
      <h2>🌍 All Pages — Aggregate Stats</h2>
      <div class="grid">
        <div class="stat"><div class="v">${pages.length}</div><div class="l">Pages</div></div>
        <div class="stat"><div class="v">${agg.fans}</div><div class="l">Total Fans</div></div>
        <div class="stat"><div class="v">${agg.clicksToday}</div><div class="l">Clicks Today</div></div>
        <div class="stat"><div class="v">${agg.clicks}</div><div class="l">Total Clicks</div></div>
        <div class="stat"><div class="v">${agg.sent}</div><div class="l">Sent</div></div>
        <div class="stat"><div class="v">${agg.failed}</div><div class="l">Failed</div></div>
        <div class="stat"><div class="v">${agg.delivered}</div><div class="l">Delivered</div></div>
        <div class="stat"><div class="v">${agg.readers}</div><div class="l">Seen By</div></div>
      </div>
    </div>

    ${renderGroupManager(pages)}

    <div class="card">
      <h2>📋 Pages</h2>
      ${pages.length === 0
        ? '<p style="color:#6b7280;">No pages yet. Add one below.</p>'
        : `
          ${renderGroupSendNow(pages)}

          <div style="margin-bottom:12px;padding:10px;background:#f7f8fc;border-radius:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:600;color:#4a5568;">Other bulk actions:</span>
            <form action="/pause-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn qbtn-pause" onclick="return confirm('Pause daily auto-broadcast for ALL pages?')">⏸️ Pause All</button>
            </form>
            <form action="/resume-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn qbtn-resume" onclick="return confirm('Resume daily auto-broadcast for ALL pages?')">▶️ Resume All</button>
            </form>
            <form action="/disable-cleanup-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#3a8dde;" onclick="return confirm('Disable auto-cleanup on ALL pages?')">🛡️ Disable Cleanup (All)</button>
            </form>
            <form action="/enable-cleanup-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#28a745;" onclick="return confirm('Enable auto-cleanup (threshold=1) on ALL pages?')">🧹 Enable Cleanup (All)</button>
            </form>
            <form action="/randomize-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#8b5cf6;" onclick="return confirm('Randomize ALL pages?')">🎲 Randomize ALL</button>
            </form>
            <form action="/reset-stats-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#dc2626;" onclick="return confirm('Reset ALL stats on all pages? Fan counts are kept.')">🗑️ Reset All Stats</button>
            </form>
            <a href="/backup" class="qbtn" style="background:#0f766e;text-decoration:none;">⬇️ Backup</a>
            <button type="button" class="qbtn" style="background:#7c3aed;" onclick="document.getElementById('restore-file').click()">♻️ Restore</button>
            <input type="file" id="restore-file" accept="application/json,.json" style="display:none;" onchange="restoreBackup(this)"/>
          </div>

          <div style="margin-bottom:12px;padding:12px;background:#faf5ff;border:2px solid #e9d5ff;border-radius:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:700;color:#6b21a8;">🎚️ Global Content Mode:</span>
            <form action="/set-global-mode" method="POST" style="margin:0;display:inline;">
              <input type="hidden" name="mode" value="classic"/>
              <button type="submit" class="qbtn" style="background:${globalMode === 'classic' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'classic' ? '#fff' : '#475569'};">${globalMode === 'classic' ? '✓ ' : ''}📷 Classic</button>
            </form>
            <form action="/set-global-mode" method="POST" style="margin:0;display:inline;">
              <input type="hidden" name="mode" value="templates"/>
              <button type="submit" class="qbtn" style="background:${globalMode === 'templates' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'templates' ? '#fff' : '#475569'};">${globalMode === 'templates' ? '✓ ' : ''}🎴 Templates</button>
            </form>
          </div>

          <table>
            <thead><tr><th style="width:28px;" title="Drag rows to reorder">⠿</th><th>Page / Group <span id="reorder-status" style="font-size:11px;font-weight:400;margin-left:8px;"></span></th><th>Fans</th><th>Clicks (today/total)</th><th>Messages</th><th>Status</th><th>Send Progress</th><th>Actions</th></tr></thead>
            <tbody id="pages-tbody">${rows}</tbody>
          </table>

          <div class="card" style="margin-top:0;">
            <h2>🔑 Page Keys &amp; 📥 Contacts</h2>
            <input type="text" id="creds-filter" placeholder="🔎 Filter pages by name…" oninput="filterCreds(this.value)" style="width:100%;margin-bottom:10px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;"/>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
              <button type="button" class="qbtn" style="background:#2563eb;" onclick="importSelected()">📥 Import selected</button>
              <button type="button" class="qbtn" style="background:#1d4ed8;" onclick="importAllPagesContacts()">📥 Import ALL pages</button>
              <span style="width:1px;height:18px;background:#cbd5e1;display:inline-block;"></span>
              <button type="button" class="qbtn" style="background:#e2e8f0;color:#475569;" onclick="selectAllImp(true)">Select all</button>
              <button type="button" class="qbtn" style="background:#e2e8f0;color:#475569;" onclick="selectAllImp(false)">Clear</button>
              <span id="imp-progress" style="font-size:12px;color:#6b7280;font-weight:600;"></span>
            </div>
            <div style="max-height:420px;overflow:auto;border:1px solid #f1f5f9;border-radius:8px;">
              ${pages.map(p => `
              <div class="cred-row" data-pageid="${esc(p.pageId)}" data-label="${esc((p.label||'').toLowerCase())}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid #f1f5f9;">
                <input type="checkbox" class="imp-sel" value="${esc(p.pageId)}" title="Select for bulk import" style="width:auto;"/>
                <input type="text" value="${esc(p.label||'')}" data-f="label" title="Page name" style="flex:1;min-width:140px;font-size:13px;padding:6px;border:1px solid #cbd5e1;border-radius:5px;"/>
                <input type="text" value="${esc(p.pageId)}" data-f="pageId" title="Page ID" style="width:150px;font-family:monospace;font-size:11px;padding:6px;border:1px solid #cbd5e1;border-radius:5px;"/>
                <input type="text" placeholder="paste new token · blank = keep" data-f="token" title="Access token" style="flex:2;min-width:160px;font-family:monospace;font-size:11px;padding:6px;border:1px solid #cbd5e1;border-radius:5px;"/>
                <span class="tok-hint" style="font-size:10px;font-family:monospace;min-width:86px;color:${p.accessToken ? '#16a34a' : '#dc2626'};">${p.accessToken ? '🔑 ' + esc(p.accessToken.slice(0,6)) + '…' + esc(p.accessToken.slice(-4)) : '⚠️ none'}</span>
                <button type="button" class="qbtn" style="background:#16a34a;" onclick="savePageCreds(this)">💾 Save</button>
                <button type="button" class="qbtn" style="background:#2563eb;" onclick="importOne(this)">📥 Import</button>
                <span class="cred-status" style="font-size:12px;font-weight:600;min-width:70px;"></span>
              </div>`).join('')}
            </div>
          </div>
          <script>
            function filterCreds(q){ q=(q||'').toLowerCase(); var rows=document.querySelectorAll('.cred-row'); for(var i=0;i<rows.length;i++){ var m=rows[i].getAttribute('data-label').indexOf(q)!==-1; rows[i].style.display=m?'':'none'; } }
            function savePageCreds(btn){
              var row=btn.closest('.cred-row'); var pageId=row.getAttribute('data-pageid');
              var label=row.querySelector('[data-f="label"]').value; var newPageId=row.querySelector('[data-f="pageId"]').value; var token=row.querySelector('[data-f="token"]').value;
              var status=row.querySelector('.cred-status'); status.style.color='#6b7280'; status.textContent='saving…';
              fetch('/page-update-inline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageId:pageId,label:label,newPageId:newPageId,token:token})})
                .then(function(r){return r.json();})
                .then(function(d){
                  if(d&&d.ok){ status.style.color='#16a34a'; status.textContent='✓ saved'; row.querySelector('[data-f="token"]').value=''; if(d.pageId){ row.setAttribute('data-pageid',d.pageId); } setTimeout(function(){status.textContent='';},2500); }
                  else { status.style.color='#dc2626'; status.textContent=(d&&d.error)||'failed'; }
                }).catch(function(e){ status.style.color='#dc2626'; status.textContent='error'; });
            }
            function selectAllImp(on){ var b=document.querySelectorAll('.imp-sel'); for(var i=0;i<b.length;i++){ if(b[i].closest('.cred-row').style.display!=='none') b[i].checked=on; } }
            function doImport(pageId,status){
              status.style.color='#6b7280'; status.textContent='importing…';
              return fetch('/import-contacts-json?page='+encodeURIComponent(pageId),{method:'POST'})
                .then(function(r){return r.json();})
                .then(function(d){ if(d&&d.ok){ status.style.color='#16a34a'; status.textContent='✓ +'+d.found+' ('+d.total+')'; } else { status.style.color='#dc2626'; status.textContent='✗ '+((d&&d.error)||'failed').slice(0,26); } })
                .catch(function(e){ status.style.color='#dc2626'; status.textContent='✗ error'; });
            }
            function importOne(btn){ var row=btn.closest('.cred-row'); return doImport(row.getAttribute('data-pageid'), row.querySelector('.cred-status')); }
            function importList(ids){
              var prog=document.getElementById('imp-progress'); var i=0, done=0;
              function next(){ if(i>=ids.length){ prog.textContent='Done — imported '+done+' of '+ids.length+' pages'; return; } var pageId=ids[i]; i++; prog.textContent='Importing '+i+' of '+ids.length+'…'; var row=document.querySelector('.cred-row[data-pageid="'+pageId+'"]'); var status=row?row.querySelector('.cred-status'):{style:{}}; doImport(pageId,status).then(function(){ done++; next(); }); }
              next();
            }
            function importSelected(){ var sel=document.querySelectorAll('.imp-sel:checked'); var ids=[]; for(var i=0;i<sel.length;i++) ids.push(sel[i].value); if(!ids.length){ alert('Tick the pages you want first.'); return; } if(!confirm('Import contacts for '+ids.length+' selected page(s)?')) return; importList(ids); }
            function importAllPagesContacts(){ var b=document.querySelectorAll('.imp-sel'); var ids=[]; for(var i=0;i<b.length;i++) ids.push(b[i].value); if(!ids.length) return; if(!confirm('Import contacts for ALL '+ids.length+' pages?')) return; importList(ids); }
            function restoreBackup(input){
              var file = input.files && input.files[0]; if(!file){ return; }
              if(!confirm('Restore from "'+file.name+'"? This OVERWRITES all current data. A safety copy is saved first.')){ input.value=''; return; }
              var reader = new FileReader(); reader.onload = function(){
                var prog = document.getElementById('imp-progress'); if(prog){ prog.style.color='#6b7280'; prog.textContent='Restoring backup…'; }
                fetch('/restore-backup',{method:'POST',headers:{'Content-Type':'application/json'},body:reader.result})
                  .then(function(r){return r.json();})
                  .then(function(d){ if(d&&d.ok){ alert('Restore complete — '+d.restored+' files restored. Page will reload.'); location.reload(); } else { alert('Restore failed: '+((d&&d.error)||'unknown error')); } })
                  .catch(function(e){ alert('Restore error: '+e.message); });
                input.value='';
              }; reader.readAsText(file);
            }
          </script>
        `
      }
    </div>

    <script>
      (function() {
        function pollAll() {
          var cells = document.querySelectorAll('.bp-cell');
          cells.forEach(function(cell) {
            var pid = cell.getAttribute('data-bp');
            fetch('/broadcast-status?page=' + encodeURIComponent(pid))
              .then(function(r){ return r.json(); })
              .then(function(d){
                if (!d.active) { cell.innerHTML = '<span style="color:#cbd5e1;">— idle</span>'; return; }
                if (d.status === 'complete') {
                  cell.innerHTML = '<span style="color:#16a34a;font-weight:600;">✅ Done</span><br/><span style="font-size:10px;color:#6b7280;">' + d.total + ' sent</span>';
                } else {
                  var pct = d.total > 0 ? Math.round(d.done / d.total * 100) : 100;
                  cell.innerHTML = '<span style="color:#6366f1;font-weight:600;">📡 ' + pct + '%</span><br/>'
                    + '<span style="font-size:10px;color:#6b7280;">' + d.done + '/' + d.total + '</span>'
                    + '<div style="background:#e2e8f0;border-radius:999px;height:5px;margin-top:3px;overflow:hidden;"><div style="background:#6366f1;height:100%;width:' + pct + '%;"></div></div>';
                }
              }).catch(function(){});
          });
        }
        pollAll(); setInterval(pollAll, 5000);
      })();
    </script>

    <script>
      // ── Drag & drop row reorder for pages table ──
      (function() {
        var tbody = document.getElementById('pages-tbody');
        if (!tbody) return;
        var dragging = null;

        tbody.addEventListener('dragstart', function(e) {
          var row = e.target.closest('tr.page-row');
          if (!row) return;
          dragging = row;
          row.style.opacity = '0.4';
          e.dataTransfer.effectAllowed = 'move';
        });

        tbody.addEventListener('dragend', function(e) {
          var row = e.target.closest('tr.page-row');
          if (row) row.style.opacity = '';
          document.querySelectorAll('tr.page-row').forEach(function(r) {
            r.style.borderTop = '';
          });
          dragging = null;
        });

        tbody.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          var row = e.target.closest('tr.page-row');
          if (!row || row === dragging) return;
          document.querySelectorAll('tr.page-row').forEach(function(r) { r.style.borderTop = ''; });
          var rect = row.getBoundingClientRect();
          var mid = rect.top + rect.height / 2;
          if (e.clientY < mid) {
            row.style.borderTop = '3px solid #6366f1';
          } else {
            var next = row.nextElementSibling;
            if (next) next.style.borderTop = '3px solid #6366f1';
            else row.style.borderBottom = '3px solid #6366f1';
          }
        });

        tbody.addEventListener('drop', function(e) {
          e.preventDefault();
          var row = e.target.closest('tr.page-row');
          if (!row || row === dragging) return;
          document.querySelectorAll('tr.page-row').forEach(function(r) {
            r.style.borderTop = ''; r.style.borderBottom = '';
          });
          var rect = row.getBoundingClientRect();
          var mid = rect.top + rect.height / 2;
          if (e.clientY < mid) {
            tbody.insertBefore(dragging, row);
          } else {
            tbody.insertBefore(dragging, row.nextSibling);
          }
          // Save new order
          var ids = [];
          tbody.querySelectorAll('tr.page-row').forEach(function(r) {
            ids.push(r.getAttribute('data-id'));
          });
          var indicator = document.getElementById('reorder-status');
          if (indicator) { indicator.style.color = '#6b7280'; indicator.textContent = 'Saving order…'; }
          fetch('/pages-reorder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: ids })
          })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (indicator) {
              indicator.style.color = d.ok ? '#16a34a' : '#dc2626';
              indicator.textContent = d.ok ? '✓ Order saved' : '✗ Save failed';
              setTimeout(function() { indicator.textContent = ''; }, 2000);
            }
          })
          .catch(function() {
            if (indicator) { indicator.style.color = '#dc2626'; indicator.textContent = '✗ Error'; }
          });
        });
      })();
    </script>

    ${renderLibraryManager()}

    <div class="card" style="border:2px solid #bbf7d0;">
      <h2>📋 Bulk Add Pages — Paste from Spreadsheet</h2>
      <p style="color:#6b7280;font-size:13px;">Paste one or more rows directly from your spreadsheet. Each row: <strong>Name [tab] Page ID [tab] Token</strong> — columns can be in any order, the system auto-detects which is which. One row per line.</p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#166534;">
        <strong>Example format (tab-separated):</strong><br/>
        <code style="font-size:11px;background:#dcfce7;padding:2px 6px;border-radius:4px;">Rebecca&nbsp;&nbsp;&nbsp;&nbsp;844231325433338&nbsp;&nbsp;&nbsp;&nbsp;EAAZABJsK508YBR...</code>
      </div>
      <textarea id="bulk-pages-input" placeholder="Paste your rows here (Name TAB PageID TAB Token)&#10;Rebecca	844231325433338	EAAZABJsK508...&#10;Sandra	109876543210123	EAAZABother..." style="width:100%;min-height:140px;font-family:monospace;font-size:12px;padding:10px;border:1px solid #86efac;border-radius:8px;resize:vertical;"></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;">
        <button type="button" class="btn btn-green" onclick="parseBulkPages()" style="margin-top:0;">🔍 Preview Pages</button>
        <button type="button" id="bulk-add-btn" class="btn" style="background:#16a34a;color:#fff;display:none;margin-top:0;" onclick="submitBulkPages()">➕ Add All Pages</button>
        <span id="bulk-status" style="font-size:13px;font-weight:600;"></span>
      </div>
      <div id="bulk-preview" style="margin-top:12px;"></div>
    </div>

    <script>
      var bulkParsed = [];
      function parseBulkPages() {
        var raw = document.getElementById('bulk-pages-input').value || '';
        var lines = raw.split('\n').map(function(l){ return l.replace(/\r/g,'').trim(); }).filter(function(l){ return l.length > 0; });
        bulkParsed = [];
        var errors = [];
        lines.forEach(function(line, idx) {
          var cols = line.split('\t').map(function(c){ return c.trim(); }).filter(function(c){ return c.length > 0; });
          if (cols.length < 2) { errors.push('Row '+(idx+1)+': needs at least 2 columns (got '+cols.length+')'); return; }
          var name = '', pageId = '', token = '';
          cols.forEach(function(c) {
            if (/^EAA/i.test(c)) token = c;
            else if (/^\d{8,}$/.test(c)) pageId = c;
            else if (!name) name = c;
          });
          if (!pageId) { errors.push('Row '+(idx+1)+': no Page ID found (should be a long number) in: '+line.slice(0,60)); return; }
          if (!token) { errors.push('Row '+(idx+1)+': no Token found (should start with EAA) in: '+line.slice(0,60)); return; }
          if (!name) name = 'Page ' + pageId;
          bulkParsed.push({ name: name, pageId: pageId, token: token });
        });
        var preview = document.getElementById('bulk-preview');
        var status = document.getElementById('bulk-status');
        var addBtn = document.getElementById('bulk-add-btn');
        if (bulkParsed.length === 0 && errors.length === 0) {
          status.style.color = '#92400e'; status.textContent = 'Nothing found — check format';
          preview.innerHTML = ''; addBtn.style.display = 'none'; return;
        }
        var rows = bulkParsed.map(function(p, i) {
          return '<tr style="background:'+(i%2===0?'#f9fafb':'#fff')+'">'
            + '<td style="padding:7px 10px;font-weight:600;">'+escHtml(p.name)+'</td>'
            + '<td style="padding:7px 10px;font-family:monospace;font-size:12px;color:#6b7280;">'+escHtml(p.pageId)+'</td>'
            + '<td style="padding:7px 10px;font-family:monospace;font-size:11px;color:#16a34a;">'+escHtml(p.token.slice(0,16))+'...'+escHtml(p.token.slice(-6))+'</td>'
            + '</tr>';
        }).join('');
        var errHtml = errors.length ? '<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:8px 12px;margin-top:8px;font-size:12px;color:#dc2626;">'
          + errors.map(function(e){ return '<div>&#10060; '+escHtml(e)+'</div>'; }).join('') + '</div>' : '';
        preview.innerHTML = '<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">'
          + '<thead><tr style="background:#f0fdf4;"><th style="padding:8px 10px;text-align:left;font-size:12px;color:#166534;">Name</th>'
          + '<th style="padding:8px 10px;text-align:left;font-size:12px;color:#166534;">Page ID</th>'
          + '<th style="padding:8px 10px;text-align:left;font-size:12px;color:#166534;">Token</th></tr></thead>'
          + '<tbody>'+rows+'</tbody></table>' + errHtml;
        if (bulkParsed.length > 0) {
          status.style.color = '#166534';
          status.textContent = bulkParsed.length + ' page(s) ready to add' + (errors.length ? ' (' + errors.length + ' row(s) skipped)' : '');
          addBtn.style.display = 'inline-block';
          addBtn.textContent = 'Add ' + bulkParsed.length + ' Pages';
        } else {
          status.style.color = '#dc2626'; status.textContent = errors.length + ' error(s) — check format';
          addBtn.style.display = 'none';
        }
      }
      function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function submitBulkPages() {
        if (!bulkParsed.length) return;
        var btn = document.getElementById('bulk-add-btn');
        var status = document.getElementById('bulk-status');
        btn.disabled = true; btn.textContent = 'Adding...';
        status.style.color = '#6b7280'; status.textContent = 'Adding pages...';
        fetch('/bulk-add-pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pages: bulkParsed })
        })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d.ok) {
            status.style.color = '#16a34a';
            status.textContent = d.added + ' added, ' + d.skipped + ' skipped (already existed)';
            btn.style.display = 'none';
            document.getElementById('bulk-pages-input').value = '';
            document.getElementById('bulk-preview').innerHTML = '';
            bulkParsed = [];
          } else {
            status.style.color = '#dc2626'; status.textContent = 'Error: ' + (d.error || 'unknown');
            btn.disabled = false; btn.textContent = 'Add ' + bulkParsed.length + ' Pages';
          }
        })
        .catch(function(e){
          status.style.color = '#dc2626'; status.textContent = 'Error: ' + e.message;
          btn.disabled = false;
        });
      }
    </script>

    <div class="card">
      <h2>➕ Add New Page</h2>
      <p style="color:#6b7280;font-size:13px;">New pages default to: ⏸️ Broadcast Paused · 🛡️ Auto-cleanup Disabled. Enable them manually after setup.</p>

      <div style="background:#eef6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:600;color:#0c447c;margin-bottom:8px;">📋 Paste into Facebook Developer:</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
          <span style="font-size:11px;color:#0c447c;font-weight:600;min-width:100px;">Callback URL:</span>
          <input type="text" id="webhook-url" value="${esc(PUBLIC_URL)}/webhook" readonly onclick="this.select();" style="flex:1;min-width:240px;padding:6px 10px;font-family:monospace;font-size:12px;background:#fff;border:1px solid #b5d4f4;border-radius:5px;color:#0c447c;"/>
          <button type="button" onclick="(function(b){var i=document.getElementById('webhook-url');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='✓ Copied';setTimeout(function(){b.innerText=t;},1200);})(this)" style="padding:6px 12px;background:#3a8dde;color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">📋 Copy</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:11px;color:#0c447c;font-weight:600;min-width:100px;">Verify Token:</span>
          <input type="text" id="verify-token" value="${esc(VERIFY_TOKEN)}" readonly onclick="this.select();" style="flex:1;min-width:240px;padding:6px 10px;font-family:monospace;font-size:12px;background:#fff;border:1px solid #b5d4f4;border-radius:5px;color:#0c447c;"/>
          <button type="button" onclick="(function(b){var i=document.getElementById('verify-token');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='✓ Copied';setTimeout(function(){b.innerText=t;},1200);})(this)" style="padding:6px 12px;background:#3a8dde;color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">📋 Copy</button>
        </div>
        <div style="font-size:11px;color:#4a5568;margin-top:8px;">Subscribe to: <code>messages</code>, <code>messaging_postbacks</code>, <code>messaging_optins</code>, <code>message_reads</code>, <code>message_deliveries</code></div>
      </div>

      <form action="/add-page" method="POST">
        <div class="row">
          <div>
            <label>Page ID *</label>
            <input name="pageId" required placeholder="e.g. 1051803118023056"/>
          </div>
          <div>
            <label>Page Label / Nickname</label>
            <input name="label" placeholder="e.g. Mature, Friend Requests"/>
          </div>
        </div>
        <label>Page Access Token *</label>
        <input name="accessToken" required placeholder="EAAxxx..." style="font-family:monospace;font-size:12px;"/>
        <label>Assign to Group (optional)</label>
        <select name="group" style="width:100%;padding:9px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">
          <option value="">— unassigned —</option>
          ${getAllGroups(pages).map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
        </select>
        <details>
          <summary>Optional: customize this page (otherwise uses defaults)</summary>
          <div class="row">
            <div><label>Card Title</label><input name="title" placeholder="${esc(getDefaults().title)}"/></div>
            <div><label>Card Subtitle</label><input name="subtitle" placeholder="${esc(getDefaults().subtitle)}"/></div>
          </div>
          <div class="row">
            <div><label>Button Text</label><input name="buttonText" placeholder="${esc(getDefaults().buttonText)}"/></div>
            <div><label>WhatsApp / Redirect URL</label><input name="whatsapp" placeholder="${esc(getDefaults().whatsapp)}"/></div>
          </div>
          <label>Photos (one URL per line)</label>
          <textarea name="photos" placeholder="${esc(getDefaults().photos.join('\n'))}"></textarea>
          <div class="row">
            <div><label>Daily Broadcast Time (HH:MM)</label><input name="broadcastTime" placeholder="${esc(getDefaults().broadcastTime)}"/></div>
            <div><label>Timezone</label><input name="timezone" placeholder="${esc(getDefaults().timezone)}"/></div>
          </div>
          <div class="row">
            <div>
              <label>Spacing Between Sends</label>
              ${renderSpacingSelect('spacingSeconds', getDefaults().spacingSeconds)}
            </div>
          </div>
        </details>
        <button type="submit" class="btn btn-green">➕ Add Page</button>
      </form>
    </div>
  </div></body></html>`;
}

function renderPageView(page, req) {
  const fans = loadFans(page.pageId);
  const lib = loadLibrary();
  const currentSet = pageSet(page, lib);
  const setNames = getSetNames(lib);
  const mode = pageContentMode(page);
  const pid = esc(page.pageId);

  const photosHtml = (page.photos || []).map((url, i) => {
    const isActive = url === page.currentPhoto;
    const copyId = `cpy-${i}`;
    return `
    <div class="item ${isActive ? 'current' : ''}">
      <div class="img-wrap"><img src="${esc(url)}" alt="photo ${i}"/></div>
      <div class="url-row">
        <input type="text" id="${copyId}" value="${esc(url)}" readonly onclick="this.select();"/>
      </div>
      <div class="action-row">
        <button type="button" class="ph-btn ph-copy" onclick="(function(b){var i=document.getElementById('${copyId}');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='Copied';setTimeout(function(){b.innerText=t;},1200);})(this)">Copy URL</button>
        ${isActive
          ? '<span class="badge-current">ACTIVE</span>'
          : `<a href="/set-active-photo?page=${pid}&index=${i}" class="ph-btn ph-active">Set Active</a>`
        }
        ${(page.photos.length > 1) ? `<a href="/remove-photo?page=${pid}&index=${i}" onclick="return confirm('Remove this photo?')" class="ph-btn ph-remove">Remove</a>` : ''}
      </div>
    </div>`;
  }).join('');

  const pages = loadPages();
  const groups = getAllGroups(pages);
  const groupOpts = ['', ...groups].map(g =>
    `<option value="${esc(g)}" ${(page.group || '') === g ? 'selected' : ''}>${g || '--- unassigned ---'}</option>`
  ).join('');

  const setButtons = setNames.map(name => {
    const isCurrent = name === currentSet;
    const color = name === 'Scrollgallery' ? '#3a8dde' : '#f59e0b';
    return `<form action="/set-page-redirect-set?page=${pid}" method="POST" style="margin:0;display:inline;">
      <input type="hidden" name="setName" value="${esc(name)}"/>
      <button type="submit" style="background:${isCurrent ? color : '#e2e8f0'};color:${isCurrent ? '#fff' : '#475569'};border:none;border-radius:6px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;">
        ${isCurrent ? '&#10003; ' : ''}${esc(name)}
      </button>
    </form>`;
  }).join('');

  const randomizeBtn = mode === 'templates'
    ? `<form action="/randomize-page?page=${pid}" method="POST" style="margin:0;display:inline;">
        <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;margin-top:0;">&#127924; Pick Random Template</button>
       </form>
       <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;display:inline;">
        <button type="submit" class="btn" style="background:#7c3aed;color:#fff;margin-top:0;" onclick="return confirm('Pick random template and send to ${fans.length} fans?')">&#127924;&#128640; Random + Send</button>
       </form>`
    : `<form action="/randomize-page?page=${pid}" method="POST" style="margin:0;display:inline;">
        <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;margin-top:0;">&#127922; Pick Random</button>
       </form>
       <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;display:inline;">
        <button type="submit" class="btn" style="background:#7c3aed;color:#fff;margin-top:0;" onclick="return confirm('Randomize and send to ${fans.length} fans?')">&#127922;&#128640; Random + Send</button>
       </form>`;

  return `<div class="container">
    ${renderAlerts(req)}

    <div class="card" style="background:linear-gradient(135deg,#1a1d2e 0%,#2d3154 100%);border:none;padding:18px 22px;">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="background:rgba(255,255,255,0.1);border-radius:8px;padding:10px 16px;text-align:center;min-width:90px;">
          <div style="font-size:26px;font-weight:800;color:#fff;line-height:1;">${fans.length.toLocaleString()}</div>
          <div style="font-size:10px;color:#a5b4fc;text-transform:uppercase;letter-spacing:1px;margin-top:2px;">Fans</div>
        </div>
        <div style="width:1px;height:50px;background:rgba(255,255,255,0.15);"></div>
        <div>
          <div style="font-size:10px;color:#a5b4fc;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Website</div>
          <div style="display:flex;gap:6px;">${setButtons}</div>
        </div>
        <div style="width:1px;height:50px;background:rgba(255,255,255,0.15);"></div>
        <div>
          <div style="font-size:10px;color:#a5b4fc;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Quick Actions</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${randomizeBtn}
            <a href="/import-contacts?page=${pid}" class="btn" style="background:#16a34a;color:#fff;margin-top:0;">&#128229; Import Contacts</a>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Page Status</div>
        <div style="font-size:16px;font-weight:700;color:#1a1d2e;margin-top:2px;">
          ${page.broadcastEnabled ? '<span style="color:#28a745;">&#128994; Active</span> - daily auto-broadcast ON' : '<span style="color:#f59e0b;">&#9208;&#65039; Paused</span> - daily auto-broadcast OFF'}
        </div>
        <div style="font-size:13px;color:#475569;margin-top:4px;">
          ${page.sendNowEnabled !== false ? '<span style="color:#16a34a;">&#9989; Send Now ON</span>' : '<span style="color:#f59e0b;">&#128683; Send Now OFF</span>'}
          &nbsp;&middot;&nbsp; Group: <span class="group-badge ${page.group ? '' : 'unassigned'}">${esc(page.group || 'unassigned')}</span>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <form action="/toggle-page" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <input type="hidden" name="returnTo" value="page"/>
          ${page.broadcastEnabled
            ? '<button type="submit" class="qbtn qbtn-pause" style="padding:8px 14px;font-size:13px;width:100%;">Pause Daily Broadcast</button>'
            : '<button type="submit" class="qbtn qbtn-resume" style="padding:8px 14px;font-size:13px;width:100%;">Resume Daily Broadcast</button>'
          }
        </form>
        <form action="/toggle-sendnow" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <input type="hidden" name="returnTo" value="page"/>
          ${page.sendNowEnabled !== false
            ? '<button type="submit" class="qbtn" style="background:#f59e0b;padding:8px 14px;font-size:13px;width:100%;">Pause Send Now</button>'
            : '<button type="submit" class="qbtn qbtn-resume" style="padding:8px 14px;font-size:13px;width:100%;">Resume Send Now</button>'
          }
        </form>
        <form action="/group-assign" method="POST" style="margin:0;display:flex;gap:5px;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <input type="hidden" name="returnTo" value="page"/>
          <select name="group" style="padding:6px 8px;font-size:12px;border:1px solid #c4b5fd;border-radius:5px;color:#6d28d9;font-weight:600;">
            ${groupOpts}
          </select>
          <button type="submit" class="qbtn" style="background:#6d28d9;padding:8px 10px;">Set Group</button>
        </form>
      </div>
    </div>

    ${(function(){
      const gMode = getGlobalContentMode();
      const pMode = page.contentMode;
      const isClassic = pMode === 'classic';
      const isTemplates = pMode === 'templates';
      const isGlobal = !isClassic && !isTemplates;
      const effective = isGlobal ? gMode : pMode;
      return `
    <div class="card" style="border:2px solid #e9d5ff;">
      <h2>&#127898;&#65039; Content Mode</h2>
      <p style="color:#6b7280;font-size:13px;">Effective: <strong style="color:${effective === 'templates' ? '#7c3aed' : '#0c447c'};">${effective === 'templates' ? 'Templates' : 'Classic'}</strong></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;"><input type="hidden" name="returnTo" value="page"/><input type="hidden" name="mode" value="classic"/>
          <button type="submit" class="btn" style="background:${isClassic ? '#16a34a' : '#e2e8f0'};color:${isClassic ? '#fff' : '#475569'};">${isClassic ? '&#10003; ' : ''}Classic</button>
        </form>
        <form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;"><input type="hidden" name="returnTo" value="page"/><input type="hidden" name="mode" value="templates"/>
          <button type="submit" class="btn" style="background:${isTemplates ? '#16a34a' : '#e2e8f0'};color:${isTemplates ? '#fff' : '#475569'};">${isTemplates ? '&#10003; ' : ''}Templates</button>
        </form>
        <form action="/set-page-mode?page=${pid}" method="POST" style="margin:0;"><input type="hidden" name="returnTo" value="page"/><input type="hidden" name="mode" value="global"/>
          <button type="submit" class="btn" style="background:${isGlobal ? '#16a34a' : '#e2e8f0'};color:${isGlobal ? '#fff' : '#475569'};">${isGlobal ? '&#10003; ' : ''}Global (${gMode})</button>
        </form>
      </div>
    </div>`;
    })()}

    <div class="card" id="broadcast-progress-card" style="display:none;border:2px solid #c7d2fe;">
      <h2>&#128225; Broadcast Progress</h2>
      <div>
        <div style="font-size:15px;font-weight:600;color:#1a1d2e;" id="bp-headline">--</div>
        <div style="background:#e2e8f0;border-radius:999px;height:14px;overflow:hidden;margin:10px 0;">
          <div id="bp-bar" style="background:#6366f1;height:100%;width:0%;transition:width 0.4s;"></div>
        </div>
        <div style="font-size:13px;color:#6b7280;" id="bp-detail">--</div>
      </div>
    </div>
    <script>
      (function() {
        var pid = ${JSON.stringify(page.pageId)};
        var card = document.getElementById('broadcast-progress-card');
        var headline = document.getElementById('bp-headline');
        var bar = document.getElementById('bp-bar');
        var detail = document.getElementById('bp-detail');
        function fmtTime(s){ var m=Math.floor(s/60), sec=s%60; return m>0?(m+'m '+sec+'s'):(sec+'s'); }
        function poll() {
          fetch('/broadcast-status?page=' + encodeURIComponent(pid))
            .then(function(r){ return r.json(); })
            .then(function(d){
              if (!d.active) { card.style.display='none'; return; }
              card.style.display='block';
              var pct = d.total > 0 ? Math.round(d.done / d.total * 100) : 100;
              bar.style.width = pct + '%';
              if (d.status === 'complete') {
                bar.style.background = '#22c55e';
                headline.innerHTML = 'Broadcast complete -- all ' + d.total + ' fans done';
                detail.textContent = 'Sent ' + d.done + ' in ' + fmtTime(d.elapsedSec);
              } else {
                bar.style.background = '#6366f1';
                headline.innerHTML = 'Sending ' + d.done + ' / ' + d.total + ' (' + pct + '%)';
                detail.textContent = d.remaining + ' remaining';
              }
            }).catch(function(){});
        }
        poll(); setInterval(poll, 5000);
      })();
    </script>

    <div class="card" style="border:2px solid #fde68a;padding:0;overflow:hidden;">
      <details>
        <summary style="cursor:pointer;padding:16px 20px;list-style:none;display:flex;align-items:center;gap:10px;user-select:none;">
          <span style="font-size:13px;color:#92400e;transition:transform 0.2s;display:inline-block;" class="bp-arrow">&#9654;</span>
          <span style="font-size:18px;font-weight:700;color:#1a1d2e;">Page Settings</span>
          <span style="font-size:12px;color:#6b7280;font-family:monospace;margin-left:auto;">${esc(page.pageId)} - ${esc(page.label)}</span>
        </summary>
        <div style="padding:0 20px 20px;">
          <form action="/edit-page?page=${pid}" method="POST">
            <label>Page Access Token</label>
            <input name="accessToken" placeholder="Paste new EAAxxx... token (leave blank to keep current)" style="font-family:monospace;font-size:12px;width:100%;"/>
            <div class="helper">Current: <code>${page.accessToken ? esc(page.accessToken.slice(0,12)) + '...' + esc(page.accessToken.slice(-6)) : '(none)'}</code></div>
            <label>Page Label</label>
            <input name="label" value="${esc(page.label)}" style="width:100%;"/>
            <button type="submit" class="btn btn-green" style="margin-top:12px;">Update</button>
          </form>
        </div>
      </details>
    </div>

    <div class="card">
      <h2>Card / Message Editor</h2>
      <form action="/update-settings?page=${pid}" method="POST">
        <div class="row">
          <div><label>Card Title</label><input name="title" value="${esc(page.title)}"/></div>
          <div><label>Card Subtitle</label><input name="subtitle" value="${esc(page.subtitle)}"/></div>
        </div>
        <div class="row">
          <div><label>Button Text</label><input name="buttonText" value="${esc(page.buttonText)}"/></div>
          <div><label>Redirect URL</label><input name="whatsapp" value="${esc(page.whatsapp)}"/></div>
        </div>
        <label>Active Photo URL</label>
        <input name="currentPhoto" value="${esc(page.currentPhoto || '')}"/>
        <label>Page Label</label>
        <input name="label" value="${esc(page.label)}"/>
        <button type="submit" class="btn btn-green">Save Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>Template Manager</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div style="background:#eef6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px;">
          <h3 style="margin:0 0 8px;color:#0c447c;font-size:14px;">Template 1: Photo Card</h3>
          <div style="background:#fff;border-radius:6px;padding:8px;margin-bottom:10px;border:1px solid #d1d5db;">
            <div style="font-size:11px;font-weight:600;color:#1a1d2e;">${esc(page.title || '(no title)')}</div>
            <div style="font-size:10px;color:#4a5568;margin:2px 0;">${esc((page.subtitle || '').slice(0, 50))}</div>
          </div>
          <a href="/send-now?page=${pid}" class="btn btn-green" style="display:block;text-align:center;margin:0;" onclick="return confirm('Send PHOTO CARD to ${fans.length} fans now?')">Send Card to All</a>
        </div>
        <div style="background:#fef3e7;border:1px solid #fde68a;border-radius:8px;padding:12px;">
          <h3 style="margin:0 0 8px;color:#92400e;font-size:14px;">Template 2: Plain Text</h3>
          <form action="/save-text-template?page=${pid}" method="POST" style="margin:0;">
            <textarea name="textTemplate" placeholder="e.g. Hello! Where are you from?" style="width:100%;min-height:80px;padding:7px 9px;border:1px solid #d1d5db;border-radius:5px;font-size:12px;font-family:inherit;resize:vertical;background:#fff;">${esc(page.textTemplate || '')}</textarea>
            <button type="submit" class="btn" style="background:#92400e;width:100%;margin-top:6px;">Save Text</button>
          </form>
          <form action="/send-text-now?page=${pid}" method="POST" style="margin:6px 0 0;">
            <button type="submit" class="btn btn-green" style="display:block;text-align:center;margin:0;width:100%;" onclick="return confirm('Send TEXT to ${fans.length} fans now?')">Send Text to All</button>
          </form>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Schedule</h2>
      <form action="/update-schedule?page=${pid}" method="POST">
        <div class="row">
          <div><label>Daily Broadcast Time (HH:MM)</label><input name="broadcastTime" value="${esc(page.broadcastTime)}"/></div>
          <div><label>Timezone</label><input name="timezone" value="${esc(page.timezone)}"/></div>
        </div>
        <div class="row">
          <div>
            <label>Spacing Between Sends</label>
            ${renderSpacingSelect('spacingSeconds', page.spacingSeconds || 10)}
          </div>
          <div>
            <label>Daily Auto-Broadcast</label>
            <select name="broadcastEnabled">
              <option value="true" ${page.broadcastEnabled ? 'selected' : ''}>Enabled</option>
              <option value="false" ${!page.broadcastEnabled ? 'selected' : ''}>Paused</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Auto-Cleanup Threshold</label>
            <select name="cleanupThreshold">
              <option value="0" ${page.cleanupThreshold === 0 ? 'selected' : ''}>0 - Disabled</option>
              <option value="1" ${(page.cleanupThreshold === undefined || page.cleanupThreshold === 1) ? 'selected' : ''}>1 - Remove on 1st failure</option>
              <option value="2" ${page.cleanupThreshold === 2 ? 'selected' : ''}>2 - Remove after 2 failures</option>
              <option value="3" ${page.cleanupThreshold === 3 ? 'selected' : ''}>3 - Remove after 3 failures</option>
              <option value="5" ${page.cleanupThreshold === 5 ? 'selected' : ''}>5 - Very safe</option>
              <option value="10" ${page.cleanupThreshold === 10 ? 'selected' : ''}>10 - Almost never remove</option>
            </select>
          </div>
          <div></div>
        </div>
        <button type="submit" class="btn btn-green">Save Schedule</button>
      </form>
    </div>

    <div class="card">
      <h2>Photos</h2>
      <div class="photo-grid">${photosHtml}</div>
      <form action="/add-photo?page=${pid}" method="POST" style="margin-top:14px;">
        <label>Add Photo URL</label>
        <input name="photoUrl" placeholder="https://i.imgur.com/..."/>
        <button type="submit" class="btn btn-blue">Add Photo</button>
      </form>
    </div>

    ${renderPageLibrarySection(page)}

    <div class="card">
      <h2>Broadcasts</h2>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:14px;">
        <h3 style="margin-top:0;color:#92400e;">Test Send to Specific PSID</h3>
        <form action="/test-send?page=${pid}" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <div style="flex:1;min-width:200px;"><label>PSID</label><input name="psid" placeholder="e.g. 1234567890" required/></div>
          <button type="submit" class="btn btn-orange" style="margin-top:0;">Send Test</button>
        </form>
      </div>
      <p style="font-size:13px;color:#6b7280;">Send to ALL ${fans.length} fans, spaced <strong>${page.spacingSeconds || 10}s</strong> apart. Est. ~${Math.ceil(fans.length * (page.spacingSeconds || 10) / 60)} min.</p>
      <a href="/send-now?page=${pid}" class="btn btn-green" onclick="return confirm('Send to ${fans.length} fans now?')">Send Now</a>
      <h3>Custom Broadcast</h3>
      <form action="/send-custom?page=${pid}" method="POST">
        <label>Photo URL (optional)</label>
        <input name="photo" placeholder="${esc(page.currentPhoto || '')}"/>
        <button type="submit" class="btn btn-blue" onclick="return confirm('Send custom broadcast to ${fans.length} fans?')">Send Custom</button>
      </form>
      <h3>Schedule One-Time</h3>
      <form action="/schedule-once?page=${pid}" method="POST">
        <label>Send at</label>
        <input name="scheduleTime" type="datetime-local"/>
        <button type="submit" class="btn btn-blue">Schedule</button>
      </form>
    </div>

    <div class="card">
      <h2>Fan Management</h2>
      <div class="row">
        <div>
          <h3>Import from Facebook</h3>
          <a href="/import-contacts?page=${pid}" class="btn btn-blue">Import All Contacts</a>
        </div>
        <div>
          <h3>Export / Backup</h3>
          <a href="/export-fans?page=${pid}" class="btn btn-blue">Export Fan List</a>
        </div>
      </div>
      <h3>Bulk Import</h3>
      <form action="/bulk-add-fans?page=${pid}" method="POST">
        <label>Paste PSIDs (one per line or comma-separated)</label>
        <textarea name="psids" placeholder="1234567890"></textarea>
        <button type="submit" class="btn btn-green">Bulk Import</button>
      </form>
      <h3>Manual</h3>
      <form action="/add-fan?page=${pid}" method="POST" style="margin-bottom:10px;">
        <label>Add single PSID</label>
        <input name="psid"/>
        <button type="submit" class="btn btn-green">Add Fan</button>
      </form>
      <form action="/set-baseline?page=${pid}" method="POST" style="margin-bottom:10px;">
        <label>Set Baseline</label>
        <input name="value" type="number" value="${page.baselineFans || 0}"/>
        <button type="submit" class="btn btn-orange">Set Baseline</button>
      </form>
      <a href="/clear-fans?page=${pid}" class="btn btn-red" onclick="return confirm('CLEAR all ${fans.length} fans? Export first!')">Clear All Fans</a>
      <form action="/reset-stats?page=${pid}" method="POST" style="margin-top:10px;">
        <button type="submit" class="btn" style="background:#dc2626;color:#fff;" onclick="return confirm('Reset stats? Fans kept.')">Reset Stats (keep fans)</button>
      </form>
    </div>

    <div class="card danger-zone">
      <h2>Danger Zone</h2>
      <form action="/remove-page" method="POST" style="display:inline;">
        <input type="hidden" name="pageId" value="${pid}"/>
        <button type="submit" class="btn btn-red" onclick="return confirm('REMOVE page ${esc(page.label)}? Fans + stats deleted.')">Remove This Page</button>
      </form>
    </div>
  </div></body></html>`;
}

// ============================================
// MAIN ROUTE
// ============================================
app.get('/', (req, res) => {
  const pages = loadPages();
  const selectedPageId = req.query.page;
  const showAll = !selectedPageId || selectedPageId === 'all';
  let html = renderHead('messagebot');
  html += renderTopbar(pages, selectedPageId);
  if (selectedPageId === 'templates') {
    html += renderTemplateManager(req);
  } else if (showAll) {
    html += renderAllPagesView(pages, req);
  } else {
    const page = getPage(selectedPageId);
    if (!page) {
      html += `<div class="container"><div class="alert alert-error">Page not found. <a href="/">Go back</a></div></div>`;
    } else {
      html += renderPageView(page, req);
    }
  }
  res.send(html);
});

// ============================================
// PAGE MANAGEMENT
// ============================================
// Bulk add pages from paste
app.post('/bulk-add-pages', (req, res) => {
  const pages = req.body.pages;
  if (!Array.isArray(pages) || !pages.length) return res.json({ ok: false, error: 'No pages provided' });
  let added = 0, skipped = 0;
  pages.forEach(p => {
    if (!p.pageId || !p.token) { skipped++; return; }
    const result = addPage({
      pageId: String(p.pageId).trim(),
      accessToken: String(p.token).trim(),
      label: (p.name || '').trim() || `Page ${p.pageId}`
    });
    if (result) {
      added++;
      try { setupMessenger(result); } catch {}
    } else {
      skipped++; // already exists
    }
  });
  res.json({ ok: true, added, skipped });
});

app.post('/add-page', (req, res) => {
  const b = req.body;
  if (!b.pageId || !b.accessToken) {
    return res.redirect('/?error=' + encodeURIComponent('Page ID and Access Token required'));
  }
  const photos = (b.photos || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const data = {
    pageId: b.pageId,
    accessToken: b.accessToken,
    label: b.label || undefined,
    title: b.title || undefined,
    subtitle: b.subtitle || undefined,
    buttonText: b.buttonText || undefined,
    whatsapp: b.whatsapp || undefined,
    photos: photos.length ? photos : undefined,
    broadcastTime: b.broadcastTime || undefined,
    timezone: b.timezone || undefined,
    spacingSeconds: b.spacingSeconds ? parseInt(b.spacingSeconds) : undefined,
    group: b.group || ''
  };
  const newPage = addPage(data);
  if (!newPage) {
    return res.redirect('/?error=' + encodeURIComponent('Page ID already exists'));
  }
  setupMessenger(newPage);
  res.redirect(`/?page=${encodeURIComponent(newPage.pageId)}&added=1`);
});

app.post('/remove-page', (req, res) => {
  if (req.body.pageId) removePage(req.body.pageId);
  res.redirect('/?removed=1');
});

// Reorder pages — saves new order from drag & drop
app.post('/pages-reorder', (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) return res.json({ ok: false, error: 'No order provided' });
  const pages = loadPages();
  // Build a map for quick lookup
  const pageMap = {};
  pages.forEach(p => { pageMap[p.pageId] = p; });
  // Reorder: put pages in the new order, append any missing ones at the end
  const reordered = order.filter(id => pageMap[id]).map(id => pageMap[id]);
  const missing = pages.filter(p => !order.includes(p.pageId));
  savePages([...reordered, ...missing]);
  res.json({ ok: true });
});

app.post('/toggle-page', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, { broadcastEnabled: !page.broadcastEnabled });
  res.redirect(req.body.returnTo === 'page' ? `/?page=${encodeURIComponent(pageId)}&saved=1` : '/?saved=1');
});

app.post('/toggle-sendnow', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const current = page.sendNowEnabled !== false;
  updatePage(pageId, { sendNowEnabled: !current });
  res.redirect(req.body.returnTo === 'page' ? `/?page=${encodeURIComponent(pageId)}&saved=1` : '/?saved=1');
});

// ============================================
// PAGE GROUPS ROUTES
// ============================================
// Create a new group name — stored in settings so it shows in dropdowns immediately
app.post('/group-create', (req, res) => {
  const group = (req.body.group || '').trim();
  if (!group) return res.redirect('/?error=' + encodeURIComponent('Group name cannot be empty'));
  saveGroupName(group);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Group "' + group + '" created — now assign pages to it below.'));
});

// Assign a page to a group (or unassign with empty string)
app.post('/group-assign', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, { group: (req.body.group || '').trim() });
  if (req.body.returnTo === 'page') {
    res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
  } else {
    res.redirect('/?page=all&saved=1');
  }
});

// Bulk assign multiple pages to a group in one AJAX call — no redirect
app.post('/group-assign-bulk', (req, res) => {
  const { pageIds, group } = req.body;
  if (!Array.isArray(pageIds) || !pageIds.length) return res.json({ ok: false, error: 'No pages provided' });
  const groupName = (group || '').trim();
  let updated = 0;
  pageIds.forEach(pid => {
    if (getPage(pid)) { updatePage(pid, { group: groupName }); updated++; }
  });
  res.json({ ok: true, updated });
});

// Delete a group — unassigns all pages in it and removes from settings
app.post('/group-delete', (req, res) => {
  const group = (req.body.group || '').trim();
  if (!group) return res.redirect('/?page=all');
  const pages = loadPages();
  pages.forEach(p => { if (p.group === group) updatePage(p.pageId, { group: '' }); });
  deleteGroupName(group);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Group "' + group + '" deleted — pages unassigned'));
});

// Send Now to a specific GROUP only
app.post('/send-now-group', (req, res) => {
  const group = (req.body.group || '').trim();
  const doRandomize = req.body.randomize === '1';
  if (!group) return res.redirect('/?error=No+group+selected');
  const pages = loadPages();
  const eligible = pages.filter(p => p.group === group && p.sendNowEnabled !== false);
  if (!eligible.length) {
    return res.redirect('/?page=all&error=' + encodeURIComponent('No eligible pages in group "' + group + '" (all have Send Now paused or group is empty)'));
  }
  let totalFans = 0;
  const perPage = [];
  eligible.forEach(p => {
    let page = getPage(p.pageId);
    if (doRandomize) page = randomizePage(page, {});
    const count = broadcastToPage(page, {});
    totalFans += count;
    perPage.push({ label: page.label, count, redirect: page.whatsapp });
  });
  console.log(`📣 Group Send Now "${group}"${doRandomize ? ' (randomized)' : ''}: ${eligible.length} pages, ${totalFans} fans`);
  const rows = perPage.map(x => `<tr><td>${esc(x.label)}</td><td style="text-align:right;">${x.count}</td><td style="font-size:11px;color:#6b7280;">${esc((x.redirect||'').replace(/^https?:\/\//,''))}</td></tr>`).join('');
  res.send(`${renderHead('Group Send')}<div class="container"><div class="card">
    <h2>📣 Group "${esc(group)}" Send${doRandomize ? ' + Randomize' : ''} Started</h2>
    <p>Broadcasting to <strong>${eligible.length} pages</strong> in group <strong>${esc(group)}</strong> · <strong>${totalFans} total fans</strong>.</p>
    <table style="width:100%;margin-top:12px;"><thead><tr><th>Page</th><th style="text-align:right;">Fans</th><th>Redirect</th></tr></thead><tbody>${rows}</tbody></table>
    <a href="/?page=all" class="btn btn-green" style="margin-top:16px;">← Back to Dashboard</a>
  </div></div></body></html>`);
});

// ============================================
// BULK SEND NOW (ALL)
// ============================================
app.post('/send-now-all', (req, res) => {
  const pages = loadPages();
  const doRandomize = req.query.randomize === '1';
  const eligible = pages.filter(p => p.sendNowEnabled !== false);
  let totalFans = 0;
  const perPage = [];
  eligible.forEach(p => {
    let page = getPage(p.pageId);
    if (doRandomize) page = randomizePage(page, {});
    const count = broadcastToPage(page, {});
    totalFans += count;
    perPage.push({ label: page.label, count, redirect: page.whatsapp });
  });
  const skipped = pages.length - eligible.length;
  console.log(`📣 Bulk Send Now${doRandomize ? ' (randomized)' : ''}: ${eligible.length} pages, ${totalFans} fans, ${skipped} skipped`);
  const rows = perPage.map(x => `<tr><td>${esc(x.label)}</td><td style="text-align:right;">${x.count}</td><td style="font-size:11px;color:#6b7280;">${esc((x.redirect||'').replace(/^https?:\/\//,''))}</td></tr>`).join('');
  res.send(`${renderHead('Bulk Send')}<div class="container"><div class="card">
    <h2>📣 Bulk Send Now${doRandomize ? ' + Randomize' : ''} Started</h2>
    <p><strong>${eligible.length} pages</strong> · <strong>${totalFans} total fans</strong>.${skipped ? ` <span style="color:#92400e;">${skipped} skipped (Send Now paused).</span>` : ''}</p>
    <table style="width:100%;margin-top:12px;"><thead><tr><th>Page</th><th style="text-align:right;">Fans</th><th>Redirect</th></tr></thead><tbody>${rows}</tbody></table>
    <a href="/?page=all" class="btn btn-green" style="margin-top:16px;">← Back to Dashboard</a>
  </div></div></body></html>`);
});

app.post('/pause-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: false }));
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Send Now PAUSED on all pages'));
});

app.post('/resume-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: true }));
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Send Now RESUMED on all pages'));
});

app.post('/pause-all', (req, res) => {
  loadPages().forEach(p => { if (p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled: false }); });
  res.redirect('/?saved=1');
});

app.post('/resume-all', (req, res) => {
  loadPages().forEach(p => { if (!p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled: true }); });
  res.redirect('/?saved=1');
});

app.post('/disable-cleanup-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { cleanupThreshold: 0 }));
  res.redirect('/?saved=1');
});

app.post('/enable-cleanup-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { cleanupThreshold: 1 }));
  res.redirect('/?saved=1');
});

// ============================================
// PER-PAGE SETTINGS / SCHEDULE
// ============================================
app.post('/update-settings', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, {
    title: req.body.title,
    subtitle: req.body.subtitle,
    buttonText: req.body.buttonText || getDefaults().buttonText,
    whatsapp: req.body.whatsapp,
    currentPhoto: req.body.currentPhoto || undefined,
    label: req.body.label || undefined
  });
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('/page-update-inline', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.json({ ok: false, error: 'page not found' });
  const updates = {};
  if (typeof req.body.label === 'string' && req.body.label.trim()) updates.label = req.body.label.trim();
  if (typeof req.body.token === 'string' && req.body.token.trim()) updates.accessToken = req.body.token.trim();
  const newPageId = (req.body.newPageId || '').trim();
  let finalId = pageId;
  if (newPageId && newPageId !== pageId) {
    if (getPage(newPageId)) return res.json({ ok: false, error: 'that Page ID already exists' });
    updates.pageId = newPageId;
    finalId = newPageId;
  }
  updatePage(pageId, updates);
  if (finalId !== pageId) {
    try { if (fs.existsSync(fansFile(pageId))) fs.renameSync(fansFile(pageId), fansFile(finalId)); } catch (e) {}
    try { if (fs.existsSync(statsFile(pageId))) fs.renameSync(statsFile(pageId), statsFile(finalId)); } catch (e) {}
  }
  if (updates.accessToken) { try { setupMessenger(getPage(finalId)); } catch (e) {} }
  res.json({ ok: true, pageId: finalId });
});

app.post('/edit-page', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const updates = {};
  if (req.body.accessToken && req.body.accessToken.trim()) updates.accessToken = req.body.accessToken.trim();
  if (req.body.label && req.body.label.trim()) updates.label = req.body.label.trim();
  updatePage(pageId, updates);
  if (updates.accessToken) { try { setupMessenger(getPage(pageId)); } catch {} }
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

app.get('/broadcast-status', (req, res) => {
  const pageId = req.query.page;
  const b = broadcastProgress[pageId];
  if (!b) return res.json({ active: false });
  const elapsed = (b.finishedAt || Date.now()) - b.startedAt;
  res.json({ active: true, status: b.status, total: b.total, done: b.done, remaining: Math.max(0, b.total - b.done), type: b.type, elapsedSec: Math.round(elapsed / 1000) });
});

app.post('/update-schedule', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  const threshold = req.body.cleanupThreshold !== undefined ? parseInt(req.body.cleanupThreshold) : 0;
  updatePage(pageId, {
    broadcastTime: req.body.broadcastTime,
    timezone: req.body.timezone,
    spacingSeconds: parseInt(req.body.spacingSeconds) || 10,
    broadcastEnabled: req.body.broadcastEnabled === 'true',
    cleanupThreshold: isNaN(threshold) ? 0 : threshold
  });
  res.redirect(`/?page=${encodeURIComponent(pageId)}&schedule_saved=1`);
});

app.post('/set-baseline', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, { baselineFans: parseInt(req.body.value) || 0 });
  res.redirect(`/?page=${encodeURIComponent(pageId)}`);
});

// ============================================
// PHOTOS
// ============================================
app.post('/add-photo', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  if (req.body.photoUrl) {
    const photos = [...(page.photos || []), req.body.photoUrl];
    updatePage(pageId, { photos });
  }
  res.redirect(`/?page=${encodeURIComponent(pageId)}`);
});

app.get('/remove-photo', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const i = parseInt(req.query.index);
  if (i >= 0 && page.photos && page.photos.length > 1) {
    const photos = [...page.photos];
    photos.splice(i, 1);
    updatePage(pageId, { photos });
  }
  res.redirect(`/?page=${encodeURIComponent(pageId)}`);
});

app.get('/set-active-photo', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const i = parseInt(req.query.index);
  if (page.photos && i >= 0 && i < page.photos.length) {
    updatePage(pageId, { currentPhoto: page.photos[i] });
  }
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// ============================================
// SHARED LIBRARY
// ============================================
app.post('/library-add-photo', (req, res) => {
  const lib = loadLibrary();
  const raw = req.body.photoUrls || req.body.photoUrl || '';
  const urls = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u => { if (!lib.photos.includes(u)) { lib.photos.push(u); added++; } });
  saveLibrary(lib);
  res.redirect(`/?page=all&lib_msg=${encodeURIComponent('Added ' + added + ' photo(s) to shared library')}`);
});

app.get('/library-remove-photo', (req, res) => {
  const lib = loadLibrary();
  const i = parseInt(req.query.index);
  if (i >= 0 && i < lib.photos.length) lib.photos.splice(i, 1);
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Photo removed'));
});

app.post('/library-add-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.body.setName && lib.redirectSets[req.body.setName] ? req.body.setName : DEFAULT_SET;
  const raw = req.body.redirectUrls || req.body.redirectUrl || '';
  const urls = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u => { if (!lib.redirectSets[setName].includes(u)) { lib.redirectSets[setName].push(u); added++; } });
  saveLibrary(lib);
  res.redirect(`/?page=all&lib_msg=${encodeURIComponent('Added ' + added + ' URL(s) to "' + setName + '"')}`);
});

app.get('/library-remove-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.query.set && lib.redirectSets[req.query.set] ? req.query.set : DEFAULT_SET;
  const i = parseInt(req.query.index);
  if (i >= 0 && i < lib.redirectSets[setName].length) lib.redirectSets[setName].splice(i, 1);
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('URL removed from "' + setName + '"'));
});

app.post('/set-page-redirect-set', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const lib = loadLibrary();
  const setName = req.body.setName || req.query.set;
  if (setName && lib.redirectSets[setName]) {
    updatePage(pageId, { redirectSet: setName });
  }
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// ============================================
// CARD TEMPLATES
// ============================================
app.get('/backup', (req, res) => {
  const out = { exportedAt: new Date().toISOString(), dataDir: DATA_DIR, files: {} };
  try {
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && f !== 'package.json' && f !== 'package-lock.json' && !/^prerestore-/.test(f)).forEach(f => {
      const raw = fs.readFileSync(`${DATA_DIR}/${f}`, 'utf8');
      try { out.files[f] = JSON.parse(raw); } catch (e) { out.files[f] = { __unparsed: raw }; }
    });
  } catch (e) {}
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="messagebot-backup-${stamp}.json"`);
  res.send(JSON.stringify(out, null, 2));
});

app.post('/restore-backup', (req, res) => {
  const body = req.body || {};
  const files = (body.files && typeof body.files === 'object') ? body.files : null;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.json({ ok: false, error: 'This does not look like a backup file.' });
  }
  const safe = n => /^[\w.\-]+\.json$/.test(n) && n !== 'package.json' && n !== 'package-lock.json' && !/^prerestore-/.test(n);
  const names = Object.keys(files).filter(safe);
  if (!names.length) return res.json({ ok: false, error: 'No restorable data found.' });
  try {
    const snap = { exportedAt: new Date().toISOString(), files: {} };
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json') && safe(f)).forEach(f => {
      try { snap.files[f] = JSON.parse(fs.readFileSync(`${DATA_DIR}/${f}`, 'utf8')); } catch (e) {}
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    fs.writeFileSync(`${DATA_DIR}/prerestore-${stamp}.json`, JSON.stringify(snap));
  } catch (e) {}
  let restored = 0; const skipped = [];
  names.forEach(name => {
    try {
      const v = files[name];
      const content = (v && v.__unparsed !== undefined) ? v.__unparsed : JSON.stringify(v, null, 2);
      fs.writeFileSync(`${DATA_DIR}/${name}`, content);
      restored++;
    } catch (e) { skipped.push(name); }
  });
  res.json({ ok: true, restored, skipped });
});

app.post('/upload-image', async (req, res) => {
  const clientId = process.env.IMGUR_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error: 'IMGUR_CLIENT_ID is not set.' });
  const b64 = (req.body.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (!b64) return res.status(400).json({ error: 'No image provided' });
  try {
    const r = await fetch('https://api.imgur.com/3/image', {
      method: 'POST',
      headers: { 'Authorization': 'Client-ID ' + clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64, type: 'base64' })
    });
    const d = await r.json();
    if (d && d.success && d.data && d.data.link) return res.json({ url: d.data.link });
    const msg = (d && d.data && d.data.error) ? (typeof d.data.error === 'string' ? d.data.error : 'Imgur rejected') : 'Imgur upload failed';
    return res.status(502).json({ error: msg });
  } catch (e) {
    return res.status(502).json({ error: 'Upload error: ' + e.message });
  }
});

app.post('/template-add', (req, res) => {
  const lib = loadLibrary();
  const b = req.body;
  const photos = parsePhotos(b.photos, b.photo);
  if (!photos.length) return res.redirect('/?page=templates&error=' + encodeURIComponent('At least one photo is required'));

  const setNames = getSetNames(lib);
  const sharedFields = {
    title: (b.title || '').trim(),
    subtitle: (b.subtitle || '').trim(),
    photos,
    photo: photos[0],
    buttonText: (b.buttonText || '').trim() || 'My Photos 📞',
    active: true
  };

  // Collect filled redirect URLs per set
  const toCreate = [];
  setNames.forEach(name => {
    const url = normalizeUrl((b['redirect_' + name] || '').trim());
    if (url) toCreate.push({ set: name, redirect: url });
  });
  // Fallback: old single redirect field (used in edit mode)
  if (!toCreate.length && b.redirect) {
    const setName = (b.set && lib.redirectSets[b.set]) ? b.set : DEFAULT_SET;
    toCreate.push({ set: setName, redirect: normalizeUrl(b.redirect) });
  }
  if (!toCreate.length) return res.redirect('/?page=templates&error=' + encodeURIComponent('At least one redirect URL is required'));

  // Generate IDs first so we can cross-link
  const newIds = toCreate.map(() => 't' + Date.now() + Math.floor(Math.random() * 10000));
  const linkGroup = newIds.length > 1 ? ('lg' + Date.now()) : '';

  const newCards = toCreate.map((item, i) => ({
    ...sharedFields,
    id: newIds[i],
    set: item.set,
    redirect: item.redirect,
    linkGroup,
    // For backward compat with existing 2-card linked system
    linkedId: newIds.length === 2 ? newIds[1 - i] : undefined
  }));

  lib.cardTemplates = lib.cardTemplates || [];
  // Add all new cards at the front
  newCards.reverse().forEach(card => lib.cardTemplates.unshift(card));
  saveLibrary(lib);

  const firstId = newIds[0];
  const msg = newCards.length > 1
    ? `${newCards.length} cards created (${toCreate.map(t => t.set).join(', ')}) — all linked`
    : 'Template added to ' + toCreate[0].set;
  res.redirect('/?page=templates&new=' + firstId + '&lib_msg=' + encodeURIComponent(msg));
});

app.post('/template-edit', (req, res) => {
  const lib = loadLibrary();
  const b = req.body;
  const t = (lib.cardTemplates || []).find(x => x.id === b.id);
  if (!t) return res.redirect('/?page=templates&error=Template+not+found');

  // Update this card's shared fields
  if (b.title !== undefined) t.title = b.title.trim();
  if (b.subtitle !== undefined) t.subtitle = b.subtitle.trim();
  if (b.photos !== undefined) {
    const photos = parsePhotos(b.photos, b.photo);
    if (photos.length) { t.photos = photos; t.photo = photos[0]; }
  } else if (b.photo && b.photo.trim()) {
    t.photo = b.photo.trim(); t.photos = [t.photo];
  }
  if (b.buttonText !== undefined) t.buttonText = b.buttonText.trim() || 'My Photos 📞';

  // Update this card's OWN redirect
  const setNames = getSetNames(lib);
  const ownRedirectKey = 'redirect_' + t.set;
  if (b[ownRedirectKey]) t.redirect = normalizeUrl(b[ownRedirectKey]);
  else if (b.redirect) t.redirect = normalizeUrl(b.redirect);

  // Find all linked cards — by linkGroup first, then fall back to linkedId pair
  const groupMembers = t.linkGroup
    ? (lib.cardTemplates || []).filter(x => x.linkGroup === t.linkGroup && x.id !== t.id)
    : [];
  const legacyPartner = (!t.linkGroup && b.linkedId)
    ? (lib.cardTemplates || []).find(x => x.id === b.linkedId)
    : null;
  const partners = groupMembers.length ? groupMembers : (legacyPartner ? [legacyPartner] : []);

  let synced = 0;
  partners.forEach(partner => {
    partner.title = t.title;
    partner.subtitle = t.subtitle;
    partner.photos = t.photos ? [...t.photos] : [];
    partner.photo = t.photo;
    partner.buttonText = t.buttonText;
    // Update partner's own redirect if a field for its set was submitted
    const partnerRedirectKey = 'redirect_' + partner.set;
    if (b[partnerRedirectKey] && b[partnerRedirectKey].trim()) {
      partner.redirect = normalizeUrl(b[partnerRedirectKey].trim());
    } else if (b.linkedRedirect && b.linkedRedirect.trim() && !t.linkGroup) {
      partner.redirect = normalizeUrl(b.linkedRedirect.trim());
    }
    // Keep legacy linkedId in sync
    partner.linkedId = t.id;
    t.linkedId = partner.id;
    synced++;
  });

  saveLibrary(lib);
  const msg = synced > 0
    ? `Template updated + synced to ${synced} linked card(s) ✅`
    : 'Template updated';
  res.redirect('/?page=templates&lib_msg=' + encodeURIComponent(msg));
});

app.get('/template-duplicate', (req, res) => {
  const lib = loadLibrary();
  const src = (lib.cardTemplates || []).find(t => t.id === req.query.id);
  if (!src) return res.redirect('/?page=templates&error=Template+not+found');
  const toSet = (req.query.to && lib.redirectSets[req.query.to]) ? req.query.to : (src.set === SECOND_SET ? DEFAULT_SET : SECOND_SET);
  const url = normalizeUrl(req.query.url || '');
  if (!url) return res.redirect('/?page=templates&error=' + encodeURIComponent('A gallery URL is required'));
  const photos = (Array.isArray(src.photos) && src.photos.length) ? src.photos.slice() : (src.photo ? [src.photo] : []);
  const dupId = 't' + Date.now() + Math.floor(Math.random() * 1000);
  const dup = {
    id: dupId,
    title: src.title, subtitle: src.subtitle,
    photos, photo: photos[0] || '',
    redirect: url, buttonText: src.buttonText, active: true, set: toSet,
    linkedId: src.id  // link dup → src
  };
  // Also link src → dup (bidirectional)
  src.linkedId = dupId;
  lib.cardTemplates = lib.cardTemplates || [];
  lib.cardTemplates.unshift(dup);
  saveLibrary(lib);
  res.redirect('/?page=templates&new=' + dup.id + '&lib_msg=' + encodeURIComponent('Card duplicated to ' + toSet + ' and linked — edits will sync between them'));
});

app.post('/templates-bulk-active', (req, res) => {
  const lib = loadLibrary();
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const makeActive = !!req.body.active;
  let n = 0;
  (lib.cardTemplates || []).forEach(t => { if (ids.indexOf(t.id) !== -1) { t.active = makeActive; n++; } });
  saveLibrary(lib);
  res.json({ ok: true, updated: n });
});

// Manually link two existing cards (bidirectional)
app.post('/template-link', (req, res) => {
  const lib = loadLibrary();
  const { id, partnerId } = req.body;
  const t = (lib.cardTemplates || []).find(x => x.id === id);
  const partner = (lib.cardTemplates || []).find(x => x.id === partnerId);
  if (!t) return res.json({ ok: false, error: 'Card not found: ' + id });
  if (!partner) return res.json({ ok: false, error: 'Partner card not found: ' + partnerId + ' — check the ID is correct' });
  if (t.set === partner.set) return res.json({ ok: false, error: 'Both cards are in the same set (' + t.set + ') — link one Scrollgallery card to one TheViralBox card' });
  // Clear any old links first
  if (t.linkedId) { const old = lib.cardTemplates.find(x => x.id === t.linkedId); if (old) old.linkedId = undefined; }
  if (partner.linkedId) { const old = lib.cardTemplates.find(x => x.id === partner.linkedId); if (old) old.linkedId = undefined; }
  // Set new bidirectional link
  t.linkedId = partner.id;
  partner.linkedId = t.id;
  saveLibrary(lib);
  res.json({ ok: true });
});

// Unlink a card pair (removes linkedId from both)
app.get('/template-unlink', (req, res) => {
  const lib = loadLibrary();
  const t = (lib.cardTemplates || []).find(x => x.id === req.query.id);
  if (t) {
    if (t.linkedId) {
      const partner = lib.cardTemplates.find(x => x.id === t.linkedId);
      if (partner) partner.linkedId = undefined;
    }
    t.linkedId = undefined;
    saveLibrary(lib);
  }
  res.redirect('/?page=templates&lib_msg=' + encodeURIComponent('Cards unlinked — each now edits independently'));
});

app.get('/template-delete', (req, res) => {
  const lib = loadLibrary();
  lib.cardTemplates = (lib.cardTemplates || []).filter(t => t.id !== req.query.id);
  saveLibrary(lib);
  res.redirect('/?page=templates&lib_msg=' + encodeURIComponent('Template deleted'));
});

// ============================================
// CONTENT MODE
// ============================================
app.post('/master-redirect-on', (req, res) => {
  const s = loadSettings();
  const url = normalizeUrl(req.body.url || '');
  if (!url) return res.redirect('/?page=templates&error=' + encodeURIComponent('Enter a URL first'));
  s.masterRedirect = { enabled: true, url };
  saveSettings(s);
  res.redirect('/?page=templates&lib_msg=' + encodeURIComponent('Master redirect ON → ' + url));
});

app.post('/master-redirect-off', (req, res) => {
  const s = loadSettings();
  const url = (s.masterRedirect && s.masterRedirect.url) || '';
  s.masterRedirect = { enabled: false, url };
  saveSettings(s);
  res.redirect('/?page=templates&lib_msg=' + encodeURIComponent('Master redirect OFF'));
});

app.post('/set-global-mode', (req, res) => {
  const s = loadSettings();
  s.contentMode = req.body.mode === 'templates' ? 'templates' : 'classic';
  saveSettings(s);
  const back = req.body.returnTo === 'templates' ? '/?page=templates' : '/?page=all';
  res.redirect(back + '&lib_msg=' + encodeURIComponent('Global mode set to ' + s.contentMode.toUpperCase()));
});

app.post('/set-page-mode', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const m = req.body.mode;
  updatePage(pageId, { contentMode: (m === 'classic' || m === 'templates') ? m : 'global' });
  res.redirect(req.body.returnTo === 'page' ? `/?page=${encodeURIComponent(pageId)}&saved=1` : '/?saved=1');
});

// ============================================
// SET ACTIVE FROM LIBRARY
// ============================================
app.get('/set-active-from-library', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const lib = loadLibrary();
  const updates = {};
  if (req.query.photoIndex !== undefined) {
    const i = parseInt(req.query.photoIndex);
    if (i >= 0 && i < lib.photos.length) {
      const photo = lib.photos[i];
      updates.currentPhoto = photo; updates.lastPhoto = photo;
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (!photos.includes(photo)) photos.unshift(photo);
      updates.photos = photos;
    }
  }
  if (req.query.redirectIndex !== undefined) {
    const setName = pageSet(page, lib);
    const pool = lib.redirectSets[setName] || [];
    const i = parseInt(req.query.redirectIndex);
    if (i >= 0 && i < pool.length) { updates.whatsapp = pool[i]; updates.lastRedirect = pool[i]; }
  }
  if (Object.keys(updates).length) updatePage(pageId, updates);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// ============================================
// RANDOMIZE
// ============================================
app.post('/randomize-page', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const only = req.query.only;
  const opts = only === 'photo' ? { photo: true, redirect: false } : only === 'redirect' ? { photo: false, redirect: true } : {};
  randomizePage(page, opts);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('/randomize-and-send', (req, res) => {
  const pageId = req.query.page;
  let page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  page = randomizePage(page, {});
  const count = broadcastToPage(page, {});
  res.send(`${renderHead('Randomize + Send')}<div class="container"><div class="card">
    <h2>🎲 Randomized & Broadcasting — ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>.</p>
    <div style="background:#f0f6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px;margin:14px 0;font-size:13px;">
      <div>📸 Photo: <code>${esc(page.currentPhoto || '')}</code></div>
      <div style="margin-top:6px;">🔗 Redirect: <code>${esc(page.whatsapp || '')}</code></div>
    </div>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

app.post('/randomize-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => { const fresh = getPage(p.pageId); if (fresh) randomizePage(fresh, {}); });
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('All ' + pages.length + ' pages randomized'));
});

// ============================================
// RESET STATS
// ============================================
app.post('/reset-stats', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  resetStats(pageId);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('/reset-stats-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => resetStats(p.pageId));
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('All stats reset on ' + pages.length + ' pages'));
});

// ============================================
// FANS
// ============================================
app.post('/add-fan', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  if (req.body.psid) saveFan(pageId, req.body.psid.trim());
  res.redirect(`/?page=${encodeURIComponent(pageId)}`);
});

app.get('/clear-fans', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  saveFansList(pageId, []);
  res.redirect(`/?page=${encodeURIComponent(pageId)}`);
});

app.post('/bulk-add-fans', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  const text = req.body.psids || '';
  const psids = text.split(/[\s,]+/).map(s => s.trim()).filter(s => /^\d{6,}$/.test(s));
  const before = loadFans(pageId).length;
  const combined = [...new Set([...loadFans(pageId), ...psids])];
  saveFansList(pageId, combined);
  const added = combined.length - before;
  res.send(`${renderHead('Bulk Import')}<div class="container"><div class="card">
    <h2>✅ Bulk Import Done</h2>
    <p>Found: <strong>${psids.length}</strong> · Added: <strong>${added}</strong> · Duplicates skipped: <strong>${psids.length - added}</strong> · Total fans: <strong>${combined.length}</strong></p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

app.get('/export-fans', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  const filename = `fans-${pageId}-${new Date().toISOString().split('T')[0]}.txt`;
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(loadFans(pageId).join('\n'));
});

async function importContactsForPage(pageId) {
  const page = getPage(pageId);
  if (!page) throw new Error('Unknown page');
  let all = [];
  let url = `https://graph.facebook.com/v2.6/me/conversations?fields=participants&access_token=${page.accessToken}`;
  while (url) {
    const d = await fetch(url).then(r => r.json());
    if (d.error) throw new Error(d.error.message);
    (d.data || []).forEach(c => (c.participants?.data || []).forEach(p => {
      if (p.id !== page.pageId && !all.includes(p.id)) all.push(p.id);
    }));
    url = d.paging?.next || null;
  }
  const combined = [...new Set([...loadFans(pageId), ...all])];
  saveFansList(pageId, combined);
  if (!page.baselineFans || page.baselineFans === 0) {
    updatePage(pageId, { baselineFans: combined.length });
  }
  return { found: all.length, total: combined.length };
}

app.post('/import-contacts-json', async (req, res) => {
  try {
    const r = await importContactsForPage(req.query.page);
    res.json({ ok: true, found: r.found, total: r.total });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/import-contacts', async (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  try {
    const _imp = await importContactsForPage(pageId);
    res.send(`${renderHead('Import')}<div class="container"><div class="card">
      <h2>✅ Import Complete for ${esc(page.label)}</h2>
      <p>Found: <strong>${_imp.found}</strong> · Total fans: <strong>${_imp.total}</strong></p>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  } catch (e) {
    res.send(`${renderHead('Import Error')}<div class="container"><div class="card">
      <h2>❌ ${esc(e.message)}</h2>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  }
});

// ============================================
// BROADCASTS
// ============================================
app.post('/test-send', async (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const psid = (req.body.psid || '').trim();
  if (!/^\d{6,}$/.test(psid)) {
    return res.send(`${renderHead('Test Send')}<div class="container"><div class="card">
      <h2>❌ Invalid PSID</h2><p>PSID must be at least 6 digits.</p>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  }
  const result = await sendCard(page, psid, { skipRemoval: true });
  if (result && result.error) {
    const errCode = result.error.code || '?';
    const errMsg = result.error.message || 'Unknown error';
    return res.send(`${renderHead('Test Send Failed')}<div class="container"><div class="card" style="border:1px solid #fca5a5;background:#fef2f2;">
      <h2 style="color:#991b1b;">❌ Test Send Failed</h2>
      <p><strong>Code:</strong> ${esc(String(errCode))} · <strong>Message:</strong> ${esc(errMsg)}</p>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  }
  res.send(`${renderHead('Test Send')}<div class="container"><div class="card" style="border:1px solid #86efac;background:#f0fdf4;">
    <h2 style="color:#166534;">✅ Test Card Sent!</h2>
    <p>PSID: ${esc(psid)} · Photo: <a href="${esc(page.currentPhoto)}" target="_blank">${esc(page.currentPhoto)}</a></p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

app.get('/send-now', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const count = broadcastToPage(page, { subtitle: getRotatingSubtitle() });
  res.send(`${renderHead('Broadcast')}<div class="container"><div class="card">
    <h2>📣 Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>, spaced ${page.spacingSeconds || 10}s apart. Est. ~${Math.ceil(count * (page.spacingSeconds || 10) / 60)} min.</p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

app.post('/send-custom', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const count = broadcastToPage(page, { photo: req.body.photo || undefined });
  res.send(`${renderHead('Broadcast')}<div class="container"><div class="card">
    <h2>🚀 Custom Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>.</p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

app.post('/save-text-template', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, { textTemplate: req.body.textTemplate || '' });
  res.redirect(`/?page=${encodeURIComponent(pageId)}&text_saved=1`);
});

app.post('/send-text-now', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const text = (page.textTemplate || '').trim();
  if (!text) return res.redirect(`/?page=${encodeURIComponent(pageId)}&error=${encodeURIComponent('No text template saved.')}`);
  const count = broadcastTextToPage(page, text);
  res.send(`${renderHead('Text Broadcast')}<div class="container"><div class="card">
    <h2>💬 Text Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>.</p>
    <div style="background:#fef3e7;border:1px solid #fde68a;border-radius:8px;padding:12px;margin:14px 0;">
      <div style="font-size:13px;white-space:pre-wrap;">${esc(text)}</div>
    </div>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

const scheduledBroadcasts = {};
app.post('/schedule-once', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const t = new Date(req.body.scheduleTime);
  const delay = t.getTime() - Date.now();
  if (delay <= 0) {
    return res.send(`${renderHead('Schedule')}<div class="container"><div class="card">
      <h2>❌ Time must be in the future!</h2>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  }
  if (scheduledBroadcasts[pageId]) clearTimeout(scheduledBroadcasts[pageId]);
  scheduledBroadcasts[pageId] = setTimeout(() => {
    const p2 = getPage(pageId);
    if (p2) broadcastToPage(p2);
    delete scheduledBroadcasts[pageId];
  }, delay);
  res.send(`${renderHead('Scheduled')}<div class="container"><div class="card">
    <h2>📅 Scheduled for ${esc(page.label)}</h2>
    <p>Will send at: <strong>${esc(t.toLocaleString())}</strong></p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

// ============================================
// MASTER CRON
// ============================================
const broadcastGuard = {};
cron.schedule('* * * * *', () => {
  const pages = loadPages();
  const now = new Date();
  pages.forEach(page => {
    if (!page.broadcastEnabled) return;
    if (!page.broadcastTime || !page.broadcastTime.includes(':')) return;
    const [h, m] = page.broadcastTime.split(':');
    const hh = h.padStart(2, '0');
    const mm = m.padStart(2, '0');
    let curH, curM, curDate;
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: page.timezone || 'UTC',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      const parts = fmt.formatToParts(now);
      curH = parts.find(p => p.type === 'hour').value;
      curM = parts.find(p => p.type === 'minute').value;
      curDate = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
    } catch (e) {
      console.error(`[${page.label}] Bad timezone ${page.timezone}:`, e.message);
      return;
    }
    if (curH === hh && curM === mm && broadcastGuard[page.pageId] !== curDate) {
      broadcastGuard[page.pageId] = curDate;
      console.log(`⏰ [${page.label}] Daily broadcast at ${curH}:${curM} ${page.timezone}`);
      let fresh = page;
      try {
        const lib = loadLibrary();
        if (lib.photos.length || Object.values(lib.redirectSets).some(a => a.length)) {
          fresh = randomizePage(page, {});
        }
      } catch (e) {
        console.error(`[${page.label}] Auto-randomize failed:`, e.message);
      }
      broadcastToPage(fresh, { subtitle: getRotatingSubtitle() });
    }
  });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`✅ messagebot running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_URL || '(not set yet)'}`);
  console.log(`🔒 Admin: ${ADMIN_USER} / ${ADMIN_PASS === 'changeme' ? '⚠️  CHANGE DEFAULT PASSWORD!' : '(set)'}`);
  const pages = loadPages();
  console.log(`📋 Loaded ${pages.length} page(s)`);
  pages.forEach(p => console.log(`   - ${p.label} (${p.pageId}) — broadcast ${p.broadcastEnabled ? 'ON' : 'OFF'} at ${p.broadcastTime} ${p.timezone} · group: ${p.group || 'none'}`));
});
