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
    broadcastEnabled: false,
    spacingSeconds: parseInt(process.env.DEFAULT_SPACING_SECONDS) || 10,
    cleanupThreshold: 0
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
    broadcastEnabled: false,
    sendNowEnabled: data.sendNowEnabled !== undefined ? data.sendNowEnabled : true,
    spacingSeconds: data.spacingSeconds || d.spacingSeconds,
    cleanupThreshold: 0,
    baselineFans: data.baselineFans || 0,
    group: data.group || '',
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
// GROUP-LEVEL SETTINGS (per-group overrides)
// ============================================
function loadGroupConfig() {
  const s = loadSettings();
  return s.groupConfig || {};
}
function getGroupConfig(groupName) {
  if (!groupName) return {};
  const gc = loadGroupConfig();
  return gc[groupName] || {};
}
function saveGroupConfig(groupName, config) {
  const s = loadSettings();
  s.groupConfig = s.groupConfig || {};
  s.groupConfig[groupName] = { ...(s.groupConfig[groupName] || {}), ...config };
  saveSettings(s);
}
function loadGroupSchedules() {
  const s = loadSettings();
  return Array.isArray(s.groupSchedules) ? s.groupSchedules : [];
}
function addGroupSchedule(schedule) {
  const s = loadSettings();
  s.groupSchedules = Array.isArray(s.groupSchedules) ? s.groupSchedules : [];
  s.groupSchedules.push(schedule);
  saveSettings(s);
}
function removeGroupSchedule(id) {
  const s = loadSettings();
  s.groupSchedules = (Array.isArray(s.groupSchedules) ? s.groupSchedules : []).filter(gs => gs.id !== id);
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
  // Group overrides page overrides global
  if (page && page.group) {
    const gc = getGroupConfig(page.group);
    if (gc.contentMode === 'classic' || gc.contentMode === 'templates') {
      return gc.contentMode;
    }
  }
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
  // Group overrides page overrides global
  if (page && page.group) {
    const gc = getGroupConfig(page.group);
    if (gc.sendMode === 'card' || gc.sendMode === 'text' || gc.sendMode === 'card+text') {
      return gc.sendMode;
    }
  }
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
  const runId = 'run_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  broadcastProgress[pageId] = {
    total, done: 0, sent: 0, failed: 0,
    startedAt: Date.now(), finishedAt: null,
    type, status: total > 0 ? 'running' : 'complete',
    runId
  };
  if (total === 0) {
    broadcastProgress[pageId].finishedAt = Date.now();
    persistBroadcastRun(pageId, broadcastProgress[pageId]);
  }
}
function tickBroadcast(pageId, success) {
  const b = broadcastProgress[pageId];
  if (!b) return;
  b.done++;
  if (success) b.sent++; else b.failed++;
  if (b.done >= b.total) {
    b.status = 'complete';
    b.finishedAt = Date.now();
    persistBroadcastRun(pageId, b);
  }
}
function persistBroadcastRun(pageId, b) {
  try {
    const s = loadStats(pageId);
    s.broadcastRuns = s.broadcastRuns || [];
    s.broadcastRuns.push({
      id: b.runId,
      startedAt: new Date(b.startedAt).toISOString(),
      finishedAt: new Date(b.finishedAt).toISOString(),
      total: b.total, sent: b.sent, failed: b.failed, type: b.type
    });
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    s.broadcastRuns = s.broadcastRuns.filter(r => new Date(r.startedAt) > cutoff);
    saveStats(pageId, s);
  } catch (e) { console.error(`[${pageId}] Failed to persist broadcast run:`, e.message); }
}

function broadcastToPage(page, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds || 10) * 1000;
  const effectiveSendMode = opts.textOnly ? 'text' : (opts.forceSendMode || pageSendMode(page));
  const lib = loadLibrary();
  const pool = lib.textPool || [];
  const type = effectiveSendMode === 'text' ? 'text' : effectiveSendMode === 'card+text' ? 'card+text' : 'card';
  startBroadcastTracking(page.pageId, fans.length, type);

  fans.forEach((psid, i) => {
    setTimeout(async () => {
      let success = false;
      try {
        let result;
        if (opts.textOnly && opts.text) {
          result = await sendTextMessage(page, psid, opts.text);
        } else if (effectiveSendMode === 'text') {
          if (pool.length) {
            const text = pool[Math.floor(Math.random() * pool.length)];
            result = await sendText(page, psid, text, opts);
          }
        } else if (effectiveSendMode === 'card+text') {
          result = await sendCard(page, psid, opts);
          if (pool.length) {
            await new Promise(r => setTimeout(r, 1500));
            const text = pool[Math.floor(Math.random() * pool.length)];
            await sendText(page, psid, text, opts);
          }
        } else {
          result = await sendCard(page, psid, opts);
        }
        success = !(result && result.error);
      } catch {}
      tickBroadcast(page.pageId, success);
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
      let success = false;
      try {
        const result = await sendText(page, psid, text, opts);
        success = !(result && result.error);
      } catch {}
      tickBroadcast(page.pageId, success);
    }, i * spacing);
  });
  return fans.length;
}

// ============================================
// GROUP BROADCAST HELPER
// ============================================
function broadcastToGroup(groupName, opts = {}) {
  const pages = loadPages().filter(p => p.group === groupName && p.sendNowEnabled !== false);
  const gc = getGroupConfig(groupName);
  pages.forEach(p => {
    if (opts.randomize) {
      const updated = randomizePage(p);
      broadcastToPage(updated || p, { forceSendMode: gc.sendMode || undefined });
    } else {
      broadcastToPage(p, { forceSendMode: gc.sendMode || undefined });
    }
  });
  return pages.length;
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
// AUTH WALL
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
// PAGE GROUPS MANAGER SECTION
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
        <div style="font-size:11px;color:#7c3aed;">${count} pages · ${fans} fans</div>
      </div>
      <form action="/group-delete" method="POST" style="margin:0;">
        <input type="hidden" name="group" value="${esc(g)}"/>
        <button type="submit" title="Delete group" onclick="return confirm('Delete group &quot;${esc(g)}&quot;? Pages will become unassigned.')" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:16px;padding:0;line-height:1;">×</button>
      </form>
    </div>`;
  }).join('');

  return `
    <div class="card" style="border:2px solid #c4b5fd;padding:0;overflow:hidden;">
      <details>
        <summary style="cursor:pointer;padding:16px 22px;display:flex;align-items:center;gap:10px;user-select:none;list-style:none;">
          <span style="font-size:14px;color:#8b5cf6;transition:transform 0.2s;display:inline-block;" class="bp-arrow">▶</span>
          <span style="font-size:16px;font-weight:700;color:#1a1d2e;">📦 Page Groups</span>
          <span style="font-size:12px;color:#7c3aed;">${groups.length} groups · ${pages.length - unassigned.length} assigned · ${unassigned.length} unassigned</span>
        </summary>
        <div style="padding:0 22px 22px;">
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
        ${pills || '<span style="color:#94a3b8;font-size:13px;">No groups yet — create one below.</span>'}
        ${unassigned.length ? `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;">
          <div style="font-size:13px;color:#94a3b8;">⬜ Unassigned: <strong>${unassigned.length} pages</strong></div>
        </div>` : ''}
      </div>
      <form action="/group-create" method="POST" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="text" name="group" autocomplete="off" placeholder='New group name, e.g. "Part 1"' style="flex:1;min-width:200px;max-width:320px;padding:8px 12px;border:1px solid #c4b5fd;border-radius:6px;font-size:14px;"/>
        <button type="submit" class="btn" style="background:#6d28d9;color:#fff;margin-top:0;">+ Create Group</button>
      </form>
        </div>
      </details>
    </div>`;
}

// ============================================
// PER-GROUP CONTROL PANEL (NEW)
// ============================================
function renderGroupControlPanel(pages) {
  const groups = getAllGroups(pages);
  if (!groups.length) return '';

  const schedules = loadGroupSchedules();
  const sendModeOptions = ['global', 'card', 'text', 'card+text'];
  const sendModeLabels = { 'global': '🌐 Global', 'card': '📷 Card', 'text': '💬 Text', 'card+text': '📷💬 Card+Text' };
  const contentModeOptions = ['global', 'classic', 'templates'];
  const contentModeLabels = { 'global': '🌐 Global', 'classic': '📷 Classic', 'templates': '🎴 Templates' };

  const rows = groups.map(g => {
    const gc = getGroupConfig(g);
    const gPages = pages.filter(p => p.group === g && p.sendNowEnabled !== false);
    const totalFans = gPages.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);
    const curSendMode = gc.sendMode || 'global';
    const curContentMode = gc.contentMode || 'global';
    const dailyTime = gc.dailyTime || '07:30';
    const dailyEnabled = !!gc.dailyEnabled;
    const dailyRandomize = gc.dailyRandomize !== false;

    // One-shot schedules for this group
    const groupOneShots = schedules.filter(s => s.group === g && s.type === 'oneshot');

    const sendModeSelect = `<select name="sendMode" style="padding:6px 8px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;min-width:120px;">
      ${sendModeOptions.map(m => `<option value="${m}" ${curSendMode === m ? 'selected' : ''}>${sendModeLabels[m]}</option>`).join('')}
    </select>`;

    const contentModeSelect = `<select name="contentMode" style="padding:6px 8px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;min-width:120px;">
      ${contentModeOptions.map(m => `<option value="${m}" ${curContentMode === m ? 'selected' : ''}>${contentModeLabels[m]}</option>`).join('')}
    </select>`;

    const oneShotList = groupOneShots.map(s => `
      <div style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:3px 8px;font-size:11px;">
        <span style="color:#1e40af;">📅 ${esc(s.sendAt)}</span>
        ${s.randomize ? '<span style="color:#7c3aed;">🎲</span>' : ''}
        <form action="/cancel-group-schedule" method="POST" style="margin:0;display:inline;">
          <input type="hidden" name="id" value="${esc(s.id)}"/>
          <button type="submit" style="background:none;border:none;color:#dc2626;cursor:pointer;font-size:12px;padding:0;line-height:1;" title="Cancel">×</button>
        </form>
      </div>
    `).join('');

    return `
    <div style="background:#faf5ff;border:2px solid #e9d5ff;border-radius:10px;padding:16px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
        <div style="min-width:120px;">
          <div style="font-size:16px;font-weight:700;color:#6d28d9;">${esc(g)}</div>
          <div style="font-size:11px;color:#8b5cf6;">${gPages.length} pages · ${totalFans} fans</div>
        </div>
        <form action="/send-now-group" method="POST" style="margin:0;display:inline;">
          <input type="hidden" name="group" value="${esc(g)}"/>
          <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Send Now to ${esc(g)}?')">📣 Send</button>
        </form>
        <form action="/send-now-group" method="POST" style="margin:0;display:inline;">
          <input type="hidden" name="group" value="${esc(g)}"/>
          <input type="hidden" name="randomize" value="1"/>
          <button type="submit" class="qbtn" style="background:#7c3aed;" onclick="return confirm('Randomize + Send ${esc(g)}?')">🎲📣 Rand+Send</button>
        </form>
      </div>

      <form action="/save-group-settings" method="POST" style="margin:0;">
        <input type="hidden" name="group" value="${esc(g)}"/>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
          <div>
            <div style="font-size:11px;font-weight:600;color:#6b21a8;margin-bottom:3px;">Send Mode</div>
            ${sendModeSelect}
          </div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#6b21a8;margin-bottom:3px;">Content Mode</div>
            ${contentModeSelect}
          </div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#6b21a8;margin-bottom:3px;">Daily Time</div>
            <input type="time" name="dailyTime" value="${esc(dailyTime)}" style="padding:6px 8px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;width:110px;"/>
          </div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#6b21a8;margin-bottom:3px;">Daily Auto</div>
            <select name="dailyEnabled" style="padding:6px 8px;border:1px solid ${dailyEnabled ? '#86efac' : '#fca5a5'};border-radius:6px;font-size:12px;background:${dailyEnabled ? '#f0fdf4' : '#fef2f2'};font-weight:600;color:${dailyEnabled ? '#166534' : '#991b1b'};">
              <option value="true" ${dailyEnabled ? 'selected' : ''}>▶ ON</option>
              <option value="false" ${!dailyEnabled ? 'selected' : ''}>⏸ OFF</option>
            </select>
          </div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#6b21a8;margin-bottom:3px;">Randomize</div>
            <select name="dailyRandomize" style="padding:6px 8px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;">
              <option value="true" ${dailyRandomize ? 'selected' : ''}>🎲 Yes</option>
              <option value="false" ${!dailyRandomize ? 'selected' : ''}>No</option>
            </select>
          </div>
          <button type="submit" class="qbtn" style="background:#6d28d9;padding:7px 14px;">💾 Save</button>
        </div>
      </form>

      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid #e9d5ff;">
        <form action="/schedule-group-send" method="POST" style="margin:0;display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;">
          <input type="hidden" name="group" value="${esc(g)}"/>
          <div>
            <div style="font-size:10px;font-weight:600;color:#4a5568;">One-shot schedule</div>
            <input type="datetime-local" name="sendAt" style="padding:5px 8px;border:1px solid #bfdbfe;border-radius:6px;font-size:12px;width:190px;"/>
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px;margin:0;cursor:pointer;">
            <input type="checkbox" name="randomize" value="1" checked style="width:auto;"/> 🎲
          </label>
          <button type="submit" class="qbtn" style="background:#2563eb;">📅 Schedule</button>
        </form>
        ${oneShotList ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${oneShotList}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="card" style="border:2px solid #c4b5fd;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        <h2 style="margin:0;border:0;padding:0;">📦 Group Control Panel</h2>
        <form action="/apply-settings-all-groups" method="POST" style="margin:0;">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:600;color:#6b21a8;">Copy from:</span>
            <select name="sourceGroup" style="padding:5px 8px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;">
              ${groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
            </select>
            <button type="submit" class="qbtn" style="background:#6d28d9;" onclick="return confirm('Copy this group\\'s settings (send mode, content mode, daily time, daily on/off) to ALL other groups?')">📋 Apply to All Groups</button>
          </div>
        </form>
      </div>
      ${rows}
    </div>`;
}

// ============================================
// renderPageLibrarySection (unchanged)
// ============================================
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
        <div style="width:100%;font-size:12px;color:#6366f1;margin-bottom:4px;">📷 This page is in <strong>Classic</strong> mode.</div>
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

// ============================================
// renderLibraryManager (with NEW create/delete set)
// ============================================
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
    const isBuiltIn = name === DEFAULT_SET || name === SECOND_SET;
    const color = name === DEFAULT_SET ? '#3a8dde' : name === SECOND_SET ? '#f59e0b' : '#8b5cf6';
    return `
      <div style="margin-top:14px;border:1px solid #e2e8f0;border-left:4px solid ${color};border-radius:8px;padding:12px;background:#fafbfc;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <h4 style="margin:0;font-size:13px;color:#1a1d2e;">🌐 ${esc(name)} <span style="font-weight:400;color:#94a3b8;">(${urls.length} URLs)</span></h4>
          ${!isBuiltIn ? `<form action="/delete-redirect-set" method="POST" style="margin:0;display:inline;">
            <input type="hidden" name="setName" value="${esc(name)}"/>
            <button type="submit" class="qbtn" style="background:#dc2626;font-size:10px;" onclick="return confirm('Delete set &quot;${esc(name)}&quot;? URLs inside will be lost.')">🗑️ Delete Set</button>
          </form>` : ''}
        </div>
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

  // Text Pool
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
            <div style="margin-top:14px;padding:12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;">
              <form action="/create-redirect-set" method="POST" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="font-size:13px;font-weight:600;color:#0369a1;">➕ New Redirect Set:</span>
                <input type="text" name="setName" placeholder='e.g. "MyNewDomain"' style="min-width:200px;max-width:300px;padding:8px;border:1px solid #7dd3fc;border-radius:6px;font-size:14px;"/>
                <button type="submit" class="btn btn-green" style="margin-top:0;">Create Set</button>
              </form>
            </div>
          </div>

          <div style="margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px;">
            <h3 style="margin:0 0 4px;font-size:14px;">🔄 Classic Mode Rotation Pools <span style="font-weight:400;color:#94a3b8;font-size:12px;">— randomize picks one from each pool automatically</span></h3>
            ${[
              { key: 'titles', label: 'Card Titles', emoji: '📝', placeholder: 'Sandra 58 💕\nJennifer 56 🌹', hint: 'One per line — the name shown at the top of the card' },
              { key: 'subtitles', label: 'Card Subtitles', emoji: '💬', placeholder: 'I live alone, may I send you a friend request?', hint: 'One per line — the text under the name' },
              { key: 'buttonTexts', label: 'Button Texts', emoji: '🔘', placeholder: 'My Photos 📞\nCome See Me 💋', hint: 'One per line — the button label fans click' }
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
                  ${chips || '<span style="color:#94a3b8;font-size:12px;">No items yet.</span>'}
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
            <div style="margin-bottom:12px;">${textPoolChips || '<span style="color:#94a3b8;font-size:12px;">No text messages in pool yet.</span>'}</div>
            <form action="/library-add-text-pool" method="POST" style="margin-bottom:10px;">
              <textarea name="texts" placeholder="Paste text messages here — one per line" style="width:100%;min-height:100px;padding:10px;border:1px solid #c7d2fe;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add Text Messages</button>
                <span style="font-size:12px;color:#6b7280;align-self:center;">Currently: <strong>${textPoolItems.length}</strong> messages in pool</span>
              </div>
            </form>
            ${textPoolItems.length > 0 ? `
            <form action="/library-clear-text-pool" method="POST" style="margin-top:4px;">
              <button type="submit" class="btn btn-red" style="font-size:12px;" onclick="return confirm('Remove ALL ${textPoolItems.length} text messages from the pool?')">🗑️ Clear Entire Text Pool (${textPoolItems.length})</button>
            </form>` : ''}
          </div>
        </div>
      </details>
    </div>`;
}

// ============================================
// renderTemplateManager (kept compact - same logic)
// ============================================
function renderTemplateManager(req) {
  const lib = loadLibrary();
  const setNames = getSetNames(lib);
  const templates = lib.cardTemplates || [];
  const setOptions = setNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');

  const sections = setNames.map(setName => {
    const list = templates.filter(t => (t.set || DEFAULT_SET) === setName);
    const color = setName === DEFAULT_SET ? '#3a8dde' : setName === SECOND_SET ? '#f59e0b' : '#8b5cf6';
    const cards = list.map(t => {
      const otherSet = (t.set === SECOND_SET) ? DEFAULT_SET : SECOND_SET;
      const photoCount = (Array.isArray(t.photos) && t.photos.length) ? t.photos.length : (t.photo ? 1 : 0);
      const isActive = t.active !== false;
      const isLinked = !!t.linkedId;
      const partner = isLinked ? templates.find(x => x.id === t.linkedId) : null;
      const linkedBadge = isLinked
        ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:5px;padding:3px 7px;font-size:10px;font-weight:700;color:#166534;margin-bottom:6px;display:flex;align-items:center;gap:4px;">
            🔗 Linked to ${esc(otherSet)} ${partner ? '· <em style="font-weight:400;">' + esc(partner.title || partner.id) + '</em>' : ''}
            <a href="/template-unlink?id=${t.id}" onclick="return confirm('Unlink?')" style="margin-left:auto;color:#dc2626;text-decoration:none;font-weight:700;font-size:12px;">✕</a>
           </div>`
        : `<div style="background:#f1f5f9;border-radius:5px;padding:3px 7px;font-size:10px;color:#94a3b8;margin-bottom:6px;">⬜ Not linked</div>`;
      return `
      <div id="tmpl-${t.id}" style="background:#fff;border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:8px;overflow:hidden;${isActive ? '' : 'opacity:0.5;filter:grayscale(0.7);'}">
        <div style="width:100%;aspect-ratio:1/1;background:#f1f5f9;display:flex;align-items:center;justify-content:center;position:relative;">
          <img src="${esc(t.photo)}" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display='none';this.parentElement.style.color='#94a3b8';this.parentElement.style.fontSize='12px';this.parentElement.textContent='no photo';"/>
          ${photoCount > 1 ? `<span style="position:absolute;top:6px;left:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;">📷 ${photoCount}</span>` : ''}
          ${isLinked ? `<span style="position:absolute;bottom:6px;right:6px;background:rgba(22,163,74,0.9);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:6px;">🔗</span>` : ''}
          ${isActive ? '' : `<span style="position:absolute;top:6px;right:6px;background:#64748b;color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:8px;">PAUSED</span>`}
        </div>
        <div style="padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:#475569;margin-bottom:6px;cursor:pointer;"><input type="checkbox" class="tmpl-sel" value="${t.id}" onclick="event.stopPropagation();" style="width:auto;"/> Select</label>
          ${linkedBadge}
          <div style="font-weight:600;font-size:14px;color:#1a1d2e;">${esc(t.title || '(no title)')}</div>
          <div style="font-size:12px;color:#6b7280;margin:3px 0;">${esc(t.subtitle || '(no subtitle)')}</div>
          <div style="font-size:11px;color:#94a3b8;font-family:monospace;margin-top:4px;word-break:break-all;">🔘 ${esc(t.buttonText)} · 🔗 ${esc((t.redirect || '').replace(/^https?:\/\//, ''))}</div>
          <div style="display:flex;gap:6px;margin-top:10px;">
            <button type="button" class="qbtn" onclick="editTmpl('${t.id}')" style="background:#6366f1;flex:1;">✏️ Edit</button>
            <button type="button" class="qbtn tmpl-dup-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#0ea5e9;">⧉🔗</button>
            ${!isLinked ? `<button type="button" class="qbtn tmpl-link-btn" data-id="${t.id}" data-otherset="${esc(otherSet)}" style="background:#16a34a;">🔗</button>` : ''}
            <a href="/template-delete?id=${t.id}" onclick="return confirm('Delete?')" class="qbtn" style="background:#dc2626;">🗑️</a>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<div style="margin-top:18px;">
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
        <strong>Total: ${templates.length} templates</strong> · ${setNames.map(n => esc(n) + ': ' + templates.filter(t => (t.set||DEFAULT_SET)===n).length).join(' · ')}
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
          <div><label>Card Title</label><input name="title" id="f-title" placeholder="e.g. Elizabeth 56 💕" style="width:100%;"/></div>
        </div>
        <label style="margin-top:10px;">Card Subtitle</label>
        <input name="subtitle" id="f-subtitle" placeholder="e.g. You just seem like someone interesting..." style="width:100%;"/>
        <div style="margin-top:10px;"><label>Button Text</label><input name="buttonText" id="f-button" placeholder="My Photos 📞" style="width:100%;"/></div>
        <label style="margin-top:10px;">Photos</label>
        <input type="hidden" name="photos" id="f-photos" value="[]"/>
        <input type="hidden" name="activePhotos" id="f-active-photos" value="[]"/>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <input type="text" id="f-photo-add" placeholder="https://i.imgur.com/xxxxx.png" style="flex:1;font-family:monospace;font-size:12px;"/>
          <button type="button" class="btn btn-green" style="white-space:nowrap;" onclick="addPhotoToForm()">+ Add photo</button>
        </div>
        <div id="f-photo-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:10px;"></div>
        <div style="margin-top:14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;">
          <div style="font-size:13px;font-weight:700;color:#0369a1;margin-bottom:10px;">🔗 Redirect URLs — one per website</div>
          ${setNames.map(name => {
            const color = name === DEFAULT_SET ? '#3a8dde' : name === SECOND_SET ? '#f59e0b' : '#8b5cf6';
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="background:${color};color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:5px;white-space:nowrap;min-width:110px;text-align:center;">${esc(name)}</span>
              <input name="redirect_${esc(name)}" id="f-redirect-${esc(name)}" placeholder="https://..." style="flex:1;font-family:monospace;font-size:12px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;"/>
            </div>`;
          }).join('')}
        </div>
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
        <button type="button" class="btn" style="background:#f59e0b;color:#fff;" onclick="bulkSetActive(false)">⏸️ Pause</button>
        <button type="button" class="btn" style="background:#16a34a;color:#fff;" onclick="bulkSetActive(true)">▶️ Activate</button>
        <button type="button" class="btn" style="background:#e2e8f0;color:#475569;" onclick="selectAllTmpls(true)">Select all</button>
        <button type="button" class="btn" style="background:#e2e8f0;color:#475569;" onclick="selectAllTmpls(false)">Clear</button>
        <span id="sel-count" style="font-size:12px;color:#94a3b8;font-weight:600;"></span>
      </div>
      ${sections}
    </div>
    <script>
    var TEMPLATES = ${JSON.stringify(templates)};
    function fillFromRow(){var raw=document.getElementById('f-rawrow').value.trim();if(!raw)return alert('Paste a row first.');var d=raw.includes('\\t')?'\\t':',';var parts=raw.split(d).map(function(s){return s.trim();}).filter(Boolean);if(parts.length>=1)document.getElementById('f-title').value=parts[0];if(parts.length>=2)document.getElementById('f-subtitle').value=parts[1];if(parts.length>=3)document.getElementById('f-button').value=parts[2];var urls=parts.filter(function(s){return s.match(/^https?:\\/\\//i);});if(urls.length>0){var cur=getFormPhotos();urls.forEach(function(u){if(u.match(/imgur|i\\.imgur|ibb|postimg|imgbb/i)){if(cur.indexOf(u)<0)cur.push(u);}});setFormPhotos(cur);var nonPhoto=urls.filter(function(u){return !u.match(/imgur|i\\.imgur|ibb|postimg|imgbb/i);});${setNames.map((n,idx)=>`if(nonPhoto.length>${idx})try{document.getElementById('f-redirect-${n}').value=nonPhoto[${idx}];}catch(e){}`).join('')}}}
    function getFormPhotos(){try{return JSON.parse(document.getElementById('f-photos').value);}catch(e){return [];}}
    function getFormActivePhotos(){try{return JSON.parse(document.getElementById('f-active-photos').value);}catch(e){return [];}}
    function setFormPhotos(a){document.getElementById('f-photos').value=JSON.stringify(a);renderPhotoGrid();}
    function setFormActivePhotos(a){document.getElementById('f-active-photos').value=JSON.stringify(a);renderPhotoGrid();}
    function addPhotoToForm(){var u=document.getElementById('f-photo-add').value.trim();if(!u)return;var a=getFormPhotos();if(a.indexOf(u)<0)a.push(u);setFormPhotos(a);document.getElementById('f-photo-add').value='';}
    function renderPhotoGrid(){var p=getFormPhotos(),a=getFormActivePhotos(),w=document.getElementById('f-photo-grid');w.innerHTML=p.map(function(u,i){var on=a.length===0||a.indexOf(u)>=0;return '<div style="background:#f7f8fc;border:1px solid '+(on?'#16a34a':'#e2e8f0')+';border-radius:8px;overflow:hidden;opacity:'+(on?'1':'0.4')+'"><img src="'+u+'" style="width:100%;height:120px;object-fit:cover;" onerror="this.style.display=\\'none\\'"/><div style="padding:6px;display:flex;gap:4px;"><button type="button" class="ph-btn ph-active" onclick="togglePhotoActive('+i+')">'+(on?'✓ On':'Off')+'</button><button type="button" class="ph-btn ph-remove" onclick="removeFormPhoto('+i+')">×</button></div></div>';}).join('');}
    function removeFormPhoto(i){var a=getFormPhotos(),r=a.splice(i,1)[0];setFormPhotos(a);setFormActivePhotos(getFormActivePhotos().filter(function(u){return u!==r;}));}
    function togglePhotoActive(i){var p=getFormPhotos(),a=getFormActivePhotos(),u=p[i];if(a.length===0)a=p.filter(function(x){return x!==u;});else{var pos=a.indexOf(u);if(pos>=0)a.splice(pos,1);else a.push(u);if(a.length===0)a=p.slice();}setFormActivePhotos(a);}
    function editTmpl(id){var t=TEMPLATES.find(function(x){return x.id===id;});if(!t)return;document.getElementById('form-title').textContent='✏️ Editing: '+(t.title||t.id);document.getElementById('f-id').value=t.id;document.getElementById('f-title').value=t.title||'';document.getElementById('f-subtitle').value=t.subtitle||'';document.getElementById('f-button').value=t.buttonText||'';document.getElementById('f-redirect').value=t.redirect||'';${setNames.map(n=>`try{document.getElementById('f-redirect-${n}').value=t.set==='${n}'?(t.redirect||''):'';}catch(e){}`).join('')}setFormPhotos(Array.isArray(t.photos)?t.photos:(t.photo?[t.photo]:[]));setFormActivePhotos(Array.isArray(t.activePhotos)?t.activePhotos:[]);document.getElementById('f-submit').textContent='💾 Save';document.getElementById('f-cancel').style.display='inline-block';if(t.linkedId){document.getElementById('f-linked-block').style.display='block';document.getElementById('f-linked-id').value=t.linkedId;}document.getElementById('tmpl-form').scrollIntoView({behavior:'smooth'});}
    function resetForm(){document.getElementById('form-title').textContent='➕ Add New Template';document.getElementById('f-id').value='';document.getElementById('f-title').value='';document.getElementById('f-subtitle').value='';document.getElementById('f-button').value='';document.getElementById('f-redirect').value='';${setNames.map(n=>`try{document.getElementById('f-redirect-${n}').value='';}catch(e){}`).join('')}setFormPhotos([]);setFormActivePhotos([]);document.getElementById('f-submit').textContent='➕ Add Template';document.getElementById('f-cancel').style.display='none';document.getElementById('f-linked-block').style.display='none';}
    function validateTmplForm(){if(!document.getElementById('f-title').value.trim()){alert('Title required.');return false;}return true;}
    function selectAllTmpls(on){document.querySelectorAll('.tmpl-sel').forEach(function(c){c.checked=on;});updateSelCount();}
    function updateSelCount(){var c=document.querySelectorAll('.tmpl-sel:checked').length;document.getElementById('sel-count').textContent=c>0?c+' selected':'';}
    function bulkSetActive(a){var ids=[];document.querySelectorAll('.tmpl-sel:checked').forEach(function(c){ids.push(c.value);});if(!ids.length)return alert('None selected.');if(!confirm((a?'Activate':'Pause')+' '+ids.length+' card(s)?'))return;var f=document.createElement('form');f.method='POST';f.action='/template-bulk-active';ids.forEach(function(id){var i=document.createElement('input');i.type='hidden';i.name='ids';i.value=id;f.appendChild(i);});var i2=document.createElement('input');i2.type='hidden';i2.name='active';i2.value=a?'true':'false';f.appendChild(i2);document.body.appendChild(f);f.submit();}
    document.addEventListener('click',function(e){if(e.target.classList.contains('tmpl-sel'))updateSelCount();var dup=e.target.closest('.tmpl-dup-btn');if(dup){if(confirm('Duplicate + link to "'+dup.dataset.otherset+'"?'))window.location.href='/template-duplicate-linked?id='+dup.dataset.id+'&toSet='+encodeURIComponent(dup.dataset.otherset);return;}var lk=e.target.closest('.tmpl-link-btn');if(lk){openLinkPicker(lk.dataset.id,lk.dataset.otherset);return;}});
    function openLinkPicker(thisId,otherSet){var cands=TEMPLATES.filter(function(t){return(t.set||'${DEFAULT_SET}')===otherSet&&!t.linkedId&&t.id!==thisId;});if(!cands.length)return alert('No available cards in "'+otherSet+'".');var list=cands.map(function(t){return '<div style="padding:8px;border-bottom:1px solid #e2e8f0;cursor:pointer;" onclick="doLink(\\''+thisId+'\\',\\''+t.id+'\\')"><strong>'+escH(t.title)+'</strong></div>';}).join('');var o=document.createElement('div');o.id='link-overlay';o.innerHTML='<div style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)this.remove()"><div style="background:#fff;border-radius:12px;padding:20px;max-width:400px;width:90%;max-height:70vh;overflow-y:auto;"><h3>🔗 Link to '+escH(otherSet)+'</h3>'+list+'<button onclick="this.closest(\\'#link-overlay\\').remove()" class="btn" style="margin-top:12px;width:100%;">Cancel</button></div></div>';document.body.appendChild(o);}
    function doLink(a,b){var e=document.getElementById('link-overlay');if(e)e.remove();window.location.href='/template-link?from='+a+'&to='+b;}
    function escH(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
    renderPhotoGrid();
    </script>
  </div>`;
}

// ============================================
// ALL PAGES VIEW (with NEW group control panel)
// ============================================
function renderAllPagesView(pages, req) {
  const todayStr = new Date().toISOString().split('T')[0];
  const globalMode = getGlobalContentMode();
  const globalSendMode = getGlobalSendMode();

  const rows = pages.map(p => {
    const fans = loadFans(p.pageId);
    const stats = loadStats(p.pageId);
    const clicks = stats.clicks || [];
    const dailyClicks = clicks.filter(c => (c.time || '').startsWith(todayStr)).length;
    const dailySent = (stats.dailyMessages || {})[todayStr]?.sent || 0;
    const dailyFailed = (stats.dailyMessages || {})[todayStr]?.failed || 0;
    const todayRuns = (stats.broadcastRuns || []).filter(r => (r.startedAt || '').startsWith(todayStr));
    const liveBp = broadcastProgress[p.pageId];
    const liveRun = liveBp && liveBp.status === 'running' ? liveBp : null;
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
    const bp = broadcastProgress[p.pageId];
    const isRunning = bp && bp.status === 'running';
    const justFinished = bp && bp.status === 'complete' && bp.finishedAt && (Date.now() - bp.finishedAt < 300000);
    const pct = isRunning ? Math.round(bp.done / bp.total * 100) : 0;
    let statusCell;
    if (isRunning) {
      statusCell = `<div><div style="font-size:11px;font-weight:700;color:#1e40af;">📡 ${bp.done}/${bp.total}</div><div style="background:#bfdbfe;border-radius:4px;height:6px;width:80px;margin-top:3px;overflow:hidden;"><div style="background:#3a8dde;height:100%;width:${pct}%;border-radius:4px;"></div></div></div>`;
    } else if (justFinished) {
      statusCell = `<div><div style="font-size:11px;font-weight:700;color:#166534;">✅ ${bp.total}</div></div>`;
    } else {
      statusCell = `<span class="badge ${p.broadcastEnabled ? 'badge-green' : 'badge-gray'}">${p.broadcastEnabled ? 'Auto ON' : 'Auto OFF'}</span>${sNow ? '' : ' <span class="badge badge-gray">Send ⏸</span>'}`;
    }
    return `<tr>
      <td><a href="/?page=${esc(p.pageId)}" style="font-weight:600;text-decoration:none;color:#3a8dde;">${esc(p.label)}</a><div style="font-size:10px;color:#94a3b8;font-family:monospace;">${esc(p.pageId)}</div></td>
      <td>${group}</td>
      <td>${fans.length}</td>
      <td>${(function(){
        let lines=[];
        todayRuns.forEach(r=>{const t=new Date(r.startedAt);lines.push('<div style="font-size:11px;line-height:1.6;"><span style="color:#94a3b8;">'+String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0')+'</span> <span style="color:#166534;font-weight:600;">'+r.sent+'✅</span> <span style="color:#dc2626;font-weight:600;">'+r.failed+'❌</span></div>');});
        if(liveRun)lines.push('<div style="font-size:11px;"><span style="color:#6366f1;">📡 '+liveRun.sent+'✅ '+liveRun.failed+'❌</span> ('+liveRun.done+'/'+liveRun.total+')</div>');
        if(!lines.length){if(dailySent||dailyFailed)return '<span style="color:#166534;font-weight:600;">'+dailySent+'✅</span> <span style="color:#dc2626;">'+dailyFailed+'❌</span>';return '<span style="color:#cbd5e1;">—</span>';}
        return lines.join('');
      })()}</td>
      <td>${dailyClicks}</td>
      <td>${modeBadge} ${sendModeBadge}</td>
      <td>${statusCell}</td>
      <td><div class="actions">
        <form action="/send-now-page" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-send" ${sNow ? '' : 'disabled style="opacity:0.4;"'}>📣</button></form>
        <form action="/${p.broadcastEnabled ? 'pause' : 'resume'}-page" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn ${p.broadcastEnabled ? 'qbtn-pause' : 'qbtn-resume'}">${p.broadcastEnabled ? '⏸' : '▶'}</button></form>
      </div></td>
    </tr>`;
  }).join('');

  const eligibleAll = pages.filter(p => p.sendNowEnabled !== false);
  const allFans = eligibleAll.reduce((acc, p) => acc + loadFans(p.pageId).length, 0);

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}

    <div style="margin-bottom:18px;">
      <div class="stat" style="display:inline-block;"><div class="v">${pages.length}</div><div class="l">Pages</div></div>
    </div>

    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;background:#fff;border-radius:8px;padding:10px 14px;box-shadow:0 1px 3px rgba(0,0,0,0.06);display:flex;gap:8px;align-items:center;">
        <textarea id="bulk-pages-input" rows="1" placeholder="Paste rows: Name TAB PageID TAB Token (one per line)" style="flex:1;font-family:monospace;font-size:12px;padding:6px 8px;border:1px solid #86efac;border-radius:6px;resize:none;min-height:34px;max-height:120px;"></textarea>
        <button type="button" class="qbtn" style="background:#16a34a;" onclick="parseBulkPages()">🔍 Preview</button>
        <button type="button" id="bulk-add-btn" class="qbtn" style="background:#15803d;display:none;" onclick="submitBulkPages()">➕ Add</button>
        <span id="bulk-status" style="font-size:12px;font-weight:600;"></span>
      </div>
    </div>
    <div id="bulk-preview" style="margin-bottom:12px;"></div>
    <script>
      var bulkParsed=[];
      function parseBulkPages(){var raw=document.getElementById('bulk-pages-input').value||'';if(!raw.trim())return;var TAB=String.fromCharCode(9),NL=String.fromCharCode(10);var allCells=raw.replace(/\\r/g,'').split(new RegExp('['+TAB+NL+']')).map(function(c){return c.trim();}).filter(function(c){return c.length>0;});function isAllDigits(s){if(s.length<8)return false;for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c<48||c>57)return false;}return true;}function extractDigits(s){var best='',cur='';for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c>=48&&c<=57)cur+=s[i];else{if(cur.length>best.length)best=cur;cur='';}}if(cur.length>best.length)best=cur;return best.length>=8?best:null;}function isToken(s){return s.length>10&&s.slice(0,3).toUpperCase()==='EAA';}var tokens=[],pageIds=[],names=[];allCells.forEach(function(c){if(isToken(c))tokens.push(c);else if(isAllDigits(c))pageIds.push(c);else{var f=extractDigits(c);if(f){pageIds.push(f);var nm=c.replace(f,'').trim();if(nm)names.push(nm);}else names.push(c);}});bulkParsed=[];var count=Math.max(tokens.length,pageIds.length);if(count===0){document.getElementById('bulk-status').textContent='Nothing recognized';document.getElementById('bulk-preview').innerHTML='';document.getElementById('bulk-add-btn').style.display='none';return;}for(var i=0;i<count;i++){if(!pageIds[i]||!tokens[i])continue;bulkParsed.push({name:names[i]||'Page '+pageIds[i],pageId:pageIds[i],token:tokens[i]});}var preview=document.getElementById('bulk-preview'),status=document.getElementById('bulk-status'),addBtn=document.getElementById('bulk-add-btn');if(bulkParsed.length){status.style.color='#16a34a';status.textContent=bulkParsed.length+' ready';addBtn.style.display='inline-block';addBtn.textContent='Add '+bulkParsed.length;}else{status.style.color='#dc2626';status.textContent='Errors';addBtn.style.display='none';}}
      function submitBulkPages(){if(!bulkParsed.length)return;var btn=document.getElementById('bulk-add-btn'),status=document.getElementById('bulk-status');btn.disabled=true;status.textContent='Saving...';fetch('/bulk-add-pages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pages:bulkParsed})}).then(function(r){return r.json();}).then(function(d){if(d.ok){status.style.color='#16a34a';status.textContent=d.added+' added';setTimeout(function(){location.reload();},1200);}else{status.style.color='#dc2626';status.textContent='Error';btn.disabled=false;}}).catch(function(e){status.style.color='#dc2626';status.textContent='Error';btn.disabled=false;});}
    </script>

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;background:#1a1d2e;border-radius:8px;padding:12px 16px;">
      <span style="font-size:12px;font-weight:700;color:#a5b4fc;text-transform:uppercase;">All Pages</span>
      <button type="button" class="qbtn" style="background:#dc2626;" onclick="clearAllFans()">🗑️ Clear ALL Fans</button>
      <button type="button" class="qbtn" style="background:#2563eb;" onclick="importAllPages()">📥 Import ALL Pages</button>
      <button type="button" class="qbtn" style="background:#7c3aed;" onclick="triggerRedeploy()">🔄 Redeploy Railway</button>
      <span id="bulk-ops-status" style="font-size:13px;font-weight:600;color:#a5b4fc;"></span>
    </div>
    <script>
      var allPageIds=${JSON.stringify(pages.map(p=>p.pageId))};
      function clearAllFans(){if(!confirm('CLEAR ALL FANS?'))return;if(!confirm('Are you sure?'))return;var s=document.getElementById('bulk-ops-status');s.textContent='Clearing...';fetch('/clear-all-fans',{method:'POST',headers:{'Content-Type':'application/json'}}).then(function(r){return r.json();}).then(function(d){if(d.ok){s.style.color='#16a34a';s.textContent='Cleared '+d.cleared;setTimeout(function(){location.reload();},1500);}}).catch(function(e){s.textContent='Error';});}
      function importAllPages(){if(!confirm('Import contacts for ALL pages?'))return;var s=document.getElementById('bulk-ops-status');var BATCH=20,done=0,failed=0,processed=0,total=allPageIds.length;var batches=[];for(var i=0;i<total;i+=BATCH)batches.push(allPageIds.slice(i,i+BATCH));var bIdx=0;function runBatch(){if(bIdx>=batches.length){s.style.color='#16a34a';s.textContent='Done — '+done+' imported, '+failed+' failed';return;}var batch=batches[bIdx++];s.textContent='Batch '+bIdx+'/'+batches.length;fetch('/import-contacts-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageIds:batch})}).then(function(r){return r.json();}).then(function(d){if(d&&d.results)d.results.forEach(function(r){processed++;if(r.ok)done++;else failed++;});runBatch();}).catch(function(){processed+=batch.length;failed+=batch.length;runBatch();});}runBatch();}
      function triggerRedeploy(){if(!confirm('Redeploy now?'))return;var s=document.getElementById('bulk-ops-status');s.textContent='Deploying...';fetch('/redeploy',{method:'POST'}).then(function(r){return r.json();}).then(function(d){if(d.ok)s.textContent='Triggered — restarting in ~30s';else s.textContent='Failed: '+(d.error||'check env vars');}).catch(function(e){s.textContent='Error';});}
    </script>

    ${renderGroupManager(pages)}
    ${renderGroupControlPanel(pages)}

    <div style="margin-bottom:12px;padding:14px;background:#f0fdf4;border:2px solid #86efac;border-radius:8px;">
      <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:10px;">📣 Quick Actions</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <form action="/send-now-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#166534;" onclick="return confirm('SEND ALL ${eligibleAll.length} pages (${allFans} fans)?')">📣 Send All (${eligibleAll.length})</button></form>
        <form action="/send-now-all?randomize=1" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#5b21b6;" onclick="return confirm('Randomize + Send ALL?')">🎲📣 Rand + Send All</button></form>
        <span style="color:#cbd5e1;font-size:18px;">|</span>
        <form action="/pause-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#f59e0b;" onclick="return confirm('Pause daily on ALL?')">⏸ Pause All Auto</button></form>
        <form action="/resume-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#28a745;" onclick="return confirm('Resume daily on ALL?')">▶ Resume All Auto</button></form>
        <form action="/randomize-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#8b5cf6;" onclick="return confirm('Randomize all?')">🎲 Randomize All</button></form>
        <form action="/reset-stats-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#dc3545;" onclick="return confirm('Reset ALL stats?')">🗑️ Reset All Stats</button></form>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <form action="/pause-sendnow-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#f59e0b;">🚫 Pause Send Now (All)</button></form>
        <form action="/resume-sendnow-all" method="POST" style="margin:0;"><button type="submit" class="qbtn" style="background:#16a34a;">✅ Resume Send Now (All)</button></form>
        <span style="color:#cbd5e1;font-size:18px;">|</span>
        <form action="/set-spacing-all" method="POST" style="margin:0;display:flex;gap:6px;align-items:center;">
          <span style="font-size:12px;font-weight:700;color:#166534;">⏱️</span>
          ${renderSpacingSelect('spacingSeconds', pages[0]?.spacingSeconds || 10)}
          <button type="submit" class="qbtn" style="background:#0f766e;" onclick="return confirm('Set spacing on ALL?')">Apply All</button>
        </form>
        <span style="color:#cbd5e1;font-size:18px;">|</span>
        <form action="/set-cleanup-all" method="POST" style="margin:0;display:flex;gap:6px;align-items:center;">
          <span style="font-size:12px;font-weight:700;color:#166534;">🛡️</span>
          <select name="cleanupThreshold" style="padding:7px;border:1px solid #86efac;border-radius:6px;font-size:12px;">
            ${[{v:0,l:'0 — Never'},{v:1,l:'1 fail'},{v:2,l:'2 fails'},{v:3,l:'3 fails'},{v:5,l:'5 fails'},{v:10,l:'10 fails'}].map(o=>'<option value="'+o.v+'">'+o.l+'</option>').join('')}
          </select>
          <button type="submit" class="qbtn" style="background:#0f766e;" onclick="return confirm('Apply to ALL?')">Apply All</button>
        </form>
      </div>
    </div>

    ${renderLibraryManager()}

    <div style="margin-bottom:12px;padding:12px;background:#faf5ff;border:2px solid #e9d5ff;border-radius:8px;">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:700;color:#6b21a8;">🎚️ Global Card Source:</span>
        <form action="/set-global-mode" method="POST" style="margin:0;"><input type="hidden" name="mode" value="classic"/><button type="submit" class="qbtn" style="background:${globalMode === 'classic' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'classic' ? '#fff' : '#475569'};">${globalMode === 'classic' ? '✓ ' : ''}📷 Classic</button></form>
        <form action="/set-global-mode" method="POST" style="margin:0;"><input type="hidden" name="mode" value="templates"/><button type="submit" class="qbtn" style="background:${globalMode === 'templates' ? '#16a34a' : '#cbd5e1'};color:${globalMode === 'templates' ? '#fff' : '#475569'};">${globalMode === 'templates' ? '✓ ' : ''}🎴 Templates</button></form>
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:700;color:#6b21a8;">📤 Global Send Mode:</span>
        ${['card', 'text', 'card+text'].map(m => {
          const labels = { 'card': '📷 Card', 'text': '💬 Text', 'card+text': '📷💬 Card+Text' };
          const active = globalSendMode === m;
          return `<form action="/set-global-send-mode" method="POST" style="margin:0;"><input type="hidden" name="mode" value="${m}"/><button type="submit" class="qbtn" style="background:${active ? '#16a34a' : '#cbd5e1'};color:${active ? '#fff' : '#475569'};">${active ? '✓ ' : ''}${labels[m]}</button></form>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <h2>📊 All Pages</h2>
      <div style="overflow-x:auto;">
      <table>
        <tr><th>Label</th><th>Group</th><th>Fans</th><th>Messages</th><th>Clicks</th><th>Mode</th><th>Status</th><th></th></tr>
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
        <select name="group"><option value="">(No group)</option>${getAllGroups(pages).map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select>
        <button type="submit" class="btn btn-green" style="margin-top:12px;">➕ Add Page</button>
      </form>
    </div>

    <div class="card" style="border:2px solid #bae6fd;">
      <h2>☁️ Backup / Restore</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="/backup" class="btn btn-blue" download="messagebot-backup.json">⬇️ Download Backup</a>
      </div>
      <form action="/restore-backup" method="POST" enctype="multipart/form-data" style="margin-top:12px;">
        <label>⬆️ Restore from backup JSON</label>
        <input type="file" name="backupFile" accept=".json" style="margin-top:4px;"/>
        <button type="submit" class="btn btn-orange" onclick="return confirm('Restore? This replaces all data.')">⬆️ Restore</button>
      </form>
    </div>

    <div class="card" style="border:2px solid #b5d4f4;background:#eef6ff;">
      <h2 style="color:#0c447c;">📋 Facebook Developer Setup</h2>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        <span style="font-size:11px;color:#0c447c;font-weight:600;min-width:100px;">Callback URL</span>
        <input type="text" id="webhook-url" value="${esc(PUBLIC_URL)}/webhook" readonly onclick="this.select();" style="flex:1;min-width:240px;padding:6px 10px;font-family:monospace;font-size:12px;"/>
        <button type="button" onclick="(function(b){var i=document.getElementById('webhook-url');i.select();document.execCommand('copy');b.innerText='✓';setTimeout(function(){b.innerText='📋 Copy';},1200);})(this)" style="padding:6px 12px;background:#3a8dde;color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer;">📋 Copy</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-size:11px;color:#0c447c;font-weight:600;min-width:100px;">Verify Token</span>
        <input type="text" id="verify-token" value="${esc(VERIFY_TOKEN)}" readonly onclick="this.select();" style="flex:1;min-width:240px;padding:6px 10px;font-family:monospace;font-size:12px;"/>
        <button type="button" onclick="(function(b){var i=document.getElementById('verify-token');i.select();document.execCommand('copy');b.innerText='✓';setTimeout(function(){b.innerText='📋 Copy';},1200);})(this)" style="padding:6px 12px;background:#3a8dde;color:#fff;border:none;border-radius:5px;font-size:11px;cursor:pointer;">📋 Copy</button>
      </div>
    </div>
  </div>`;
}

// ============================================
// renderPageView (single page - unchanged)
// ============================================
function renderPageView(page, req) {
  const pid = esc(page.pageId);
  const fans = loadFans(page.pageId);
  const stats = loadStats(page.pageId);
  const clicks = stats.clicks || [];
  const reads = stats.reads || [];
  const fansAdded = stats.fansAdded || [];
  const dailyStats = getRecentDailyStats(page.pageId, 14);
  const todayStr = todayDate();
  const todayClicks = clicks.filter(c => (c.time || '').startsWith(todayStr)).length;
  const todaySent = dailyStats[0]?.sent || 0;
  const todayFailed = dailyStats[0]?.failed || 0;
  const mode = pageContentMode(page);
  const pSendMode = pageSendMode(page);
  const groups = getAllGroups();
  const bp = broadcastProgress[page.pageId];

  const dailyChart = dailyStats.reverse().map(d => {
    const max = Math.max(...dailyStats.map(x => x.sent + x.failed), 1);
    const h = Math.round(((d.sent + d.failed) / max) * 80);
    const failH = Math.round((d.failed / max) * 80);
    const label = d.date.slice(5);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;flex:1;">
      <div style="height:80px;display:flex;flex-direction:column-reverse;gap:0;">
        <div style="width:14px;background:#22c55e;border-radius:2px 2px 0 0;height:${h - failH}px;"></div>
        <div style="width:14px;background:#ef4444;border-radius:0;height:${failH}px;"></div>
      </div>
      <div style="font-size:9px;color:#94a3b8;writing-mode:vertical-rl;transform:rotate(180deg);height:40px;overflow:hidden;">${label}</div>
    </div>`;
  }).join('');

  const broadcastRuns = (stats.broadcastRuns || []).slice(-5).reverse();
  const runsHtml = broadcastRuns.map(r => {
    const t = new Date(r.startedAt);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const date = r.startedAt.split('T')[0];
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:12px;">
      <span style="color:#94a3b8;min-width:90px;">${date} ${time}</span>
      <span style="color:#166534;font-weight:600;">${r.sent}✅</span>
      <span style="color:#dc2626;">${r.failed}❌</span>
      <span style="color:#94a3b8;">/ ${r.total}</span>
      <span class="badge" style="${r.type === 'text' ? 'background:#fce7f3;color:#be185d;' : r.type === 'card+text' ? 'background:#ecfdf5;color:#166534;' : 'background:#dbeafe;color:#2563eb;'}font-size:10px;">${r.type || 'card'}</span>
    </div>`;
  }).join('') || '<div style="color:#94a3b8;font-size:12px;">No runs yet today.</div>';

  const liveProgress = bp && bp.status === 'running'
    ? `<div class="alert" style="background:#dbeafe;color:#1e40af;border:1px solid #93c5fd;">
        <div style="font-weight:700;">📡 Broadcast in progress — ${bp.done}/${bp.total} (${Math.round(bp.done/bp.total*100)}%)</div>
        <div style="background:#bfdbfe;border-radius:4px;height:8px;margin-top:6px;overflow:hidden;"><div style="background:#3a8dde;height:100%;width:${Math.round(bp.done/bp.total*100)}%;border-radius:4px;transition:width 0.3s;"></div></div>
        <div style="font-size:12px;margin-top:4px;">✅ ${bp.sent} sent · ❌ ${bp.failed} failed · ${bp.type || 'card'}</div>
        <script>setTimeout(function(){ location.reload(); }, 5000);</script>
      </div>`
    : '';

  return `<div class="container">
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}
    ${liveProgress}
    <div class="card">
      <h2>${esc(page.label)} <span style="font-size:12px;color:#94a3b8;font-weight:400;">${esc(page.pageId)}</span></h2>
      <div class="grid">
        <div class="stat"><div class="v">${fans.length}</div><div class="l">Fans</div></div>
        <div class="stat"><div class="v">${todaySent}</div><div class="l">Sent today</div></div>
        <div class="stat"><div class="v">${todayClicks}</div><div class="l">Clicks today</div></div>
        <div class="stat" style="border-color:${todayFailed ? '#dc3545' : '#e5e7eb'};"><div class="v" style="color:${todayFailed ? '#dc3545' : '#1a1d2e'}">${todayFailed}</div><div class="l">Failed today</div></div>
        <div class="stat"><div class="v">${stats.messagesSent || 0}</div><div class="l">Total sent</div></div>
        <div class="stat"><div class="v">${clicks.length}</div><div class="l">Total clicks</div></div>
      </div>
      <div style="margin-top:16px;">
        <h3 style="font-size:14px;margin-bottom:8px;">📈 Daily Activity (14 days)</h3>
        <div style="display:flex;align-items:flex-end;gap:3px;background:#f7f8fc;padding:10px;border-radius:8px;min-height:100px;">
          ${dailyChart}
        </div>
      </div>
      <div style="margin-top:16px;">
        <h3 style="font-size:14px;margin-bottom:4px;">📡 Recent Broadcasts</h3>
        ${runsHtml}
      </div>
    </div>

    ${renderPageLibrarySection(page)}

    <div class="card">
      <h2>⚙️ Page Settings</h2>
      <form action="/update-page" method="POST">
        <input type="hidden" name="pageId" value="${pid}"/>
        <div class="row">
          <div><label>Label</label><input name="label" value="${esc(page.label)}"/></div>
          <div><label>Group</label>
            <select name="group">
              <option value="">(No group)</option>
              ${groups.map(g => `<option value="${esc(g)}" ${page.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="row">
          <div><label>Title</label><input name="title" value="${esc(page.title)}"/></div>
          <div><label>Subtitle</label><input name="subtitle" value="${esc(page.subtitle)}"/></div>
        </div>
        <div class="row">
          <div><label>Button Text</label><input name="buttonText" value="${esc(page.buttonText)}"/></div>
          <div><label>Redirect URL</label><input name="whatsapp" value="${esc(page.whatsapp)}"/></div>
        </div>
        <div class="row">
          <div><label>Broadcast Time</label><input type="time" name="broadcastTime" value="${esc(page.broadcastTime)}"/></div>
          <div><label>Spacing</label>${renderSpacingSelect('spacingSeconds', page.spacingSeconds)}</div>
        </div>
        <div class="row">
          <div><label>Auto-cleanup threshold</label>
            <select name="cleanupThreshold">
              ${[{v:0,l:'0 — Never auto-remove'},{v:1,l:'1 consecutive failure'},{v:2,l:'2 consecutive failures'},{v:3,l:'3 consecutive failures'},{v:5,l:'5 consecutive failures'},{v:10,l:'10 consecutive failures'}].map(o=>`<option value="${o.v}" ${page.cleanupThreshold === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
            </select>
          </div>
          <div><label>Baseline fans offset</label><input type="number" name="baselineFans" value="${page.baselineFans || 0}"/></div>
        </div>
        <div class="row">
          <div>
            <label>Card Source</label>
            <select name="contentMode">
              <option value="" ${!page.contentMode ? 'selected' : ''}>🌐 Use global (${globalMode === 'templates' ? '🎴 Templates' : '📷 Classic'})</option>
              <option value="classic" ${page.contentMode === 'classic' ? 'selected' : ''}>📷 Classic (this page)</option>
              <option value="templates" ${page.contentMode === 'templates' ? 'selected' : ''}>🎴 Templates (this page)</option>
            </select>
          </div>
          <div>
            <label>Send Mode</label>
            <select name="sendMode">
              <option value="" ${!page.sendMode ? 'selected' : ''}>🌐 Use global (${globalSendMode === 'text' ? '💬 Text' : globalSendMode === 'card+text' ? '📷💬 Card+Text' : '📷 Card'})</option>
              <option value="card" ${page.sendMode === 'card' ? 'selected' : ''}>📷 Card only (this page)</option>
              <option value="text" ${page.sendMode === 'text' ? 'selected' : ''}>💬 Text only (this page)</option>
              <option value="card+text" ${page.sendMode === 'card+text' ? 'selected' : ''}>📷💬 Card + Text (this page)</option>
            </select>
          </div>
        </div>
        <div style="margin-top:14px;">
          <label>Redirect Set</label>
          <select name="redirectSet">
            ${getSetNames().map(n => `<option value="${esc(n)}" ${pageSet(page) === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </div>
        <button type="submit" class="btn btn-blue" style="margin-top:12px;">💾 Save Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>📤 Broadcast</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <form action="/send-now-page" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${pid}"/><button type="submit" class="btn btn-green" onclick="return confirm('Broadcast now? (${fans.length} fans)')">📣 Send Now (${fans.length})</button></form>
        <form action="/randomize-and-send?page=${pid}" method="POST" style="margin:0;"><button type="submit" class="btn" style="background:#7c3aed;color:#fff;" onclick="return confirm('Randomize + Send?')">🎲🚀 Randomize + Send</button></form>
        <form action="/${page.broadcastEnabled ? 'pause' : 'resume'}-page" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <button type="submit" class="btn ${page.broadcastEnabled ? 'btn-orange' : 'btn-green'}">
            ${page.broadcastEnabled ? '⏸ Pause Daily' : '▶ Resume Daily'}
          </button>
        </form>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
        <form action="/send-custom-text" method="POST" style="flex:1;min-width:260px;">
          <input type="hidden" name="pageId" value="${pid}"/>
          <label>💬 Send text to all fans:</label>
          <textarea name="text" placeholder="Type a text message to broadcast..." style="min-height:60px;"></textarea>
          <button type="submit" class="btn" style="background:#8b5cf6;color:#fff;" onclick="return confirm('Send this text to ${fans.length} fans?')">💬 Send Text</button>
        </form>
      </div>
    </div>

    <div class="card">
      <h2>📷 Photo Gallery (${(page.photos || []).length})</h2>
      <div class="photo-grid">
        ${(page.photos || []).map((url, i) => {
          const active = url === page.currentPhoto;
          return `<div class="item ${active ? 'current' : ''}">
            <div class="img-wrap">
              <img src="${esc(url)}" onerror="this.style.display='none';"/>
              ${active ? '<div class="badge-current" style="position:absolute;top:4px;left:4px;">★ Active</div>' : ''}
            </div>
            <div class="url-row"><input value="${esc(url)}" readonly/></div>
            <div class="action-row">
              ${!active ? `<a href="/set-photo?page=${pid}&index=${i}" class="ph-btn ph-active">☆ Set Active</a>` : ''}
              <a href="/remove-photo?page=${pid}&index=${i}" class="ph-btn ph-remove" onclick="return confirm('Remove?')">× Remove</a>
            </div>
          </div>`;
        }).join('')}
      </div>
      <form action="/add-photo" method="POST" style="margin-top:14px;">
        <input type="hidden" name="pageId" value="${pid}"/>
        <label>Add photo URL</label>
        <div style="display:flex;gap:8px;"><input name="photoUrl" placeholder="https://i.imgur.com/abc.png" style="flex:1;"/><button type="submit" class="btn btn-green">+ Add</button></div>
      </form>
    </div>

    <div class="card">
      <h2>👥 Fan List (${fans.length})</h2>
      <details>
        <summary style="cursor:pointer;font-weight:600;color:#4a5568;padding:6px 0;">Show ${fans.length} PSIDs</summary>
        <div style="max-height:300px;overflow-y:auto;margin-top:8px;">
          ${fans.map((psid, i) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;font-family:monospace;">
            <span style="color:#94a3b8;min-width:30px;">${i+1}.</span>
            <span style="flex:1;">${esc(psid)}</span>
            <a href="/remove-fan?page=${pid}&psid=${esc(psid)}" onclick="return confirm('Remove?')" style="color:#dc2626;text-decoration:none;font-weight:700;">×</a>
          </div>`).join('')}
        </div>
      </details>
      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
        <form action="/import-contacts" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${pid}"/><button type="submit" class="btn btn-blue">📥 Import Contacts</button></form>
        <form action="/clear-fans" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${pid}"/><button type="submit" class="btn btn-red" onclick="return confirm('Clear ALL fans for this page?')">🗑️ Clear Fans</button></form>
        <form action="/reset-stats" method="POST" style="margin:0;"><input type="hidden" name="pageId" value="${pid}"/><button type="submit" class="btn btn-red" onclick="return confirm('Reset stats?')">🗑️ Reset Stats</button></form>
      </div>
    </div>

    <div class="card danger-zone">
      <h2>⚠️ Danger Zone</h2>
      <form action="/remove-page" method="POST">
        <input type="hidden" name="pageId" value="${pid}"/>
        <button type="submit" class="btn btn-red" onclick="return confirm('Delete this page? Data will be lost.')">🗑️ Remove Page</button>
      </form>
    </div>
  </div>`;
}

// ============================================
// MAIN ROUTE
// ============================================
app.get('/', (req, res) => {
  const pages = loadPages();
  const sel = req.query.page || 'all';

  if (sel === 'templates') {
    return res.send(renderHead('Card Templates') + renderTopbar(pages, 'templates') + renderTemplateManager(req) + '</body></html>');
  }
  if (sel !== 'all') {
    const page = pages.find(p => p.pageId === sel);
    if (!page) return res.redirect('/?error=Page+not+found');
    return res.send(renderHead(page.label) + renderTopbar(pages, sel) + renderPageView(page, req) + '</body></html>');
  }
  res.send(renderHead('All Pages') + renderTopbar(pages, 'all') + renderAllPagesView(pages, req) + '</body></html>');
});

// ============================================
// PAGE MANAGEMENT ROUTES
// ============================================
app.post('/add-page', (req, res) => {
  const { pageId, accessToken, label, group } = req.body;
  if (!pageId || !accessToken) return res.redirect('/?error=Page+ID+and+Token+required');
  const page = addPage({ pageId, accessToken, label, group });
  if (!page) return res.redirect('/?error=Page+already+exists');
  setupMessenger(page);
  if (group) saveGroupName(group);
  res.redirect('/?added=1');
});

app.post('/update-page', (req, res) => {
  const b = req.body;
  const updates = {
    label: b.label, title: b.title, subtitle: b.subtitle,
    buttonText: b.buttonText, whatsapp: normalizeUrl(b.whatsapp),
    broadcastTime: b.broadcastTime,
    spacingSeconds: parseInt(b.spacingSeconds) || 10,
    cleanupThreshold: parseInt(b.cleanupThreshold) || 0,
    baselineFans: parseInt(b.baselineFans) || 0,
    group: (b.group || '').trim(),
    contentMode: b.contentMode || '',
    sendMode: b.sendMode || '',
    redirectSet: b.redirectSet || DEFAULT_SET
  };
  updatePage(b.pageId, updates);
  if (updates.group) saveGroupName(updates.group);
  res.redirect(`/?page=${b.pageId}&saved=1`);
});

app.post('/remove-page', (req, res) => {
  removePage(req.body.pageId);
  res.redirect('/?removed=1');
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
    pages.filter(p => p.group === name).forEach(p => updatePage(p.pageId, { group: '' }));
    // Clean up group config
    const s = loadSettings();
    if (s.groupConfig) { delete s.groupConfig[name]; saveSettings(s); }
  }
  res.redirect('/?saved=1');
});

// ============================================
// NEW GROUP SETTINGS ROUTES
// ============================================
app.post('/save-group-settings', (req, res) => {
  const group = (req.body.group || '').trim();
  if (!group) return res.redirect('/?error=No+group');
  const sendMode = req.body.sendMode === 'global' ? '' : req.body.sendMode;
  const contentMode = req.body.contentMode === 'global' ? '' : req.body.contentMode;
  const dailyTime = req.body.dailyTime || '07:30';
  const dailyEnabled = req.body.dailyEnabled === 'true';
  const dailyRandomize = req.body.dailyRandomize === 'true';
  saveGroupConfig(group, { sendMode, contentMode, dailyTime, dailyEnabled, dailyRandomize });
  res.redirect('/?saved=1');
});

app.post('/schedule-group-send', (req, res) => {
  const group = (req.body.group || '').trim();
  const sendAt = (req.body.sendAt || '').trim();
  if (!group || !sendAt) return res.redirect('/?error=Group+and+datetime+required');
  const randomize = req.body.randomize === '1';
  addGroupSchedule({
    id: 'gs_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    group, sendAt, randomize, type: 'oneshot'
  });
  res.redirect('/?schedule_saved=1');
});

app.post('/cancel-group-schedule', (req, res) => {
  removeGroupSchedule(req.body.id);
  res.redirect('/?saved=1');
});

app.post('/apply-settings-all-groups', (req, res) => {
  const source = (req.body.sourceGroup || '').trim();
  if (!source) return res.redirect('/?error=No+source+group');
  const gc = getGroupConfig(source);
  const groups = getAllGroups();
  groups.forEach(g => {
    if (g !== source) {
      saveGroupConfig(g, {
        sendMode: gc.sendMode || '',
        contentMode: gc.contentMode || '',
        dailyTime: gc.dailyTime || '07:30',
        dailyEnabled: !!gc.dailyEnabled,
        dailyRandomize: gc.dailyRandomize !== false
      });
    }
  });
  res.redirect('/?saved=1');
});

// ============================================
// NEW REDIRECT SET ROUTES
// ============================================
app.post('/create-redirect-set', (req, res) => {
  const name = (req.body.setName || '').trim();
  if (!name) return res.redirect('/?page=all&error=Set+name+required');
  const lib = loadLibrary();
  if (lib.redirectSets[name]) return res.redirect('/?page=all&error=Set+already+exists');
  lib.redirectSets[name] = [];
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=Created+redirect+set:+' + encodeURIComponent(name));
});

app.post('/delete-redirect-set', (req, res) => {
  const name = (req.body.setName || '').trim();
  if (!name || name === DEFAULT_SET || name === SECOND_SET) return res.redirect('/?page=all&error=Cannot+delete+built-in+set');
  const lib = loadLibrary();
  delete lib.redirectSets[name];
  // Remove templates for this set
  lib.cardTemplates = (lib.cardTemplates || []).filter(t => (t.set || DEFAULT_SET) !== name);
  saveLibrary(lib);
  // Move pages off deleted set
  const pages = loadPages();
  pages.filter(p => p.redirectSet === name).forEach(p => updatePage(p.pageId, { redirectSet: DEFAULT_SET }));
  res.redirect('/?page=all&lib_msg=Deleted+redirect+set:+' + encodeURIComponent(name));
});

// ============================================
// SEND / PAUSE / RESUME ROUTES
// ============================================
app.post('/send-now-page', (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  broadcastToPage(page);
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/send-now-all', (req, res) => {
  const pages = loadPages().filter(p => p.sendNowEnabled !== false);
  pages.forEach(p => {
    if (req.query.randomize || req.body.randomize) {
      const updated = randomizePage(p);
      broadcastToPage(updated || p);
    } else {
      broadcastToPage(p);
    }
  });
  res.redirect('/?saved=1');
});

app.post('/send-now-group', (req, res) => {
  const group = (req.body.group || '').trim();
  if (!group) return res.redirect('/?error=No+group');
  const randomize = req.body.randomize === '1';
  broadcastToGroup(group, { randomize });
  res.redirect('/?saved=1');
});

app.post('/pause-page', (req, res) => {
  updatePage(req.body.pageId, { broadcastEnabled: false });
  const from = req.query.page || req.body.pageId;
  res.redirect(`/?page=${from}&saved=1`);
});
app.post('/resume-page', (req, res) => {
  updatePage(req.body.pageId, { broadcastEnabled: true });
  const from = req.query.page || req.body.pageId;
  res.redirect(`/?page=${from}&saved=1`);
});
app.post('/pause-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { broadcastEnabled: false }));
  res.redirect('/?saved=1');
});
app.post('/resume-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { broadcastEnabled: true }));
  res.redirect('/?saved=1');
});
app.post('/pause-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: false }));
  res.redirect('/?saved=1');
});
app.post('/resume-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: true }));
  res.redirect('/?saved=1');
});

// ============================================
// GLOBAL MODE ROUTES
// ============================================
app.post('/set-global-mode', (req, res) => {
  const s = loadSettings();
  s.contentMode = req.body.mode === 'templates' ? 'templates' : 'classic';
  saveSettings(s);
  res.redirect('/?saved=1');
});
app.post('/set-global-send-mode', (req, res) => {
  const s = loadSettings();
  s.sendMode = req.body.mode;
  saveSettings(s);
  res.redirect('/?saved=1');
});

// ============================================
// PHOTO/LIBRARY ROUTES
// ============================================
app.post('/add-photo', (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  const url = normalizeUrl(req.body.photoUrl);
  if (!url) return res.redirect(`/?page=${page.pageId}&error=Invalid+URL`);
  const photos = Array.isArray(page.photos) ? [...page.photos] : [];
  if (!photos.includes(url)) photos.push(url);
  updatePage(page.pageId, { photos, currentPhoto: photos[0] });
  res.redirect(`/?page=${page.pageId}&saved=1`);
});
app.get('/set-photo', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  const idx = parseInt(req.query.index);
  if (page.photos && page.photos[idx]) updatePage(page.pageId, { currentPhoto: page.photos[idx] });
  res.redirect(`/?page=${page.pageId}&saved=1`);
});
app.get('/remove-photo', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  const idx = parseInt(req.query.index);
  const photos = [...(page.photos || [])];
  photos.splice(idx, 1);
  const updates = { photos };
  if (!photos.includes(page.currentPhoto) && photos.length) updates.currentPhoto = photos[0];
  updatePage(page.pageId, updates);
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/library-add-photo', (req, res) => {
  const lib = loadLibrary();
  const raw = (req.body.photoUrls || '').replace(/,/g, '\n');
  const urls = raw.split('\n').map(u => normalizeUrl(u)).filter(Boolean);
  urls.forEach(u => { if (!lib.photos.includes(u)) lib.photos.push(u); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + urls.length + '+photo(s)');
});
app.get('/library-remove-photo', (req, res) => {
  const lib = loadLibrary();
  const idx = parseInt(req.query.index);
  if (idx >= 0 && idx < lib.photos.length) lib.photos.splice(idx, 1);
  saveLibrary(lib);
  res.redirect('/?lib_msg=Photo+removed');
});

app.post('/library-add-redirect', (req, res) => {
  const lib = loadLibrary();
  const set = req.body.setName || DEFAULT_SET;
  if (!lib.redirectSets[set]) lib.redirectSets[set] = [];
  const raw = (req.body.redirectUrls || '').replace(/,/g, '\n');
  const urls = raw.split('\n').map(u => normalizeUrl(u)).filter(Boolean);
  urls.forEach(u => { if (!lib.redirectSets[set].includes(u)) lib.redirectSets[set].push(u); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + urls.length + '+URL(s)+to+' + encodeURIComponent(set));
});
app.get('/library-remove-redirect', (req, res) => {
  const lib = loadLibrary();
  const set = req.query.set || DEFAULT_SET;
  const idx = parseInt(req.query.index);
  if (lib.redirectSets[set] && idx >= 0) lib.redirectSets[set].splice(idx, 1);
  saveLibrary(lib);
  res.redirect('/?lib_msg=Redirect+removed');
});

app.post('/library-add-text', (req, res) => {
  const lib = loadLibrary();
  const key = req.body.key;
  const items = (req.body.items || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (['titles', 'subtitles', 'buttonTexts'].includes(key) && items.length) {
    lib[key] = lib[key] || [];
    items.forEach(item => { if (!lib[key].includes(item)) lib[key].push(item); });
    saveLibrary(lib);
  }
  res.redirect('/?lib_msg=Added+' + items.length + '+items');
});
app.get('/library-remove-text', (req, res) => {
  const lib = loadLibrary();
  const key = req.query.key;
  const idx = parseInt(req.query.index);
  if (['titles', 'subtitles', 'buttonTexts'].includes(key) && lib[key] && idx >= 0) {
    lib[key].splice(idx, 1);
    saveLibrary(lib);
  }
  res.redirect('/?lib_msg=Item+removed');
});

app.post('/library-add-text-pool', (req, res) => {
  const lib = loadLibrary();
  lib.textPool = lib.textPool || [];
  const items = (req.body.texts || '').split('\n').map(s => s.trim()).filter(Boolean);
  items.forEach(t => { if (!lib.textPool.includes(t)) lib.textPool.push(t); });
  saveLibrary(lib);
  res.redirect('/?lib_msg=Added+' + items.length + '+text(s)+to+pool');
});
app.get('/library-remove-text-pool', (req, res) => {
  const lib = loadLibrary();
  const idx = parseInt(req.query.index);
  if (lib.textPool && idx >= 0) lib.textPool.splice(idx, 1);
  saveLibrary(lib);
  res.redirect('/?lib_msg=Text+removed+from+pool');
});
app.post('/library-clear-text-pool', (req, res) => {
  const lib = loadLibrary();
  lib.textPool = [];
  saveLibrary(lib);
  res.redirect('/?lib_msg=Text+pool+cleared');
});

app.get('/set-active-from-library', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  const lib = loadLibrary();
  if (req.query.photoIndex !== undefined) {
    const idx = parseInt(req.query.photoIndex);
    const url = lib.photos[idx];
    if (url) {
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (!photos.includes(url)) photos.unshift(url);
      updatePage(page.pageId, { currentPhoto: url, photos });
    }
  }
  if (req.query.redirectIndex !== undefined) {
    const idx = parseInt(req.query.redirectIndex);
    const setName = pageSet(page, lib);
    const url = (lib.redirectSets[setName] || [])[idx];
    if (url) updatePage(page.pageId, { whatsapp: url });
  }
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/set-page-redirect-set', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  updatePage(page.pageId, { redirectSet: req.body.setName || DEFAULT_SET });
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

// ============================================
// RANDOMIZE / SEND ROUTES
// ============================================
app.post('/randomize-page', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  const only = req.query.only;
  randomizePage(page, { photo: only !== 'redirect', redirect: only !== 'photo' });
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/randomize-and-send', (req, res) => {
  const page = getPage(req.query.page);
  if (!page) return res.redirect('/?error=Page+not+found');
  const updated = randomizePage(page);
  broadcastToPage(updated || page);
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

app.post('/randomize-all', (req, res) => {
  loadPages().forEach(p => randomizePage(p));
  res.redirect('/?saved=1');
});

app.post('/send-custom-text', (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  const text = (req.body.text || '').trim();
  if (!text) return res.redirect(`/?page=${page.pageId}&error=No+text`);
  broadcastTextToPage(page, text);
  res.redirect(`/?page=${page.pageId}&saved=1`);
});

// ============================================
// TEMPLATE ROUTES
// ============================================
app.post('/template-add', (req, res) => {
  const lib = loadLibrary();
  const b = req.body;
  const photos = parsePhotos(b.photos, b.photo);
  const activePhotos = parsePhotos(b.activePhotos);

  // Determine set and redirect from set-specific fields
  let templateSet = '';
  let redirect = b.redirect || '';
  const setNames = getSetNames(lib);
  for (const name of setNames) {
    const val = (b[`redirect_${name}`] || '').trim();
    if (val) {
      if (!templateSet) { templateSet = name; redirect = val; }
    }
  }
  if (!templateSet) templateSet = DEFAULT_SET;
  redirect = normalizeUrl(redirect);

  if (b.id) {
    // Edit existing
    const idx = lib.cardTemplates.findIndex(t => t.id === b.id);
    if (idx >= 0) {
      const existing = lib.cardTemplates[idx];
      lib.cardTemplates[idx] = {
        ...existing,
        title: b.title, subtitle: b.subtitle,
        buttonText: b.buttonText || existing.buttonText,
        redirect: redirect || existing.redirect,
        photo: photos[0] || existing.photo,
        photos: photos.length ? photos : existing.photos,
        activePhotos: activePhotos,
        set: templateSet
      };
      // Handle linked template — update partner's set-specific redirect
      if (existing.linkedId) {
        const partnerIdx = lib.cardTemplates.findIndex(t => t.id === existing.linkedId);
        if (partnerIdx >= 0) {
          const partner = lib.cardTemplates[partnerIdx];
          const partnerSet = partner.set || DEFAULT_SET;
          const partnerRedirect = (b[`redirect_${partnerSet}`] || '').trim();
          if (partnerRedirect) {
            lib.cardTemplates[partnerIdx] = { ...partner, redirect: normalizeUrl(partnerRedirect) };
          }
          // Sync shared fields
          lib.cardTemplates[partnerIdx] = {
            ...lib.cardTemplates[partnerIdx],
            title: b.title || partner.title,
            subtitle: b.subtitle || partner.subtitle,
            buttonText: b.buttonText || partner.buttonText,
            photo: photos[0] || partner.photo,
            photos: photos.length ? photos : partner.photos,
            activePhotos: activePhotos.length ? activePhotos : partner.activePhotos
          };
        }
      }
    }
  } else {
    // Add new
    const newTemplate = {
      id: 'tpl_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
      title: b.title, subtitle: b.subtitle,
      buttonText: b.buttonText || 'My Photos 📞',
      redirect,
      photo: photos[0] || '',
      photos,
      activePhotos,
      set: templateSet,
      active: true
    };
    lib.cardTemplates.push(newTemplate);

    // If any other set had a redirect filled, create linked templates
    for (const name of setNames) {
      if (name === templateSet) continue;
      const otherRedirect = (b[`redirect_${name}`] || '').trim();
      if (otherRedirect) {
        const linkedTemplate = {
          ...newTemplate,
          id: 'tpl_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + '_linked',
          set: name,
          redirect: normalizeUrl(otherRedirect),
          linkedId: newTemplate.id
        };
        lib.cardTemplates.push(linkedTemplate);
        newTemplate.linkedId = linkedTemplate.id;
      }
    }
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
    if (partner) partner.linkedId = undefined;
  }
  lib.cardTemplates = lib.cardTemplates.filter(t => t.id !== id);
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.post('/template-bulk-active', (req, res) => {
  const lib = loadLibrary();
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids];
  const active = req.body.active === 'true';
  ids.forEach(id => {
    const t = lib.cardTemplates.find(x => x.id === id);
    if (t) t.active = active;
  });
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-duplicate-linked', (req, res) => {
  const lib = loadLibrary();
  const tmpl = lib.cardTemplates.find(t => t.id === req.query.id);
  const toSet = req.query.toSet || SECOND_SET;
  if (!tmpl) return res.redirect('/?page=templates&error=Template+not+found');
  const dup = {
    ...JSON.parse(JSON.stringify(tmpl)),
    id: 'tpl_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    set: toSet,
    redirect: '',
    linkedId: tmpl.id
  };
  tmpl.linkedId = dup.id;
  lib.cardTemplates.push(dup);
  saveLibrary(lib);
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-link', (req, res) => {
  const lib = loadLibrary();
  const a = lib.cardTemplates.find(t => t.id === req.query.from);
  const b = lib.cardTemplates.find(t => t.id === req.query.to);
  if (a && b) { a.linkedId = b.id; b.linkedId = a.id; saveLibrary(lib); }
  res.redirect('/?page=templates&saved=1');
});

app.get('/template-unlink', (req, res) => {
  const lib = loadLibrary();
  const tmpl = lib.cardTemplates.find(t => t.id === req.query.id);
  if (tmpl && tmpl.linkedId) {
    const partner = lib.cardTemplates.find(t => t.id === tmpl.linkedId);
    if (partner) partner.linkedId = undefined;
    tmpl.linkedId = undefined;
    saveLibrary(lib);
  }
  res.redirect('/?page=templates&saved=1');
});

// ============================================
// MASTER REDIRECT ROUTES
// ============================================
app.post('/master-redirect-on', (req, res) => {
  const url = normalizeUrl(req.body.url);
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
  res.redirect(`/?page=${req.query.page || 'templates'}&saved=1`);
});

// ============================================
// SPACING / CLEANUP
// ============================================
app.post('/set-spacing-all', (req, res) => {
  const spacing = parseInt(req.body.spacingSeconds) || 10;
  loadPages().forEach(p => updatePage(p.pageId, { spacingSeconds: spacing }));
  res.redirect('/?saved=1');
});
app.post('/set-cleanup-all', (req, res) => {
  const threshold = parseInt(req.body.cleanupThreshold);
  loadPages().forEach(p => updatePage(p.pageId, { cleanupThreshold: threshold }));
  res.redirect('/?saved=1');
});

// ============================================
// FAN MANAGEMENT
// ============================================
app.post('/clear-fans', (req, res) => {
  saveFansList(req.body.pageId, []);
  res.redirect(`/?page=${req.body.pageId}&saved=1`);
});
app.get('/remove-fan', (req, res) => {
  removeFan(req.query.page, req.query.psid, 'manual');
  res.redirect(`/?page=${req.query.page}&saved=1`);
});
app.post('/import-contacts', (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  fetch(`https://graph.facebook.com/v17.0/me/conversations?fields=participants&access_token=${page.accessToken}&limit=500`)
    .then(r => r.json()).then(data => {
      let count = 0;
      (data.data || []).forEach(conv => {
        (conv.participants?.data || []).forEach(p => {
          if (p.id !== page.pageId && !isFanSaved(page.pageId, p.id)) {
            saveFan(page.pageId, p.id);
            count++;
          }
        });
      });
      res.redirect(`/?page=${page.pageId}&lib_msg=Imported+${count}+contacts`);
    }).catch(e => {
      console.error(`Import error [${page.label}]:`, e.message);
      res.redirect(`/?page=${page.pageId}&error=Import+failed`);
    });
});
app.post('/import-contacts-batch', (req, res) => {
  const pageIds = req.body.pageIds || [];
  const results = [];
  Promise.all(pageIds.map(async (pid) => {
    const page = getPage(pid);
    if (!page) { results.push({ pageId: pid, ok: false, error: 'not found' }); return; }
    try {
      const r = await fetch(`https://graph.facebook.com/v17.0/me/conversations?fields=participants&access_token=${page.accessToken}&limit=500`);
      const data = await r.json();
      let count = 0;
      (data.data || []).forEach(conv => {
        (conv.participants?.data || []).forEach(p => {
          if (p.id !== page.pageId && !isFanSaved(page.pageId, p.id)) {
            saveFan(page.pageId, p.id);
            count++;
          }
        });
      });
      results.push({ pageId: pid, ok: true, imported: count });
    } catch (e) { results.push({ pageId: pid, ok: false, error: e.message }); }
  })).then(() => res.json({ ok: true, results }));
});
app.post('/clear-all-fans', (req, res) => {
  const pages = loadPages();
  let cleared = 0;
  pages.forEach(p => { const f = loadFans(p.pageId); cleared += f.length; saveFansList(p.pageId, []); });
  res.json({ ok: true, cleared });
});
app.post('/reset-stats', (req, res) => {
  resetStats(req.body.pageId);
  res.redirect(`/?page=${req.body.pageId}&saved=1`);
});
app.post('/reset-stats-all', (req, res) => {
  loadPages().forEach(p => resetStats(p.pageId));
  res.redirect('/?saved=1');
});

// ============================================
// BROADCAST PROGRESS API
// ============================================
app.get('/broadcast-progress', (req, res) => {
  const pageId = req.query.page;
  const bp = broadcastProgress[pageId];
  if (!bp) return res.json({ status: 'idle' });
  res.json(bp);
});

// ============================================
// BULK ADD PAGES
// ============================================
app.post('/bulk-add-pages', (req, res) => {
  const incoming = req.body.pages || [];
  let added = 0;
  incoming.forEach(p => {
    const result = addPage({ pageId: p.pageId, accessToken: p.token, label: p.name, group: p.group || '' });
    if (result) { setupMessenger(result); added++; }
  });
  res.json({ ok: true, added });
});

// ============================================
// REDEPLOY
// ============================================
app.post('/redeploy', (req, res) => {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  const envId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!token || !serviceId || !envId) return res.json({ ok: false, error: 'Missing RAILWAY env vars' });
  fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: `mutation { serviceInstanceRedeploy(environmentId: "${envId}", serviceId: "${serviceId}") }`
    })
  }).then(r => r.json()).then(d => {
    if (d.errors) return res.json({ ok: false, error: d.errors[0]?.message });
    res.json({ ok: true });
  }).catch(e => res.json({ ok: false, error: e.message }));
});

// ============================================
// BACKUP / RESTORE
// ============================================
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.get('/backup', (req, res) => {
  const backup = {
    pages: loadPages(),
    library: loadLibrary(),
    settings: loadSettings(),
    fans: {},
    stats: {}
  };
  loadPages().forEach(p => {
    backup.fans[p.pageId] = loadFans(p.pageId);
    backup.stats[p.pageId] = loadStats(p.pageId);
  });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=messagebot-backup.json');
  res.send(JSON.stringify(backup, null, 2));
});

app.post('/restore-backup', upload.single('backupFile'), (req, res) => {
  try {
    const data = JSON.parse(req.file.buffer.toString('utf8'));
    if (data.pages) savePages(data.pages);
    if (data.library) saveLibrary(data.library);
    if (data.settings) saveSettings(data.settings);
    if (data.fans) {
      Object.entries(data.fans).forEach(([pid, fans]) => saveFansList(pid, fans));
    }
    if (data.stats) {
      Object.entries(data.stats).forEach(([pid, stats]) => saveStats(pid, stats));
    }
    res.redirect('/?lib_msg=Backup+restored+successfully');
  } catch (e) {
    res.redirect('/?error=Restore+failed:+' + encodeURIComponent(e.message));
  }
});

// ============================================
// CRON — per-page daily + NEW per-group schedules
// ============================================
cron.schedule('* * * * *', () => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // ── Per-page daily broadcasts ──
  const pages = loadPages();
  pages.forEach(page => {
    if (!page.broadcastEnabled) return;
    if (page.broadcastTime !== hhmm) return;
    console.log(`[CRON] Daily broadcast for ${page.label} at ${hhmm}`);
    randomizePage(page);
    const updated = getPage(page.pageId);
    broadcastToPage(updated || page);
  });

  // ── Per-group daily broadcasts ──
  const groups = getAllGroups(pages);
  groups.forEach(g => {
    const gc = getGroupConfig(g);
    if (!gc.dailyEnabled) return;
    if ((gc.dailyTime || '07:30') !== hhmm) return;
    console.log(`[CRON] Group daily broadcast: ${g} at ${hhmm}`);
    broadcastToGroup(g, { randomize: gc.dailyRandomize !== false });
  });

  // ── One-shot group schedules ──
  const schedules = loadGroupSchedules();
  const toFire = schedules.filter(s => {
    if (s.type !== 'oneshot') return false;
    const fireTime = new Date(s.sendAt);
    // Fire if within this minute
    return Math.abs(now - fireTime) < 60000;
  });
  toFire.forEach(s => {
    console.log(`[CRON] One-shot group send: ${s.group} (scheduled ${s.sendAt})`);
    broadcastToGroup(s.group, { randomize: !!s.randomize });
    removeGroupSchedule(s.id);
  });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 messagebot running on port ${PORT}`);
  if (PUBLIC_URL) {
    console.log(`🌐 ${PUBLIC_URL}/webhook`);
    console.log(`🔑 Verify token: ${VERIFY_TOKEN}`);
  }
  // Setup Messenger for all pages
  const pages = loadPages();
  pages.forEach(page => setupMessenger(page));
  console.log(`📋 ${pages.length} pages loaded`);
});
