 ============================================
 messagebot — multi-tenant Facebook Messenger bot
 One Railway service, many pages, one webhook URL
 ============================================
const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const basicAuth = require('express-basic-auth');

const app = express();
app.use(express.json({ limit '50mb' }));
app.use(express.urlencoded({ extended true }));

 ============================================
 ENV VARS
 ============================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN  'abc123';
const ADMIN_USER = process.env.ADMIN_USER  'admin';
const ADMIN_PASS = process.env.ADMIN_PASS  'changeme';
const PORT = process.env.PORT  8080;

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
   `https${process.env.RAILWAY_PUBLIC_DOMAIN}`
   (process.env.PUBLIC_URL  '');

 Storage on data volume if mounted, otherwise local (ephemeral!)
const DATA_DIR = fs.existsSync('data')  'data'  '.';
const PAGES_FILE = `${DATA_DIR}pages.json`;
console.log(`💾 Data directory ${DATA_DIR}`);
if (DATA_DIR !== 'data') {
  console.warn('⚠️  No data volume mounted — fan lists will wipe on redeploy!');
}

const STARTED_AT = new Date();

 ============================================
 DEFAULTS (from env vars, fall back to hardcoded)
 Used when adding a new page with optional fields blank
 ============================================
function getDefaults() {
  return {
    whatsapp process.env.DEFAULT_WHATSAPP  'httpsscrollgallery.comp=50328',
    photos (process.env.DEFAULT_PHOTOS
       process.env.DEFAULT_PHOTOS.split(',').map(s = s.trim()).filter(Boolean)
       [
          'httpsi.imgur.com2J3Jne9.png',
          'httpsi.imgur.com0gCjxrP.png',
          'httpsi.imgur.comaDQ1ScR.png',
          'httpsi.imgur.comMHT57vc.png'
        ]),
    title process.env.DEFAULT_TITLE  'Heyy darling 💕',
    subtitle process.env.DEFAULT_SUBTITLE  I'm on WhatsApp... lets talk,
    buttonText process.env.DEFAULT_BUTTON_TEXT  'My Photos 📞',
    broadcastTime process.env.DEFAULT_BROADCAST_TIME  '0730',
    timezone process.env.DEFAULT_TIMEZONE  'UTC',
    broadcastEnabled false,         NEW DEFAULT paused
    spacingSeconds parseInt(process.env.DEFAULT_SPACING_SECONDS)  10,
    cleanupThreshold 0              NEW DEFAULT disabled (never remove fans)
  };
}

 ============================================
 PAGES STORAGE (pages.json on volume)
 ============================================
function loadPages() {
  try { return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8')); }
  catch { return []; }
}
function savePages(pages) {
  fs.writeFileSync(PAGES_FILE, JSON.stringify(pages, null, 2));
}
function getPage(pageId) {
  return loadPages().find(p = p.pageId === pageId);
}
function updatePage(pageId, updates) {
  const pages = loadPages();
  const idx = pages.findIndex(p = p.pageId === pageId);
  if (idx  0) return null;
  pages[idx] = { ...pages[idx], ...updates };
  savePages(pages);
  return pages[idx];
}
function addPage(data) {
  const pages = loadPages();
  if (pages.find(p = p.pageId === data.pageId)) return null;
  const d = getDefaults();
  const photos = (data.photos && data.photos.length)  data.photos  d.photos;
  const newPage = {
    pageId String(data.pageId).trim(),
    accessToken String(data.accessToken).trim(),
    label data.label  `Page ${data.pageId}`,
    title data.title  d.title,
    subtitle data.subtitle  d.subtitle,
    buttonText data.buttonText  d.buttonText,
    whatsapp data.whatsapp  d.whatsapp,
    photos photos,
    currentPhoto data.currentPhoto  photos[0],
    broadcastTime data.broadcastTime  d.broadcastTime,
    timezone data.timezone  d.timezone,
    broadcastEnabled false,          always paused on creation
    sendNowEnabled data.sendNowEnabled !== undefined  data.sendNowEnabled  true,
    spacingSeconds data.spacingSeconds  d.spacingSeconds,
    cleanupThreshold 0,              always disabled on creation
    baselineFans data.baselineFans  0,
    group data.group  '',          PAGE GROUP (e.g. Part 1, Part 2)
    createdAt new Date().toISOString()
  };
  pages.push(newPage);
  savePages(pages);
  return newPage;
}
function removePage(pageId) {
  const pages = loadPages().filter(p = p.pageId !== pageId);
  savePages(pages);
  try { fs.unlinkSync(`${DATA_DIR}fans-${pageId}.json`); } catch {}
  try { fs.unlinkSync(`${DATA_DIR}stats-${pageId}.json`); } catch {}
}

 ============================================
 PAGE GROUPS HELPERS
 ============================================
 Returns sorted unique group names — from settings (registered groups) + any pages already assigned
function getAllGroups(pages) {
  pages = pages  loadPages();
  const s = loadSettings();
  const saved = Array.isArray(s.groups)  s.groups  [];
  const fromPages = pages.map(p = (p.group  '').trim()).filter(Boolean);
  const all = [...new Set([...saved, ...fromPages])];
  return all.sort();
}

 Save a group name into settings so it persists even before pages are assigned
function saveGroupName(name) {
  name = (name  '').trim();
  if (!name) return;
  const s = loadSettings();
  s.groups = Array.isArray(s.groups)  s.groups  [];
  if (!s.groups.includes(name)) { s.groups.push(name); s.groups.sort(); saveSettings(s); }
}

 Remove a group name from settings
function deleteGroupName(name) {
  const s = loadSettings();
  s.groups = (Array.isArray(s.groups)  s.groups  []).filter(g = g !== name);
  saveSettings(s);
}

 ============================================
 SHARED LIBRARY (library.json on volume)
 ============================================
const LIBRARY_FILE = `${DATA_DIR}library.json`;

 ============================================
 GLOBAL SETTINGS (settings.json)
 ============================================
const SETTINGS_FILE = `${DATA_DIR}settings.json`;
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { contentMode 'classic' }; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }
function getGlobalContentMode() {
  const s = loadSettings();
  return s.contentMode === 'templates'  'templates'  'classic';
}
function pageContentMode(page) {
  if (page && (page.contentMode === 'classic'  page.contentMode === 'templates')) {
    return page.contentMode;
  }
  return getGlobalContentMode();
}

function normalizeUrl(u) {
  u = (u  '').trim();
  if (!u) return u;
  if (^httpsi.test(u)) return u;
  if (u.indexOf('') === 0) return 'https' + u;
  return 'https' + u;
}

function getMasterRedirect() {
  const s = loadSettings();
  const mr = s.masterRedirect  {};
  return { enabled !!mr.enabled, url mr.url  '' };
}

function renderMasterRedirectCard() {
  const mr = getMasterRedirect();
  if (mr.enabled && mr.url) {
    return `
    div class=card style=border2px solid #f59e0b;background#fffbeb;
      h2 style=color#b45309;⚠️ Master Redirect is ON — all cards go to one URLh2
      p style=color#92400e;font-size13px;margin6px 0;Every card on every page (Classic and Templates) currently redirects fans here, ignoring each card's own URL — including cards already sent. Stays on until you turn it off.p
      div style=font-familymonospace;font-size13px;color#92400e;background#fef3c7;border1px solid #fde68a;border-radius6px;padding8px 12px;margin8px 0;word-breakbreak-all;→ ${esc(mr.url)}div
      form action=master-redirect-off method=POST style=margin0;
        button type=submit class=btn style=background#b45309;color#fff;↩️ Turn OFF — back to each card's own URLbutton
      form
    div`;
  }
  return `
    div class=card style=border2px solid #fde68a;
      h2🔀 Master Redirect Override span style=font-size12px;font-weight400;color#92400e;— send every card to ONE url temporarilyspanh2
      p style=color#6b7280;font-size13px;Turn this on when you want all fans sent to a single link (e.g. a WhatsApp or Messenger URL) instead of each card's own redirect. Applies to every page — Classic and Templates — instantly, and to cards already in fans' inboxes. Turn it off anytime to go back to normal.p
      form action=master-redirect-on method=POST style=margin-top10px;displayflex;gap8px;flex-wrapwrap;align-itemscenter;
        input type=text name=url placeholder=httpswa.me355691234567 value=${esc(mr.url)} style=flex1;min-width260px;font-familymonospace;font-size13px;padding8px;border1px solid #cbd5e1;border-radius6px;
        button type=submit class=btn style=background#f59e0b;color#fff;white-spacenowrap; onclick=return confirm('Turn ON master redirect Every card on every page will point to this one URL until you turn it off.')⚡ Turn override ONbutton
      form
    div`;
}

function renderMasterRedirectBanner() {
  const mr = getMasterRedirect();
  if (!(mr.enabled && mr.url)) return '';
  return `
    div class=card style=border2px solid #f59e0b;background#fffbeb;
      h2 style=color#b45309;⚠️ Master Redirect is ONh2
      p style=color#92400e;font-size13px;margin6px 0;All cards on all pages currently redirect fans to strong style=font-familymonospace;word-breakbreak-all;${esc(mr.url)}strong, ignoring their own URLs. Turn it off on the 🎴 Card Templates page to resume normal redirects.p
      form action=master-redirect-off method=POST style=margin0;
        button type=submit class=btn style=background#b45309;color#fff;↩️ Turn OFF master redirectbutton
      form
    div`;
}

const LIBRARY_SEED_PHOTOS = [
  'httpsi.imgur.comHeeRTyc.png',
  'httpsi.imgur.com2MOgc8a.png',
  'httpsi.imgur.comiroLLAh.png',
  'httpsi.imgur.comSRqUCwK.png',
  'httpsi.imgur.comWTFzSCt.png',
  'httpsi.imgur.comWysXBvK.png',
  'httpsi.imgur.comAXWkif2.png',
  'httpsi.imgur.com8QbpzZO.png',
  'httpsi.imgur.comsDraH1p.png',
  'httpsi.imgur.comD87Bhpa.png',
  'httpsi.imgur.com2J3Jne9.png',
  'httpsi.imgur.comMHT57vc.png'
];

const DEFAULT_SET = 'Scrollgallery';
const SECOND_SET = 'TheViralBox';

const LIBRARY_SEED_REDIRECT_SETS = {
  'Scrollgallery' [
    'httpsscrollgallery.comp=50252',
    'httpsscrollgallery.comp=50259',
    'httpsscrollgallery.comp=50271',
    'httpsscrollgallery.comp=50278',
    'httpsscrollgallery.comp=50285',
    'httpsscrollgallery.comp=50292',
    'httpsscrollgallery.comp=50299',
    'httpsscrollgallery.comp=50306',
    'httpsscrollgallery.comp=50313',
    'httpsscrollgallery.comp=50321',
    'httpsscrollgallery.comp=50328',
    'httpsscrollgallery.comp=50335',
    'httpsscrollgallery.comp=50342',
    'httpsscrollgallery.comp=50349',
    'httpsscrollgallery.comp=50356',
    'httpsscrollgallery.comp=50363',
    'httpsscrollgallery.comp=50370',
    'httpsscrollgallery.comp=50377',
    'httpsscrollgallery.comp=50385',
    'httpsscrollgallery.comp=50392'
  ],
  'TheViralBox' [
    'httpsphotos.theviralbox.infoarchives1945',
    'httpsphotos.theviralbox.infoarchives1953',
    'httpsphotos.theviralbox.infoarchives1960',
    'httpsphotos.theviralbox.infoarchives1967',
    'httpsphotos.theviralbox.infoarchives1979',
    'httpsphotos.theviralbox.infoarchives1986',
    'httpsphotos.theviralbox.infoarchives1993',
    'httpsphotos.theviralbox.infoarchives2000',
    'httpsphotos.theviralbox.infoarchives2007',
    'httpsphotos.theviralbox.infoarchives2014',
    'httpsphotos.theviralbox.infoarchives2021',
    'httpsphotos.theviralbox.infoarchives2028',
    'httpsphotos.theviralbox.infoarchives2035',
    'httpsphotos.theviralbox.infoarchives2042',
    'httpsphotos.theviralbox.infoarchives2049',
    'httpsphotos.theviralbox.infoarchives2056',
    'httpsphotos.theviralbox.infoarchives2063',
    'httpsphotos.theviralbox.infoarchives2070'
  ]
};

function loadLibrary() {
  let lib;
  try {
    lib = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
  } catch {
    const seed = {
      photos [...LIBRARY_SEED_PHOTOS],
      redirectSets JSON.parse(JSON.stringify(LIBRARY_SEED_REDIRECT_SETS)),
      cardTemplates []
    };
    try { saveLibrary(seed); } catch {}
    return seed;
  }
  const photos = Array.isArray(lib.photos)  lib.photos  [];
  let redirectSets = lib.redirectSets && typeof lib.redirectSets === 'object'  lib.redirectSets  null;
  if (!redirectSets) {
    const oldFlat = Array.isArray(lib.redirects)  lib.redirects  [];
    redirectSets = { [DEFAULT_SET] oldFlat, [SECOND_SET] [] };
  }
  if (!Array.isArray(redirectSets[DEFAULT_SET])) redirectSets[DEFAULT_SET] = [];
  if (!Array.isArray(redirectSets[SECOND_SET])) redirectSets[SECOND_SET] = [];
  const cardTemplates = Array.isArray(lib.cardTemplates)  lib.cardTemplates  [];
  const titles = Array.isArray(lib.titles)  lib.titles  [];
  const subtitles = Array.isArray(lib.subtitles)  lib.subtitles  [];
  const buttonTexts = Array.isArray(lib.buttonTexts)  lib.buttonTexts  [];
  const normalized = { photos, redirectSets, cardTemplates, titles, subtitles, buttonTexts };
  if (!lib.redirectSets  !lib.cardTemplates) { try { saveLibrary(normalized); } catch {} }
  return normalized;
}
function saveLibrary(lib) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
}
function getSetNames(lib) {
  lib = lib  loadLibrary();
  const names = Object.keys(lib.redirectSets);
  const ordered = [DEFAULT_SET, SECOND_SET].filter(n = names.includes(n));
  names.forEach(n = { if (!ordered.includes(n)) ordered.push(n); });
  return ordered;
}
function pageSet(page, lib) {
  lib = lib  loadLibrary();
  const s = page.redirectSet;
  if (s && Array.isArray(lib.redirectSets[s])) return s;
  return DEFAULT_SET;
}

function pickRandom(arr, avoid) {
  if (!arr  arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  const pool = arr.filter(x = x !== avoid);
  const choices = pool.length  pool  arr;
  return choices[Math.floor(Math.random()  choices.length)];
}

function templatesForSet(lib, setName) {
  lib = lib  loadLibrary();
  return (lib.cardTemplates  []).filter(t = (t.set  DEFAULT_SET) === setName);
}

function pickTemplatePhoto(t) {
   Use activePhotos if set, otherwise fall back to all photos
  const active = (Array.isArray(t.activePhotos) && t.activePhotos.length)  t.activePhotos  null;
  const pics = active  ((Array.isArray(t.photos) && t.photos.length)  t.photos  (t.photo  [t.photo]  []));
  if (!pics.length) return t.photo  '';
  return pics[Math.floor(Math.random()  pics.length)];
}

function parsePhotos(raw, legacy) {
  let arr = [];
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p)) arr = p; } catch (e) {} }
  if (!arr.length && legacy) arr = [legacy];
  return arr.map(u = (u  '').trim()).filter(Boolean);
}

function randomizePage(page, opts = {}) {
  const doPhoto = opts.photo !== false;
  const doRedirect = opts.redirect !== false;
  const lib = loadLibrary();
  const setName = pageSet(page, lib);
  const tmpls = templatesForSet(lib, setName).filter(t = t.active !== false);

  const mode = pageContentMode(page);
  if (mode === 'templates' && tmpls.length && doPhoto && doRedirect) {
    const chosen = pickRandom(tmpls, (lib.cardTemplates  []).find(t = t.id === page.lastTemplateId));
    if (chosen) {
      const pic = pickTemplatePhoto(chosen);
      const photos = Array.isArray(page.photos)  [...page.photos]  [];
      if (pic && !photos.includes(pic)) photos.unshift(pic);
      return updatePage(page.pageId, {
        currentPhoto pic  page.currentPhoto,
        title chosen.title  page.title,
        subtitle chosen.subtitle  page.subtitle,
        buttonText chosen.buttonText  page.buttonText,
        whatsapp chosen.redirect  page.whatsapp,
        lastPhoto pic,
        lastRedirect chosen.redirect,
        lastTemplateId chosen.id,
        photos
      });
    }
  }

  const updates = {};
  if (doPhoto && lib.photos.length) {
    const newPhoto = pickRandom(lib.photos, page.lastPhoto  page.currentPhoto);
    if (newPhoto) {
      updates.currentPhoto = newPhoto;
      updates.lastPhoto = newPhoto;
      const photos = Array.isArray(page.photos)  [...page.photos]  [];
      if (!photos.includes(newPhoto)) photos.unshift(newPhoto);
      updates.photos = photos;
    }
  }
  if (doRedirect) {
    const pool = lib.redirectSets[setName]  [];
    if (pool.length) {
      const newRedirect = pickRandom(pool, page.lastRedirect  page.whatsapp);
      if (newRedirect) {
        updates.whatsapp = newRedirect;
        updates.lastRedirect = newRedirect;
      }
    }
  }
   Classic mode also rotate title, subtitle, buttonText from shared pools
  if (lib.titles && lib.titles.length) {
    const newTitle = pickRandom(lib.titles, page.lastTitle  page.title);
    if (newTitle) { updates.title = newTitle; updates.lastTitle = newTitle; }
  }
  if (lib.subtitles && lib.subtitles.length) {
    const newSubtitle = pickRandom(lib.subtitles, page.lastSubtitle  page.subtitle);
    if (newSubtitle) { updates.subtitle = newSubtitle; updates.lastSubtitle = newSubtitle; }
  }
  if (lib.buttonTexts && lib.buttonTexts.length) {
    const newButton = pickRandom(lib.buttonTexts, page.lastButtonText  page.buttonText);
    if (newButton) { updates.buttonText = newButton; updates.lastButtonText = newButton; }
  }
  if (Object.keys(updates).length) {
    return updatePage(page.pageId, updates);
  }
  return page;
}

 ============================================
 FANS (per page)
 ============================================
function fansFile(pageId) { return `${DATA_DIR}fans-${pageId}.json`; }
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
    console.log(`[${pageId}] New fan ${psid}  Total ${fans.length}`);
  }
}

function trackFailureForFan(pageId, psid, reason) {
  const page = getPage(pageId);
  const threshold = (page && page.cleanupThreshold !== undefined)  page.cleanupThreshold  1;
  if (threshold === 0) return;
  const s = loadStats(pageId);
  s.fanFailures = s.fanFailures  {};
  s.fanFailures[psid] = (s.fanFailures[psid]  0) + 1;
  const count = s.fanFailures[psid];
  if (count = threshold) {
    const fans = loadFans(pageId);
    const filtered = fans.filter(p = p !== psid);
    if (filtered.length !== fans.length) {
      saveFansList(pageId, filtered);
      s.removedFans = s.removedFans  [];
      s.removedFans.push({ psid, reason `${count} consecutive failures ${reason  'unreachable'}`, time new Date().toISOString() });
      delete s.fanFailures[psid];
      console.log(`[${pageId}] Auto-removed fan ${psid} after ${count} failures (${reason})  Remaining ${filtered.length}`);
    }
  } else {
    console.log(`[${pageId}] Fan ${psid} failure ${count}${threshold} (${reason}) — not removed yet`);
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
  const filtered = fans.filter(p = p !== psid);
  if (filtered.length !== fans.length) {
    saveFansList(pageId, filtered);
    const s = loadStats(pageId);
    s.removedFans = s.removedFans  [];
    s.removedFans.push({ psid, reason reason  'manual', time new Date().toISOString() });
    saveStats(pageId, s);
    console.log(`[${pageId}] Removed fan ${psid} (${reason})  Remaining ${filtered.length}`);
  }
}

 ============================================
 STATS (per page)
 ============================================
function statsFile(pageId) { return `${DATA_DIR}stats-${pageId}.json`; }
function loadStats(pageId) {
  try { return JSON.parse(fs.readFileSync(statsFile(pageId), 'utf8')); }
  catch {
    return { clicks [], messagesSent 0, messagesFailed 0, fansAdded [], reads [], readers [], deliveries [], delivered [] };
  }
}
function saveStats(pageId, s) { fs.writeFileSync(statsFile(pageId), JSON.stringify(s)); }
function resetStats(pageId) {
  saveStats(pageId, { clicks [], messagesSent 0, messagesFailed 0, fansAdded [], reads [], readers [], deliveries [], delivered [], dailyMessages {} });
}
function trackClick(pageId, psid) {
  const s = loadStats(pageId);
  s.clicks = s.clicks  [];
  s.clicks.push({ psid, time new Date().toISOString() });
  saveStats(pageId, s);
}
function trackMessage(pageId, success) {
  const s = loadStats(pageId);
  if (success) s.messagesSent = (s.messagesSent  0) + 1;
  else s.messagesFailed = (s.messagesFailed  0) + 1;
  s.dailyMessages = s.dailyMessages  {};
  const today = todayDate();
  s.dailyMessages[today] = s.dailyMessages[today]  { sent 0, failed 0 };
  if (success) s.dailyMessages[today].sent++;
  else s.dailyMessages[today].failed++;
  saveStats(pageId, s);
}
function trackRead(pageId, psid, w) {
  const s = loadStats(pageId);
  s.reads = s.reads  []; s.readers = s.readers  [];
  s.reads.push({ psid, watermark w, time new Date().toISOString() });
  if (!s.readers.includes(psid)) s.readers.push(psid);
  saveStats(pageId, s);
}
function trackDelivery(pageId, psid, w) {
  const s = loadStats(pageId);
  s.deliveries = s.deliveries  []; s.delivered = s.delivered  [];
  s.deliveries.push({ psid, watermark w, time new Date().toISOString() });
  if (!s.delivered.includes(psid)) s.delivered.push(psid);
  saveStats(pageId, s);
}
function trackFanAdded(pageId, psid) {
  const s = loadStats(pageId);
  s.fansAdded = s.fansAdded  [];
  s.fansAdded.push({ psid, time new Date().toISOString() });
  saveStats(pageId, s);
}

 ============================================
 HELPERS
 ============================================
function getCurrentPhoto(page) {
  if (page.currentPhoto) return page.currentPhoto;
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0))  86400000);
  return page.photos[day % page.photos.length];
}

const DAILY_SUBTITLES = [
  I'm on WhatsApp... lets talk,
  Come chat with me 💬,
  Message me on WhatsApp... I'm waiting 😊,
  Let's talk on WhatsApp today 👇,
  Come find me on WhatsApp 💕,
  I'm on WhatsApp... come say hi 👋,
  Let's chat on WhatsApp 💬,
  Talk to me on WhatsApp 😘,
  Come chat on WhatsApp today 💕,
  Message me on WhatsApp 👇
];
function getRotatingSubtitle() {
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0))  86400000);
  return DAILY_SUBTITLES[day % DAILY_SUBTITLES.length];
}

const SPACING_PRESETS = [2, 5, 10, 15, 18, 30, 60];
function spacingLabel(s) {
  const perHr = Math.floor(3600  s);
  let tag;
  if (s = 2) tag = 'very risky';
  else if (s = 5) tag = 'risky';
  else if (s = 10) tag = 'moderate';
  else if (s = 18) tag = 'safe';
  else tag = 'very safe';
  return `${s}s (~${perHr}hr — ${tag})`;
}
function renderSpacingSelect(name, selected) {
  selected = selected  10;
  const presets = [...SPACING_PRESETS];
  if (!presets.includes(selected)) presets.push(selected);
  presets.sort((a, b) = a - b);
  return `select name=${name}${
    presets.map(s = `option value=${s} ${s === selected  'selected'  ''}${spacingLabel(s)}option`).join('')
  }select`;
}

function todayDate() {
  return new Date().toISOString().split('T')[0];
}
function getRecentDailyStats(pageId, days = 14) {
  const stats = loadStats(pageId);
  const daily = stats.dailyMessages  {};
  const result = [];
  const now = new Date();
  for (let i = 0; i  days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const day = daily[dateStr]  { sent 0, failed 0 };
    result.push({ date dateStr, sent day.sent, failed day.failed });
  }
  return result;
}

function uptimeText() {
  const ms = Date.now() - STARTED_AT.getTime();
  const h = Math.floor(ms  3600000);
  const m = Math.floor((ms % 3600000)  60000);
  return h === 0  `${m}m`  `${h}h ${m}m`;
}

function esc(s) {
  if (s === null  s === undefined) return '';
  return String(s)
    .replace(&g, '&amp;')
    .replace(g, '&lt;')
    .replace(g, '&gt;')
    .replace(g, '&quot;')
    .replace('g, '&#39;');
}

 ============================================
 MESSENGER API (per page)
 ============================================
function setupMessenger(page) {
  fetch(`httpsgraph.facebook.comv2.6memessenger_profileaccess_token=${page.accessToken}`, {
    method 'POST', headers { 'Content-Type' 'applicationjson' },
    body JSON.stringify({
      get_started { payload 'GET_STARTED' },
      greeting [{ locale 'default', text 'Hey gorgeous! 💕 Tap Get Started to chat with us!' }]
    })
  }).then(r = r.json())
    .then(d = console.log(`[${page.label}] Messenger setup`, d.result  d.error.message  'ok'))
    .catch(e = console.error(`[${page.label}] Messenger setup error`, e.message));
}

function sendCard(page, psid, opts = {}) {
  const rawDest = normalizeUrl(opts.redirect  page.whatsapp  '');
  const trackUrl = `${PUBLIC_URL}trackpsid=${psid}&pageId=${page.pageId}`
    + (rawDest  `&d=${encodeURIComponent(rawDest)}`  '');
  const title = opts.title  page.title;
  const subtitle = opts.subtitle  page.subtitle;
  const photo = opts.photo  getCurrentPhoto(page);
  return fetch(`httpsgraph.facebook.comv2.6memessagesaccess_token=${page.accessToken}`, {
    method 'POST', headers { 'Content-Type' 'applicationjson' },
    body JSON.stringify({
      recipient { id psid },
      message {
        attachment {
          type 'template',
          payload {
            template_type 'generic',
            image_aspect_ratio 'square',
            elements [{
              title, subtitle, image_url photo,
              default_action { type 'web_url', url trackUrl, webview_height_ratio 'tall' },
              buttons [{ type 'web_url', url trackUrl, title page.buttonText }]
            }]
          }
        }
      }
    })
  }).then(r = r.json()).then(data = {
    if (data.error) {
      trackMessage(page.pageId, false);
      const code = data.error.code;
      const msg = data.error.message  '';
      console.log(`[${page.label}] Card failed (psid ${psid}, code ${code})`, msg);
      const unreachable =
        code === 10  code === 100  code === 551 
        outside [ws]allowed windowi.test(msg) 
        no matching useri.test(msg) 
        cannot receive messagesi.test(msg) 
        policy[- ]enforcementi.test(msg);
      if (unreachable && !opts.skipRemoval) {
        trackFailureForFan(page.pageId, psid, `FB error ${code} ${msg.slice(0, 60)}`);
      }
    } else {
      trackMessage(page.pageId, true);
      clearFailuresForFan(page.pageId, psid);
    }
    return data;
  }).catch(err = {
    trackMessage(page.pageId, false);
    console.error(`[${page.label}] Card error (psid ${psid})`, err.message);
    return { error { message err.message } };
  });
}

function sendTextMessage(page, psid, text) {
  return fetch(`httpsgraph.facebook.comv2.6memessagesaccess_token=${page.accessToken}`, {
    method 'POST', headers { 'Content-Type' 'applicationjson' },
    body JSON.stringify({ recipient { id psid }, message { text } })
  }).then(r = r.json()).then(data = {
    if (data.error) { trackMessage(page.pageId, false); }
    else { trackMessage(page.pageId, true); }
    return data;
  }).catch(err = { trackMessage(page.pageId, false); return { error { message err.message } }; });
}

 ============================================
 BROADCAST PROGRESS TRACKER
 ============================================
const broadcastProgress = {};

function startBroadcastTracking(pageId, total, type) {
  broadcastProgress[pageId] = {
    total, done 0, failed 0,
    startedAt Date.now(), finishedAt null,
    type, status total  0  'running'  'complete'
  };
  if (total === 0) broadcastProgress[pageId].finishedAt = Date.now();
}
function tickBroadcast(pageId) {
  const b = broadcastProgress[pageId];
  if (!b) return;
  b.done++;
  if (b.done = b.total) {
    b.status = 'complete';
    b.finishedAt = Date.now();
  }
}

function broadcastToPage(page, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds  10)  1000;
  startBroadcastTracking(page.pageId, fans.length, 'card');
  fans.forEach((psid, i) = {
    setTimeout(async () = {
      try {
        if (opts.textOnly && opts.text) {
          await sendTextMessage(page, psid, opts.text);
        } else {
          await sendCard(page, psid, opts);
        }
      } catch {}
      tickBroadcast(page.pageId);
    }, i  spacing);
  });
  return fans.length;
}

function sendText(page, psid, text, opts = {}) {
  return fetch(`httpsgraph.facebook.comv2.6memessagesaccess_token=${page.accessToken}`, {
    method 'POST', headers { 'Content-Type' 'applicationjson' },
    body JSON.stringify({
      recipient { id psid },
      message { text text }
    })
  }).then(r = r.json()).then(data = {
    if (data.error) {
      trackMessage(page.pageId, false);
      const code = data.error.code;
      const msg = data.error.message  '';
      console.log(`[${page.label}] Text failed (psid ${psid}, code ${code})`, msg);
      const unreachable =
        code === 10  code === 100  code === 551 
        outside [ws]allowed windowi.test(msg) 
        no matching useri.test(msg) 
        cannot receive messagesi.test(msg) 
        policy[- ]enforcementi.test(msg);
      if (unreachable && !opts.skipRemoval) {
        trackFailureForFan(page.pageId, psid, `FB error ${code} ${msg.slice(0, 60)}`);
      }
    } else {
      trackMessage(page.pageId, true);
      clearFailuresForFan(page.pageId, psid);
    }
    return data;
  }).catch(err = {
    trackMessage(page.pageId, false);
    console.error(`[${page.label}] Text error (psid ${psid})`, err.message);
    return { error { message err.message } };
  });
}

function broadcastTextToPage(page, text, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds  10)  1000;
  startBroadcastTracking(page.pageId, fans.length, 'text');
  fans.forEach((psid, i) = {
    setTimeout(async () = {
      try { await sendText(page, psid, text, opts); } catch {}
      tickBroadcast(page.pageId);
    }, i  spacing);
  });
  return fans.length;
}

 ============================================
 PUBLIC ROUTES — no auth
 ============================================
app.get('webhook', (req, res) = {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('webhook', (req, res) = {
  if (req.body.object !== 'page') return res.sendStatus(404);
  req.body.entry.forEach(entry = {
    const pageId = entry.id;
    const page = getPage(pageId);
    if (!page) {
      console.warn(`Webhook received for unknown page ${pageId}`);
      return;
    }
    (entry.messaging  []).forEach(event = {
      const psid = event.sender.id;
      if (!psid) return;
      if (event.read) { trackRead(pageId, psid, event.read.watermark); return; }
      if (event.delivery) { trackDelivery(pageId, psid, event.delivery.watermark); return; }
      const isNewFan = !isFanSaved(pageId, psid);
      saveFan(pageId, psid);
      if (event.postback.payload === 'GET_STARTED') {
        sendCard(page, psid);
      } else if (event.message && isNewFan) {
        sendCard(page, psid);
      }
    });
  });
  res.status(200).send('EVENT_RECEIVED');
});

app.get('track', (req, res) = {
  const pageId = req.query.pageId;
  const psid = req.query.psid  'unknown';
  const page = getPage(pageId);
  const mr = getMasterRedirect();
  let dest;
  if (mr.enabled && mr.url) dest = mr.url;
  else if (req.query.d) dest = req.query.d;
  else dest = page  page.whatsapp  getDefaults().whatsapp;
  dest = normalizeUrl(dest);
  res.redirect(dest);
  if (page) {
    setImmediate(() = {
      try { trackClick(pageId, psid); }
      catch (e) { console.error(`[${page.label}] Click tracking failed`, e.message); }
    });
  }
});

 ============================================
 🔒 AUTH WALL
 ============================================
app.use(basicAuth({
  users { [ADMIN_USER] ADMIN_PASS },
  challenge true,
  realm 'messagebot'
}));

 ============================================
 CSS
 ============================================
const CSS = `
   { box-sizing border-box; }
  body { font-family -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; background #f5f6fa; margin 0; padding 0; color #2c3e50; }
  .topbar { background #1a1d2e; color #fff; padding 14px 24px; display flex; align-items center; justify-content space-between; flex-wrap wrap; gap 12px; }
  .topbar h1 { margin 0; font-size 22px; font-weight 700; }
  .topbar .meta { font-size 13px; opacity 0.7; }
  .topbar select { background #2c3142; color #fff; border 1px solid #3a4055; padding 8px 12px; border-radius 6px; font-size 14px; }
  .container { max-width 1200px; margin 24px auto; padding 0 16px; }
  .card { background #fff; border-radius 10px; padding 22px; margin-bottom 18px; box-shadow 0 1px 3px rgba(0,0,0,0.06); }
  .card h2 { margin 0 0 14px 0; font-size 18px; color #1a1d2e; border-bottom 2px solid #f0f1f5; padding-bottom 10px; }
  .card h3 { margin 18px 0 10px 0; font-size 15px; color #4a5568; }
  .grid { display grid; gap 12px; grid-template-columns repeat(auto-fit, minmax(160px, 1fr)); }
  .stat { background #f7f8fc; padding 14px; border-radius 8px; border-left 3px solid #3a8dde; }
  .stat .v { font-size 26px; font-weight 700; color #1a1d2e; }
  .stat .l { font-size 12px; color #6b7280; text-transform uppercase; letter-spacing 0.5px; margin-top 4px; }
  label { display block; font-size 13px; font-weight 600; color #4a5568; margin 10px 0 4px 0; }
  input[type=text], input[type=url], input[type=number], input[type=time], input[type=datetime-local], select, textarea { width 100%; padding 9px 12px; border 1px solid #d1d5db; border-radius 6px; font-size 14px; font-family inherit; }
  textarea { min-height 90px; resize vertical; }
  .btn { display inline-block; padding 9px 16px; border none; border-radius 6px; font-size 14px; font-weight 600; cursor pointer; text-decoration none; color #fff; background #6b7280; margin-top 8px; }
  .btnhover { opacity 0.9; }
  .btn-green { background #28a745; }
  .btn-blue { background #3a8dde; }
  .btn-red { background #dc3545; }
  .btn-orange { background #f59e0b; }
  .row { display grid; gap 12px; grid-template-columns 1fr 1fr; }
  @media (max-width 700px) { .row { grid-template-columns 1fr; } }
  table { width 100%; border-collapse collapse; }
  th, td { text-align left; padding 10px 8px; border-bottom 1px solid #e5e7eb; font-size 14px; }
  th { background #f7f8fc; font-weight 600; color #4a5568; font-size 12px; text-transform uppercase; letter-spacing 0.5px; }
  .badge { display inline-block; padding 3px 9px; border-radius 12px; font-size 11px; font-weight 600; text-transform uppercase; }
  .badge-green { background #d4edda; color #155724; }
  .badge-gray { background #e5e7eb; color #4a5568; }
  .actions { display flex; gap 5px; flex-wrap nowrap; }
  .qbtn { padding 5px 9px; border none; border-radius 5px; font-size 11px; font-weight 600; cursor pointer; color #fff; text-decoration none; display inline-block; white-space nowrap; }
  .qbtn-pause { background #f59e0b; }
  .qbtn-resume { background #28a745; }
  .qbtn-send { background #3a8dde; }
  .qbtn-open { background #6b7280; }
  .qbtnhover { opacity 0.9; }
  .funnel { display flex; gap 8px; flex-wrap wrap; margin 10px 0; }
  .funnel .step { flex 1; min-width 140px; background #f7f8fc; padding 12px; border-radius 8px; text-align center; }
  .funnel .step .v { font-size 22px; font-weight 700; color #1a1d2e; }
  .funnel .step .l { font-size 11px; color #6b7280; text-transform uppercase; margin-top 4px; }
  .funnel .step .pct { font-size 11px; color #28a745; margin-top 2px; }
  .photo-grid { display grid; grid-template-columns repeat(auto-fill, minmax(180px, 1fr)); gap 12px; }
  .photo-grid .item { background #f7f8fc; padding 8px; border-radius 8px; border 2px solid transparent; }
  .photo-grid .item.current { border-color #28a745; background #d4edda; }
  .photo-grid .item .img-wrap { position relative; width 100%; aspect-ratio 1  1; background #e5e7eb; border-radius 6px; overflow hidden; }
  .photo-grid .item img { width 100%; height 100%; object-fit cover; display block; }
  .photo-grid .item .url-row { display flex; gap 4px; margin-top 6px; }
  .photo-grid .item .url-row input { flex 1; padding 5px 8px; border 1px solid #d1d5db; border-radius 4px; font-size 10px; font-family monospace; background #fff; }
  .photo-grid .item .url-row a { background #dc3545; color white; padding 5px 8px; border-radius 4px; text-decoration none; font-size 11px; font-weight 600; }
  .photo-grid .item .action-row { display flex; gap 5px; margin-top 6px; flex-wrap wrap; align-items center; }
  .photo-grid .item .ph-btn { padding 4px 8px; border none; border-radius 4px; font-size 10px; font-weight 600; cursor pointer; text-decoration none; color #fff; display inline-block; white-space nowrap; }
  .photo-grid .item .ph-copy { background #6b7280; }
  .photo-grid .item .ph-active { background #3a8dde; }
  .photo-grid .item .ph-remove { background #dc3545; }
  .photo-grid .item .badge-current { display inline-block; background #28a745; color white; font-size 10px; font-weight 700; padding 4px 8px; border-radius 4px; }
  .danger-zone { border 1px solid #fca5a5; background #fef2f2; }
  .danger-zone h2 { color #991b1b; border-color #fecaca; }
  .alert { padding 10px 14px; border-radius 6px; margin-bottom 14px; font-size 14px; }
  .alert-success { background #d4edda; color #155724; }
  .alert-error { background #f8d7da; color #721c24; }
  .helper { font-size 12px; color #6b7280; margin-top 4px; }
  details  summary { list-style none; }
  details  summary-webkit-details-marker { display none; }
  details[open]  summary .bp-arrow { transform rotate(90deg); }
  details  summaryhover { background #fffbeb; }
  details { margin 10px 0; }
  summary { cursor pointer; font-weight 600; color #4a5568; padding 6px 0; }
  .group-badge { display inline-block; padding 2px 8px; border-radius 10px; font-size 11px; font-weight 700; background #ede9fe; color #6d28d9; }
  .group-badge.unassigned { background #f1f5f9; color #94a3b8; }
`;

function renderHead(title) {
  return `!DOCTYPE htmlhtmlheadmeta charset=utf-8meta name=viewport content=width=device-width, initial-scale=1.0title${esc(title)}titlestyle${CSS}styleheadbody`;
}

function renderTopbar(pages, selectedPageId) {
  const opts = pages.map(p =
    `option value=${esc(p.pageId)} ${p.pageId === selectedPageId  'selected'  ''}${esc(p.label)} (${esc(p.pageId)})option`
  ).join('');
  return `div class=topbar
    h1📨 messageboth1
    form method=GET action= style=margin0;
      select name=page onchange=this.form.submit()
        option value=all ${!selectedPageId  selectedPageId === 'all'  'selected'  ''}🌍 All Pages (aggregate)option
        option value=templates ${selectedPageId === 'templates'  'selected'  ''}🎴 Card Templatesoption
        ${opts}
      select
    form
    div class=metaUptime ${uptimeText()} · Pages ${pages.length}div
  div`;
}

function renderAlerts(req) {
  const q = req.query;
  let alerts = '';
  if (q.saved) alerts += `div class=alert alert-success✅ Saved!div`;
  if (q.schedule_saved) alerts += `div class=alert alert-success✅ Schedule saved!div`;
  if (q.text_saved) alerts += `div class=alert alert-success✅ Text template saved!div`;
  if (q.lib_msg) alerts += `div class=alert alert-success✅ ${esc(q.lib_msg)}div`;
  if (q.added) alerts += `div class=alert alert-success✅ Page added! Webhook is now active for it.div`;
  if (q.removed) alerts += `div class=alert alert-success✅ Page removed.div`;
  if (q.error) alerts += `div class=alert alert-error❌ ${esc(q.error)}div`;
  return alerts;
}

 ============================================
 PAGE GROUPS MANAGER SECTION (rendered on All Pages view)
 ============================================
function renderGroupManager(pages) {
  const groups = getAllGroups(pages);
  const unassigned = pages.filter(p = !p.group  !p.group.trim());

  const pills = groups.map(g = {
    const count = pages.filter(p = p.group === g).length;
    const fans = pages.filter(p = p.group === g).reduce((acc, p) = acc + loadFans(p.pageId).length, 0);
    return `div style=background#ede9fe;border1px solid #c4b5fd;border-radius8px;padding10px 14px;displayinline-flex;align-itemscenter;gap10px;
      div
        div style=font-weight700;color#6d28d9;font-size14px;${esc(g)}div
        div style=font-size11px;color#7c3aed;${count} pages xb7 ${fans} fansdiv
      div
      form action=group-delete method=POST style=margin0;
        input type=hidden name=group value=${esc(g)}
        button type=submit title=Delete group onclick=return confirm('Delete group &quot;${esc(g)}&quot; Pages will become unassigned.') style=backgroundnone;bordernone;cursorpointer;color#dc2626;font-size16px;padding0;line-height1;xd7button
      form
    div`;
  }).join('');

  return `
    div class=card style=border2px solid #c4b5fd;
      h2ud83dudce6 Page Groups span style=font-size12px;font-weight400;color#7c3aed;u2014 send to Part 1, Part 2, Part 3 separately or all at oncespanh2

      div style=displayflex;flex-wrapwrap;gap10px;margin-bottom16px;
        ${pills  'span style=color#94a3b8;font-size13px;No groups yet u2014 create one below.span'}
        ${unassigned.length  `div style=background#f1f5f9;border1px solid #e2e8f0;border-radius8px;padding10px 14px;displayinline-flex;align-itemscenter;
          div style=font-size13px;color#94a3b8;u2b1c Unassigned strong${unassigned.length} pagesstrongdiv
        div`  ''}
      div

      form action=group-create method=POST style=displayflex;gap8px;align-itemscenter;flex-wrapwrap;
        input type=text name=group autocomplete=off placeholder='New group name, e.g. Part 1' style=flex1;min-width200px;max-width320px;padding8px 12px;border1px solid #c4b5fd;border-radius6px;font-size14px;
        button type=submit class=btn style=background#6d28d9;color#fff;margin-top0;u2795 Create Groupbutton
      form
    div`;
}

 ============================================
 SEND NOW GROUP SELECTOR (rendered above the pages table)
 ============================================
function renderGroupSendNow(pages) {
  const groups = getAllGroups(pages);
  const eligibleAll = pages.filter(p = p.sendNowEnabled !== false);

  const groupOptions = groups.map(g = {
    const gPages = pages.filter(p = p.group === g && p.sendNowEnabled !== false);
    const totalFans = gPages.reduce((acc, p) = acc + loadFans(p.pageId).length, 0);
    return `option value=${esc(g)}${esc(g)} — ${gPages.length} pages · ${totalFans} fansoption`;
  }).join('');

  const allFans = eligibleAll.reduce((acc, p) = acc + loadFans(p.pageId).length, 0);

  return `
    div style=margin-bottom12px;padding14px;background#f0fdf4;border2px solid #86efac;border-radius8px;
      div style=font-size13px;font-weight700;color#166534;margin-bottom10px;📣 Send Now span style=font-weight400;color#16a34a;— choose a group or send to all eligible pagesspandiv

      div style=displayflex;gap8px;flex-wrapwrap;align-itemscenter;margin-bottom10px;
        !-- GROUP SEND --
        ${groups.length  0  `
        form action=send-now-group method=POST style=displayinline;margin0;
          div style=displayflex;gap6px;align-itemscenter;flex-wrapwrap;
            select name=group style=padding7px 10px;border1px solid #86efac;border-radius6px;font-size13px;background#fff;color#166534;font-weight600;
              ${groupOptions}
            select
            button type=submit class=qbtn style=background#16a34a; onclick=return confirm('Send Now to selected group')📣 Send to Groupbutton
            button type=submit name=randomize value=1 class=qbtn style=background#7c3aed; onclick=return confirm('Randomize + Send to selected group')🎲📣 Randomize + Send Groupbutton
          div
        form
        span style=color#cbd5e1;font-size18px;span`  ''}

        !-- SEND ALL --
        form action=send-now-all method=POST style=displayinline;margin0;
          button type=submit class=qbtn style=background#166534; onclick=return confirm('SEND NOW to ALL eligible pages (${eligibleAll.length} pages · ${allFans} fans)nnPages with Send Now PAUSED are skipped.')📣 Send All (${eligibleAll.length} pages)button
        form
        form action=send-now-allrandomize=1 method=POST style=displayinline;margin0;
          button type=submit class=qbtn style=background#5b21b6; onclick=return confirm('RANDOMIZE + SEND to ALL eligible pages (${eligibleAll.length} pages)')🎲📣 Randomize + Send Allbutton
        form
      div

      div style=displayflex;gap8px;flex-wrapwrap;align-itemscenter;
        form action=pause-sendnow-all method=POST style=displayinline;margin0;
          button type=submit class=qbtn style=background#f59e0b; onclick=return confirm('Pause Send Now on ALL pages')🚫 Pause Send Now (All)button
        form
        form action=resume-sendnow-all method=POST style=displayinline;margin0;
          button type=submit class=qbtn style=background#16a34a; onclick=return confirm('Resume Send Now on ALL pages')✅ Resume Send Now (All)button
        form
      div
    div`;
}

function renderPageLibrarySection(page) {
  const lib = loadLibrary();
  const pid = esc(page.pageId);
  const currentSet = pageSet(page, lib);
  const setNames = getSetNames(lib);
  const pool = lib.redirectSets[currentSet]  [];

  const photoThumbs = lib.photos.map((url, i) = {
    const active = url === page.currentPhoto;
    return `a href=set-active-from-librarypage=${pid}&photoIndex=${i} title=Set as active photo style=positionrelative;displayblock;border2px solid ${active  '#28a745'  '#e2e8f0'};border-radius8px;overflowhidden;text-decorationnone;
      img src=${esc(url)} style=width100%;height70px;object-fitcover;displayblock; onerror=this.style.display='none';this.nextElementSibling.style.display='flex';
      div style=displaynone;width100%;height70px;align-itemscenter;justify-contentcenter;background#f1f5f9;color#94a3b8;font-size9px;text-aligncenter;padding3px;${esc(url.split('').pop())}div
      ${active  'div style=positionabsolute;top2px;right2px;background#28a745;color#fff;font-size9px;padding1px 5px;border-radius4px;★ activediv'  ''}
    a`;
  }).join('');

  const redirectBtns = pool.map((url, i) = {
    const active = url === page.whatsapp;
    const short = url.replace(^https, '').replace(^www., '');
    return `a href=set-active-from-librarypage=${pid}&redirectIndex=${i} title=Set as active redirect style=displayinline-flex;align-itemscenter;gap4px;background${active  '#dcfce7'  '#fff'};border1px solid ${active  '#28a745'  '#e2e8f0'};border-radius6px;padding5px 9px;font-size11px;font-familymonospace;text-decorationnone;color${active  '#166534'  '#475569'};
      ${active  '★ '  ''}${esc(short)}
    a`;
  }).join('');

  const setButtons = setNames.map(name = {
    const isCurrent = name === currentSet;
    const count = (lib.redirectSets[name]  []).length;
    return `form action=set-page-redirect-setpage=${pid} method=POST style=margin0;displayinline;
      input type=hidden name=setName value=${esc(name)}
      button type=submit class=btn style=background${isCurrent  '#16a34a'  '#e2e8f0'};color${isCurrent  '#fff'  '#475569'};border${isCurrent  '2px solid #15803d'  '2px solid transparent'};
        ${isCurrent  '✓ '  ''}${esc(name)} (${count})
      button
    form`;
  }).join('');

  return `
    div class=card style=border2px solid #ede9fe;
      h2🎲 Quick Switch &amp; Randomize span style=font-size12px;font-weight400;color#8b5cf6;— photo pool shared · redirect by setspanh2

      div style=background#ecfdf5;border1px solid #a7f3d0;border-radius8px;padding12px;margin-bottom16px;
        div style=font-size13px;font-weight600;color#065f46;margin-bottom8px;🌐 Redirect Set for this pagediv
        div style=displayflex;gap8px;flex-wrapwrap;${setButtons}div
        div style=font-size11px;color#047857;margin-top8px;Currently using strong${esc(currentSet)}strongdiv
      div

      div style=displayflex;gap8px;flex-wrapwrap;margin-bottom16px;
        ${(function(){
          var mode = pageContentMode(page);
          if (mode === 'templates') {
            var tcount = templatesForSet(loadLibrary(), currentSet).length;
            return `
        div style=width100%;font-size12px;color#7c3aed;margin-bottom4px;🎴 This page is in strongTemplatesstrong mode — randomize picks a complete card from the ${esc(currentSet)} set (${tcount} templates).div
        form action=randomize-pagepage=${pid} method=POST style=margin0;
          button type=submit class=btn style=background#8b5cf6;color#fff;🎴 Pick Random Templatebutton
        form
        form action=randomize-and-sendpage=${pid} method=POST style=margin0;
          button type=submit class=btn style=background#7c3aed;color#fff; onclick=return confirm('Pick a random template, then immediately broadcast to all fans')🎴🚀 Random Template + Sendbutton
        form`;
          }
          return `
        div style=width100%;font-size12px;color#6366f1;margin-bottom4px;📷 This page is in strongClassicstrong mode — randomize picks a photo from the shared pool + a URL from the ${esc(currentSet)} set.div
        form action=randomize-pagepage=${pid} method=POST style=margin0;
          button type=submit class=btn style=background#8b5cf6;color#fff;🎲 Randomize (Photo + URL)button
        form
        form action=randomize-pagepage=${pid}&only=photo method=POST style=margin0;
          button type=submit class=btn style=background#a78bfa;color#fff;🎲 Photo Onlybutton
        form
        form action=randomize-pagepage=${pid}&only=redirect method=POST style=margin0;
          button type=submit class=btn style=background#a78bfa;color#fff;🎲 URL Onlybutton
        form
        form action=randomize-and-sendpage=${pid} method=POST style=margin0;
          button type=submit class=btn style=background#7c3aed;color#fff; onclick=return confirm('Randomize photo + URL, then immediately broadcast to all fans')🎲🚀 Randomize + Sendbutton
        form`;
        })()}
      div

      div style=background#faf5ff;border-radius8px;padding12px;margin-bottom14px;font-size12px;
        divstrongActive nowstrongdiv
        div style=margin-top4px;color#6b21a8;📸 ${esc((page.currentPhoto  '(none)').split('').pop())}div
        div style=color#6b21a8;🔗 ${esc((page.whatsapp  '(none)').replace(^https, ''))}div
      div

      h3 style=font-size14px;color#1a1d2e;margin0 0 8px;📸 Tap a photo to set active (${lib.photos.length} — shared pool)h3
      div style=displaygrid;grid-template-columnsrepeat(auto-fill,minmax(85px,1fr));gap8px;margin-bottom16px;
        ${photoThumbs  'span style=color#94a3b8;font-size12px;Library empty.span'}
      div

      h3 style=font-size14px;color#1a1d2e;margin0 0 8px;🔗 Tap a URL to set active — from ${esc(currentSet)} set (${pool.length})h3
      div style=displayflex;flex-wrapwrap;gap6px;
        ${redirectBtns  'span style=color#94a3b8;font-size12px;This set is empty.span'}
      div
      div class=helper style=margin-top12px;Photos are shared by all pages. Redirect URLs come from this page's assigned set.div
    div`;
}

function renderLibraryManager() {
  const lib = loadLibrary();
  const photoChips = lib.photos.map((url, i) = `
    div style=positionrelative;border1px solid #e2e8f0;border-radius8px;overflowhidden;background#fff;
      img src=${esc(url)} style=width100%;height80px;object-fitcover;displayblock; onerror=this.style.display='none';this.nextElementSibling.style.display='flex';
      div style=displaynone;width100%;height80px;align-itemscenter;justify-contentcenter;background#f1f5f9;color#94a3b8;font-size10px;text-aligncenter;padding4px;${esc(url.split('').pop())}div
      a href=library-remove-photoindex=${i} onclick=return confirm('Remove this photo from the shared library') style=positionabsolute;top3px;right3px;backgroundrgba(220,38,38,0.9);color#fff;width18px;height18px;border-radius50%;font-size11px;line-height18px;text-aligncenter;text-decorationnone;×a
      div style=font-size9px;color#94a3b8;text-aligncenter;padding2px;#${i + 1}div
    div`).join('');

  const setNames = getSetNames(lib);
  const setSections = setNames.map(name = {
    const urls = lib.redirectSets[name]  [];
    const chips = urls.map((url, i) = {
      const short = url.replace(^https, '').replace(^www., '');
      return `div style=displayinline-flex;align-itemscenter;gap4px;background#fff;border1px solid #e2e8f0;border-radius6px;padding4px 8px;font-size11px;font-familymonospace;
        span style=color#475569;${esc(short)}span
        a href=library-remove-redirectset=${encodeURIComponent(name)}&index=${i} onclick=return confirm('Remove this URL') style=color#dc2626;text-decorationnone;font-weight700;×a
      div`;
    }).join('');
    const color = name === DEFAULT_SET  '#3a8dde'  '#f59e0b';
    return `
      div style=margin-top14px;border1px solid #e2e8f0;border-left4px solid ${color};border-radius8px;padding12px;background#fafbfc;
        h4 style=margin0 0 8px;font-size13px;color#1a1d2e;🌐 ${esc(name)} span style=font-weight400;color#94a3b8;(${urls.length} URLs)spanh4
        div style=displayflex;flex-wrapwrap;gap6px;margin-bottom10px;
          ${chips  'span style=color#94a3b8;font-size12px;No URLs in this set yet.span'}
        div
        form action=library-add-redirect method=POST style=displayflex;gap8px;flex-wrapwrap;align-itemsflex-start;
          input type=hidden name=setName value=${esc(name)}
          textarea name=redirectUrls placeholder=Paste URL(s) for ${esc(name)} (one per line or comma-separated) style=flex1;min-width240px;min-height44px;padding8px;border1px solid #cbd5e1;border-radius6px;font-familymonospace;font-size12px;textarea
          button type=submit class=btn btn-green style=white-spacenowrap;+ Add to ${esc(name)}button
        form
      div`;
  }).join('');

  return `
    div class=card style=border2px solid #ede9fe;padding0;overflowhidden;
      details
        summary style=cursorpointer;padding14px 20px;displayflex;align-itemscenter;gap10px;user-selectnone;list-stylenone;
          span style=font-size14px;color#8b5cf6;transitiontransform 0.2s;displayinline-block; class=bp-arrow▶span
          span style=font-size16px;font-weight700;color#1a1d2e;🗂️ Shared Libraryspan
          span style=font-size12px;color#94a3b8;margin-left4px;${lib.photos.length} photos · ${Object.values(lib.redirectSets).reduce((a,s)=a+s.length,0)} redirect URLsspan
        summary
        div style=padding0 20px 20px;
          div style=margin-top16px;
            h3 style=margin0 0 8px;font-size14px;📸 Shared Photos (${lib.photos.length})h3
            div style=displaygrid;grid-template-columnsrepeat(auto-fill,minmax(90px,1fr));gap8px;margin-bottom10px;
              ${photoChips  'span style=color#94a3b8;font-size12px;No photos yet.span'}
            div
            form action=library-add-photo method=POST style=displayflex;gap8px;flex-wrapwrap;align-itemsflex-start;
              textarea name=photoUrls placeholder=Paste one or more image URLs (one per line or comma-separated) style=flex1;min-width260px;min-height48px;padding8px;border1px solid #cbd5e1;border-radius6px;font-familymonospace;font-size12px;textarea
              button type=submit class=btn btn-green style=white-spacenowrap;+ Add Photo(s)button
            form
          div
          div style=margin-top20px;border-top1px solid #f1f5f9;padding-top16px;
            h3 style=margin0 0 4px;font-size14px;🔗 Redirect Setsh3
            ${setSections}
          div

          div style=margin-top20px;border-top1px solid #f1f5f9;padding-top16px;
            h3 style=margin0 0 4px;font-size14px;🔄 Classic Mode Rotation Pools span style=font-weight400;color#94a3b8;font-size12px;— randomize picks one from each pool automaticallyspanh3

            ${[
              { key 'titles', label 'Card Titles', emoji '📝', placeholder 'Sandra 58 💕nJennifer 56 🌹nRebecca 54 ❤️', hint 'One per line — the name shown at the top of the card' },
              { key 'subtitles', label 'Card Subtitles', emoji '💬', placeholder 'I live alone, may I send you a friend requestnI'm a widow 🖤 May I get to know you', hint 'One per line — the text under the name' },
              { key 'buttonTexts', label 'Button Texts', emoji '🔘', placeholder 'My Photos 📞nCome See Me 💋nSee My Gallery 📸', hint 'One per line — the button label fans click' }
            ].map(({ key, label, emoji, placeholder, hint }) = {
              const items = lib[key]  [];
              const chips = items.map((item, i) =
                `div style=displayinline-flex;align-itemscenter;gap4px;background#fff;border1px solid #e2e8f0;border-radius6px;padding4px 8px;font-size12px;max-width100%;word-breakbreak-word;
                  span style=color#1a1d2e;${esc(item)}span
                  a href=library-remove-textkey=${encodeURIComponent(key)}&index=${i} onclick=return confirm('Remove this item') style=color#dc2626;text-decorationnone;font-weight700;flex-shrink0;×a
                div`
              ).join('');
              return `
              div style=margin-top14px;border1px solid #e2e8f0;border-left4px solid #6366f1;border-radius8px;padding12px;background#fafbfc;
                h4 style=margin0 0 6px;font-size13px;color#1a1d2e;${emoji} ${esc(label)} span style=font-weight400;color#94a3b8;(${items.length} items)spanh4
                div style=font-size11px;color#6b7280;margin-bottom8px;${esc(hint)}div
                div style=displayflex;flex-wrapwrap;gap6px;margin-bottom10px;
                  ${chips  'span style=color#94a3b8;font-size12px;No items yet — add some below.span'}
                div
                form action=library-add-text method=POST style=displayflex;gap8px;flex-wrapwrap;align-itemsflex-start;
                  input type=hidden name=key value=${esc(key)}
                  textarea name=items placeholder=${esc(placeholder)} style=flex1;min-width240px;min-height60px;padding8px;border1px solid #cbd5e1;border-radius6px;font-familyinherit;font-size13px;resizevertical;textarea
                  button type=submit class=btn btn-green style=white-spacenowrap;+ Add to ${esc(label)}button
                form
              div`;
            }).join('')}
          div
        div
      details
    div`;
}

function renderTemplateManager(req) {
  const lib = loadLibrary();
  const setNames = getSetNames(lib);
  const templates = lib.cardTemplates  [];
  const setOptions = setNames.map(n = `option value=${esc(n)}${esc(n)}option`).join('');

  const sections = setNames.map(setName = {
    const list = templates.filter(t = (t.set  DEFAULT_SET) === setName);
    const color = setName === DEFAULT_SET  '#3a8dde'  '#f59e0b';
    const cards = list.map(t = {
      const otherSet = (t.set === SECOND_SET)  DEFAULT_SET  SECOND_SET;
      const photoCount = (Array.isArray(t.photos) && t.photos.length)  t.photos.length  (t.photo  1  0);
      const isActive = t.active !== false;
      const isLinked = !!t.linkedId;
      const partner = isLinked  templates.find(x = x.id === t.linkedId)  null;
      const linkedBadge = isLinked
         `div style=background#dcfce7;border1px solid #86efac;border-radius5px;padding3px 7px;font-size10px;font-weight700;color#166534;margin-bottom6px;displayflex;align-itemscenter;gap4px;
            🔗 Linked to ${esc(otherSet)} ${partner  '· em style=font-weight400;' + esc(partner.title  partner.id) + 'em'  '· (partner missing)'}
            a href=template-unlinkid=${t.id} onclick=return confirm('Unlink this pair Both cards become independent — edits will no longer sync.') style=margin-leftauto;color#dc2626;text-decorationnone;font-weight700;font-size12px; title=Unlink✕a
           div`
         `div style=background#f1f5f9;border-radius5px;padding3px 7px;font-size10px;color#94a3b8;margin-bottom6px;⬜ Not linked — edits only affect this carddiv`;
      return `
      div id=tmpl-${t.id} style=background#fff;border1px solid #e2e8f0;border-left3px solid ${color};border-radius8px;overflowhidden;${isActive  ''  'opacity0.5;filtergrayscale(0.7);'}
        div style=width100%;aspect-ratio11;background#f1f5f9;displayflex;align-itemscenter;justify-contentcenter;positionrelative;
          img src=${esc(t.photo)} style=width100%;height100%;object-fitcover;displayblock; onerror=this.style.display='none';this.parentElement.style.color='#94a3b8';this.parentElement.style.fontSize='12px';this.parentElement.textContent='no photo';
          ${photoCount  1  `span style=positionabsolute;top6px;left6px;backgroundrgba(0,0,0,0.6);color#fff;font-size10px;font-weight700;padding2px 7px;border-radius10px;📷 ${photoCount}span`  ''}
          ${isLinked  `span style=positionabsolute;bottom6px;right6px;backgroundrgba(22,163,74,0.9);color#fff;font-size9px;font-weight700;padding2px 6px;border-radius6px;🔗 LINKEDspan`  ''}
          ${isActive  ''  `span style=positionabsolute;top6px;right6px;background#64748b;color#fff;font-size9px;font-weight700;padding2px 7px;border-radius8px;PAUSEDspan`}
        div
        div style=padding10px 12px;
          label style=displayflex;align-itemscenter;gap5px;font-size11px;font-weight600;color#475569;margin-bottom6px;cursorpointer;input type=checkbox class=tmpl-sel value=${t.id} onclick=event.stopPropagation(); style=widthauto; Selectlabel
          ${linkedBadge}
          div style=font-weight600;font-size14px;color#1a1d2e;${esc(t.title  '(no title)')}div
          div style=font-size12px;color#6b7280;margin3px 0;line-height1.5;${esc(t.subtitle  '(no subtitle)')}div
          div style=font-size11px;color#94a3b8;font-familymonospace;margin-top4px;word-breakbreak-all;🔘 ${esc(t.buttonText)} · 🔗 ${esc((t.redirect  '(no redirect)').replace(^https, ''))}div
          div style=displayflex;gap6px;margin-top10px;
            button type=button class=qbtn onclick=editTmpl('${t.id}') style=background#6366f1;flex1;✏️ Editbutton
            button type=button class=qbtn tmpl-dup-btn data-id=${t.id} data-otherset=${esc(otherSet)} style=background#0ea5e9; title=Duplicate + link to ${esc(otherSet)}⧉🔗button
            ${!isLinked  `button type=button class=qbtn tmpl-link-btn data-id=${t.id} data-otherset=${esc(otherSet)} style=background#16a34a; title=Link to existing ${esc(otherSet)} card🔗button`  ''}
            a href=template-deleteid=${t.id} onclick=return confirm('Delete this template') class=qbtn style=background#dc2626;🗑️a
          div
        div
      div`;
    }).join('');

    return `
      div style=margin-top18px;
        h3 style=font-size15px;color#1a1d2e;margin0 0 4px;border-left4px solid ${color};padding-left8px;🌐 ${esc(setName)} templates span style=font-weight400;color#94a3b8;(${list.length})spanh3
        div style=displaygrid;grid-template-columnsrepeat(auto-fill,minmax(180px,1fr));gap12px;margin-top8px;
          ${cards  'span style=color#94a3b8;font-size13px;padding8px;No templates for ' + esc(setName) + ' yet.span'}
        div
      div`;
  }).join('');

  return `div class=container
    ${renderAlerts(req)}
    ${renderMasterRedirectCard()}
    div class=card
      h2🎴 Card Templatesh2
      div style=background#eff6ff;border1px solid #bfdbfe;border-radius8px;padding10px 14px;font-size13px;color#1e40af;margin-top10px;
        strongTotal ${templates.length} templatesstrong · Scrollgallery ${templates.filter(t = (t.setDEFAULT_SET)===DEFAULT_SET).length} · TheViralBox ${templates.filter(t = t.set===SECOND_SET).length}
      div
    div
    div class=card style=border2px solid #c7d2fe;
      h2 id=form-title➕ Add New Templateh2
      form action=template-add method=POST id=tmpl-form onsubmit=return validateTmplForm();
        input type=hidden name=id id=f-id value=
        div style=background#f0f9ff;border1px solid #bae6fd;border-radius8px;padding10px 12px;margin-bottom14px;
          label style=font-weight600;color#0369a1;⚡ Quick paste from sheetlabel
          textarea id=f-rawrow placeholder=Paste a row copied from your spreadsheet here, then click Fill fields. style=width100%;min-height54px;font-size12px;margin-top6px;font-familymonospace;textarea
          button type=button class=btn style=background#0ea5e9;color#fff;margin-top6px; onclick=fillFromRow()⤵️ Fill fields from rowbutton
        div
        div style=displaygrid;grid-template-columns1fr 1fr;gap12px;
          div
            labelCard Title (the name)label
            input name=title id=f-title placeholder=e.g. Elizabeth 56 💕 style=width100%;
          div
        div
        label style=margin-top10px;displayblock;Card Subtitlelabel
        input name=subtitle id=f-subtitle placeholder=e.g. You just seem like someone interesting... style=width100%;
        div style=margin-top10px;
          labelButton Textlabel
          input name=buttonText id=f-button placeholder=My Photos 📞 style=width100%;
        div
        label style=margin-top10px;displayblock;Photoslabel
        input type=hidden name=photos id=f-photos value=[]
        input type=hidden name=activePhotos id=f-active-photos value=[]
        div style=displayflex;gap8px;margin-top4px;
          input type=text id=f-photo-add placeholder=httpsi.imgur.comxxxxx.png style=flex1;font-familymonospace;font-size12px;
          button type=button class=btn btn-green style=white-spacenowrap; onclick=addPhotoToForm()+ Add photobutton
        div
        div id=f-dropzone style=margin-top8px;border2px dashed #cbd5e1;border-radius8px;padding14px;text-aligncenter;color#94a3b8;font-size13px;cursorpointer;📂 Drag &amp; drop a photo here (or click) to upload to Imgurdiv
        div id=f-photo-grid style=displaygrid;grid-template-columnsrepeat(auto-fill,minmax(200px,1fr));gap12px;margin-top10px;div

        div style=margin-top14px;background#f0f9ff;border1px solid #bae6fd;border-radius8px;padding12px;
          div style=font-size13px;font-weight700;color#0369a1;margin-bottom10px;🔗 Redirect URLs — one per website span style=font-weight400;font-size11px;color#0284c7;(fill the ones you have — one card is created per filled URL, all linked together)spandiv
          ${setNames.map(name = {
            const color = name === DEFAULT_SET  '#3a8dde'  '#f59e0b';
            const placeholder = name === DEFAULT_SET
               'httpsscrollgallery.comp=51185'
               name === SECOND_SET
               'httpsphotos.theviralbox.infoarchives2977'
               'https...';
            return `div style=displayflex;align-itemscenter;gap8px;margin-bottom8px;
              span style=background${color};color#fff;font-size11px;font-weight700;padding3px 10px;border-radius5px;white-spacenowrap;min-width110px;text-aligncenter;${esc(name)}span
              input name=redirect_${esc(name)} id=f-redirect-${esc(name)} placeholder=${esc(placeholder)} style=flex1;font-familymonospace;font-size12px;padding8px;border1px solid #cbd5e1;border-radius6px;
            div`;
          }).join('')}
          div style=font-size11px;color#0369a1;margin-top4px;💡 Leave a URL blank to skip that website. Fill all to create cards for all sites at once.div
        div

        !-- Hidden fields kept for edit mode (single-card editing) --
        input type=hidden name=redirect id=f-redirect value=
        div id=f-linked-block style=displaynone;
          input type=hidden name=linkedRedirect id=f-linked-redirect value=
          input type=hidden name=linkedId id=f-linked-id value=
        div
        div style=margin-top14px;displayflex;gap8px;
          button type=submit class=btn btn-green id=f-submit➕ Add Templatebutton
          button type=button onclick=resetForm() class=btn style=background#e2e8f0;color#475569;displaynone; id=f-cancelCancel Editbutton
        div
      form
    div
    div class=card
      h2📋 Existing Templatesh2
      div style=displayflex;gap8px;flex-wrapwrap;align-itemscenter;background#f7f8fc;border1px solid #e2e8f0;border-radius8px;padding10px 12px;margin-bottom6px;
        span style=font-size12px;font-weight600;color#475569;Tick cards, thenspan
        button type=button class=btn style=background#f59e0b;color#fff; onclick=bulkSetActive(false)⏸️ Pause selectedbutton
        button type=button class=btn style=background#16a34a;color#fff; onclick=bulkSetActive(true)▶️ Activate selectedbutton
        span style=width1px;height20px;background#cbd5e1;displayinline-block;span
        button type=button class=btn style=background#e2e8f0;color#475569; onclick=selectAllTmpls(true)Select allbutton
        button type=button class=btn style=background#e2e8f0;color#475569; onclick=selectAllTmpls(false)Clearbutton
        span id=sel-count style=font-size12px;color#94a3b8;font-weight600;span
      div
      ${sections}
    div
    script
      var formPhotos = [];
      var formActivePhotos = {};  url - false means inactive, default is active
      function escAttr(s){ return String(s).replace(&g,'&amp;').replace(g,'&quot;'); }
      function imgFail(el){ el.style.display='none'; var p=el.parentElement; p.style.color='#94a3b8'; p.style.fontSize='10px'; p.textContent='no img'; }
      function togglePhotoActive(u) {
        formActivePhotos[u] = (formActivePhotos[u] === false)  true  false;
        renderPhotoGrid();
      }
      function togglePhotoAtIdx(idx) {
        var u = formPhotos[idx];
        if (u !== undefined) { formActivePhotos[u] = (formActivePhotos[u] === false)  true  false; renderPhotoGrid(); }
      }
      function renderPhotoGrid() {
        document.getElementById('f-photos').value = JSON.stringify(formPhotos);
        var activeList = formPhotos.filter(function(u){ return formActivePhotos[u] !== false; });
        var ai = document.getElementById('f-active-photos'); if (ai) ai.value = JSON.stringify(activeList);
        var grid = document.getElementById('f-photo-grid');
        grid.innerHTML = formPhotos.map(function(u, i){
          var uid = 'pgurl_' + i;
          var isActive = formActivePhotos[u] !== false;
          var border = isActive  '#22c55e'  '#e2e8f0';
          var opacity = isActive  '1'  '0.4';
          var btnBg = isActive  'rgba(22,163,74,0.92)'  'rgba(100,100,100,0.8)';
          var btnLabel = isActive  '&#9989; Active'  '&#11036;&#65038; Inactive';
          return 'div style=border2px solid '+border+';border-radius10px;overflowhidden;background#fff;box-shadow0 1px 4px rgba(0,0,0,0.06);'+
            'div style=positionrelative;aspect-ratio11;background#f1f5f9;'+
            'img src='+escAttr(u)+' style=width100%;height100%;object-fitcover;displayblock;opacity'+opacity+'; onerror=imgFail(this)'+
            'button type=button onclick=removePhotoFromForm('+i+') style=positionabsolute;top7px;right7px;background#dc2626;color#fff;bordernone;border-radius50%;width28px;height28px;font-size16px;line-height1;cursorpointer;box-shadow0 1px 4px rgba(0,0,0,0.3);z-index2;u00d7button'+
            'button type=button onclick=togglePhotoAtIdx('+i+') style=positionabsolute;bottom7px;left7px;background'+btnBg+';color#fff;bordernone;border-radius8px;font-size11px;font-weight700;padding4px 10px;cursorpointer;z-index2;'+btnLabel+'button'+
            'div'+
            'div style=padding8px;background#f8fafc;border-top1px solid #e2e8f0;'+
            'input id='+uid+' type=text value='+escAttr(u)+' readonly style=width100%;font-size10px;font-familymonospace;padding4px 6px;border1px solid #cbd5e1;border-radius4px;background#fff;color#1e40af;cursorpointer; title=Click to select full URL onclick=this.select();'+
            'button type=button class=pg-copy-btn data-uid='+uid+' style=width100%;margin-top5px;background#6b7280;color#fff;bordernone;border-radius5px;font-size11px;font-weight600;padding5px;cursorpointer;ud83dudccb Copy URLbutton'+
            'div'+
            'div';
        }).join('')  'span style=color#94a3b8;font-size12px;No photos added yet.span';
      }
      function addPhotoToForm() { var inp = document.getElementById('f-photo-add'); var v = (inp.value  '').trim(); if (!v) return; formPhotos.push(v); formActivePhotos[v] = true; inp.value = ''; renderPhotoGrid(); }
      function removePhotoFromForm(i) { var u=formPhotos[i]; formPhotos.splice(i, 1); if(u) delete formActivePhotos[u]; renderPhotoGrid(); }
      function validateTmplForm() { if (!formPhotos.length) { alert('Add at least one photo.'); return false; } return true; }
      function dupTmpl(id, toSet) {
        var t = getTmpl(id); if (!t) return;
        var url = prompt('Enter the ' + toSet + ' gallery URL for the duplicate. The two cards will be LINKED — editing one syncs photostitlesubtitlebutton to the other.', '');
        if (url === null) return; url = (url  '').trim();
        if (!url) { alert('A URL is required.'); return; }
        window.location.href = 'template-duplicateid=' + encodeURIComponent(id) + '&to=' + encodeURIComponent(toSet) + '&url=' + encodeURIComponent(url);
      }
      function updateSelCount() { var n = document.querySelectorAll('.tmpl-selchecked').length; var el = document.getElementById('sel-count'); if (el) el.textContent = n  (n + ' selected')  ''; }
      function selectAllTmpls(on) { var b = document.querySelectorAll('.tmpl-sel'); for (var i = 0; i  b.length; i++) b[i].checked = on; updateSelCount(); }
      function bulkSetActive(makeActive) {
        var sel = document.querySelectorAll('.tmpl-selchecked'); var ids = []; for (var i = 0; i  sel.length; i++) ids.push(sel[i].value);
        if (!ids.length) { alert('Tick the cards you want first.'); return; }
        fetch('templates-bulk-active', { method 'POST', headers { 'Content-Type' 'applicationjson' }, body JSON.stringify({ ids ids, active makeActive }) })
          .then(function(r){ return r.json(); }).then(function(){ location.href = 'page=templates'; }).catch(function(e){ alert('Error ' + e.message); });
      }
      function fillFromRow() {
        var raw = document.getElementById('f-rawrow').value  '';
        if (!raw.trim()) { alert('Paste a row first.'); return; }
        var TAB = String.fromCharCode(9), NL = String.fromCharCode(10), CR = String.fromCharCode(13);

         Split by tabs AND newlines — handles long rows that wrap
        var cells = raw.replace(new RegExp(CR,'g'),'').split(new RegExp('['+TAB+NL+']'))
          .map(function(c){ return c.trim(); })
          .filter(function(c){ return c.length  0; });

        var imgurById = {};   id - full url  (dedup by image ID not full string)
        var imgurOrder = [];  to preserve order
        var scrollUrl = '', viralUrl = '';
        var textCells = [];

        cells.forEach(function(v) {
          if (!v) return;
          if (v.indexOf('http') === 0) {
            if (v.indexOf('imgur.com') !== -1) {
               Extract imgur image ID (e.g. LFAlEEp from httpsi.imgur.comLFAlEEp.jpeg)
              var m = (new RegExp('imgur.com([A-Za-z0-9]+)(.[a-zA-Z]+)')).exec(v);
              if (m) {
                var imgId = m[1];
                if (!imgurById[imgId]) {
                   Use original URL but ensure it has an extension
                  var url = v.split('')[0].split('#')[0];  strip queryhash
                  if (!(new RegExp('.(jpgjpegpnggifwebp)$','i')).test(url)) url = url + '.jpeg';
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

         Fill text fields
        if (textCells[0]) document.getElementById('f-title').value = textCells[0];
        if (textCells[1]) document.getElementById('f-subtitle').value = textCells[1];
        if (textCells.length = 3) document.getElementById('f-button').value = textCells[textCells.length - 1];

         Add all imgur photos
        imgurUrls.forEach(function(u) {
          if (!formPhotos.includes(u)) formPhotos.push(u);
        });
        if (imgurUrls.length  0) renderPhotoGrid();

         Fill per-set redirect fields (new multi-URL form)
        if (scrollUrl) {
          var sgField = document.getElementById('f-redirect-Scrollgallery');
          if (sgField) sgField.value = scrollUrl;
        }
        if (viralUrl) {
          var tvField = document.getElementById('f-redirect-TheViralBox');
          if (tvField) tvField.value = viralUrl;
        }
         Also fill any other fields if URL contains the set name (future websites)
        [scrollUrl, viralUrl].forEach(function(u) {
          if (!u) return;
          var allInputs = document.querySelectorAll('[id^=f-redirect-]');
          for (var i = 0; i  allInputs.length; i++) {
            var setName = allInputs[i].id.replace('f-redirect-','').toLowerCase();
            if (u.toLowerCase().indexOf(setName) !== -1) allInputs[i].value = u;
          }
        });
         Fallback old single redirect field
        var redirect = scrollUrl  viralUrl;
        if (redirect && document.getElementById('f-redirect')) {
          document.getElementById('f-redirect').value = redirect;
        }

         Show visible summary below button
        var summary = document.getElementById('f-row-summary');
        if (!summary) {
          summary = document.createElement('div');
          summary.id = 'f-row-summary';
          summary.style.cssText = 'margin-top8px;padding8px 12px;border-radius6px;font-size12px;font-weight600;';
          document.getElementById('f-rawrow').parentNode.appendChild(summary);
        }
        var parts = [];
        if (imgurUrls.length) parts.push('📸 ' + imgurUrls.length + ' photo(s) found ' + imgurOrder.join(', '));
        if (redirect) parts.push('🔗 redirect ' + redirect.replace('https','').slice(0,40));
        if (textCells[0]) parts.push('📝 title ' + textCells[0]);
        if (textCells.length = 3) parts.push('🔘 button ' + textCells[textCells.length-1]);
        summary.style.background = imgurUrls.length  '#dcfce7'  '#fef9c3';
        summary.style.color = imgurUrls.length  '#166534'  '#854d0e';
        summary.innerHTML = parts.length  parts.join('br')  '⚠️ Nothing recognized — check format';
      }
      function editTmpl(id) {
        try {
        var t = getTmpl(id); if (!t) { alert('Template not found ' + id); return; }
        document.getElementById('f-id').value = t.id;
        document.getElementById('f-title').value = t.title  '';
        document.getElementById('f-subtitle').value = t.subtitle  '';
        formPhotos = (Array.isArray(t.photos) && t.photos.length)  t.photos.slice()  (t.photo  [t.photo]  []);
        formActivePhotos = {};
        var activeArr = (Array.isArray(t.activePhotos) && t.activePhotos.length)  t.activePhotos  null;
        formPhotos.forEach(function(u){ formActivePhotos[u] = activeArr  (activeArr.indexOf(u) !== -1)  true; });
        renderPhotoGrid();
        document.getElementById('f-button').value = t.buttonText  '';
        document.getElementById('tmpl-form').action = 'template-edit';
        document.getElementById('form-title').textContent = '✏️ Edit Template';
        document.getElementById('f-submit').textContent = '💾 Save Changes';
        document.getElementById('f-cancel').style.display = 'inline-block';

         Fill per-set redirect fields
         First clear all per-set fields
        var allRedirectFields = document.querySelectorAll('[id^=f-redirect-]');
        for (var i = 0; i  allRedirectFields.length; i++) allRedirectFields[i].value = '';
         Fill this card's own set
        var ownField = document.getElementById('f-redirect-' + (t.set  'Scrollgallery'));
        if (ownField) ownField.value = t.redirect  '';
         Fill linked group members' redirect fields
        var allTmpls = window.__tmplData  {};
        Object.keys(allTmpls).forEach(function(tid) {
          var other = allTmpls[tid];
          if (tid === t.id) return;
          var isLinked = (t.linkGroup && other.linkGroup === t.linkGroup)  other.id === t.linkedId  t.linkedId === other.id;
          if (isLinked) {
            var field = document.getElementById('f-redirect-' + (other.set  ''));
            if (field) field.value = other.redirect  '';
          }
        });
         Also set hidden single redirect for fallback
        var hiddenRedirect = document.getElementById('f-redirect');
        if (hiddenRedirect) hiddenRedirect.value = t.redirect  '';

         Update linked block for legacy pairs
        var lb = document.getElementById('f-linked-block');
        var lrid = document.getElementById('f-linked-id');
        var lrurl = document.getElementById('f-linked-redirect');
        if (lb) lb.style.display = 'none';
        if (lrid) lrid.value = t.linkedId  '';
        if (lrurl) lrurl.value = '';

         Update submit button label based on how many linked cards exist
        var linkedCount = 0;
        Object.keys(allTmpls).forEach(function(tid) {
          if (tid === t.id) return;
          var other = allTmpls[tid];
          if ((t.linkGroup && other.linkGroup === t.linkGroup)  other.id === t.linkedId) linkedCount++;
        });
        if (linkedCount  0) document.getElementById('f-submit').textContent = '💾 Save + Sync to ' + linkedCount + ' linked card(s)';

         Scroll to top instantly and flash the form so user sees it
        window.scrollTo({ top 0, behavior 'instant' });
        var formEl = document.getElementById('tmpl-form');
        if (formEl) {
          formEl.style.transition = 'box-shadow 0.2s';
          formEl.style.boxShadow = '0 0 0 3px #6366f1';
          setTimeout(function(){ formEl.style.boxShadow = ''; }, 1000);
        }
        } catch(err) { alert('Edit error ' + err.message); }
      }
      function resetForm() {
        document.getElementById('tmpl-form').reset();
        document.getElementById('f-id').value = '';
        document.getElementById('tmpl-form').action = 'template-add';
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
        el.scrollIntoView({ behavior 'smooth', block 'center' });
        el.style.transition = 'box-shadow 0.3s'; el.style.boxShadow = '0 0 0 3px #6366f1';
        setTimeout(function(){ el.style.boxShadow = 'none'; }, 2600);
      })();
      renderPhotoGrid(); setupDropzone();
       Save scroll position before any navigation, restore on reload
      (function() {
        var key = 'tmpl_scroll';
        var saved = sessionStorage.getItem(key);
        if (saved) { sessionStorage.removeItem(key); setTimeout(function(){ window.scrollTo(0, parseInt(saved)); }, 80); }
        window.addEventListener('beforeunload', function() {
          if (location.search.indexOf('page=templates') !== -1) sessionStorage.setItem(key, window.scrollY);
        });
      })();
      document.addEventListener('change', function(e){ if (e.target && e.target.classList && e.target.classList.contains('tmpl-sel')) updateSelCount(); });
       Button click delegation — avoids ALL quoting issues with onclick attributes
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('.tmpl-edit-btn, .tmpl-dup-btn, .tmpl-link-btn, .pg-copy-btn, .pg-remove-btn, .pg-toggle-btn, .link-pick-btn, .link-modal-close');
        if (!btn) return;
        if (btn.classList.contains('tmpl-edit-btn')) { editTmpl(btn.getAttribute('data-id')); }
        else if (btn.classList.contains('tmpl-dup-btn')) { dupTmpl(btn.getAttribute('data-id'), btn.getAttribute('data-otherset')); }
        else if (btn.classList.contains('tmpl-link-btn')) { showLinkPicker(btn.getAttribute('data-id'), btn.getAttribute('data-otherset')); }
        else if (btn.classList.contains('pg-copy-btn')) {
          var el = document.getElementById(btn.getAttribute('data-uid'));
          if (el) { el.select(); document.execCommand('copy'); btn.textContent = '✓ Copied!'; btn.style.background = '#16a34a'; setTimeout(function(){ btn.textContent = '📋 Copy URL'; btn.style.background = '#6b7280'; }, 1400); }
        }
        else if (btn.classList.contains('pg-remove-btn')) { var idx=parseInt(btn.getAttribute('data-idx')); var url=formPhotos[idx]; formPhotos.splice(idx,1); if(url) delete formActivePhotos[url]; renderPhotoGrid(); }
        else if (btn.classList.contains('pg-toggle-btn')) { var url=btn.getAttribute('data-url'); if(url){ formActivePhotos[url]=(formActivePhotos[url]===false)truefalse; renderPhotoGrid(); } }
        else if (btn.classList.contains('link-pick-btn')) {
          var srcId = btn.getAttribute('data-src');
          var partnerId = btn.getAttribute('data-partner');
          closeLinkPicker();
          doLink(srcId, partnerId);
        }
        else if (btn.classList.contains('link-modal-close')) { closeLinkPicker(); }
      });
       Close modal if clicking backdrop
      document.addEventListener('click', function(e) {
        var modal = document.getElementById('link-picker-modal');
        if (modal && e.target === modal) closeLinkPicker();
      });
      function closeLinkPicker() {
        var m = document.getElementById('link-picker-modal');
        if (m) m.remove();
      }
      function showLinkPicker(srcId, otherSet) {
         Force-load template data if not yet initialized (getTmpl is lazy)
        getTmpl(srcId);
        var allTemplates = window.__tmplData  {};
         Get src card info
        var src = allTemplates[srcId];
        if (!src) return;
         Get all cards from the other set that are not already linked
        var candidates = Object.values(allTemplates).filter(function(t) {
          return t.set === otherSet && !t.linkedId;
        });
        var cards = candidates.map(function(t) {
          return 'div style=displayflex;align-itemscenter;gap10px;padding10px;border1px solid #e2e8f0;border-radius8px;cursorpointer;background#fff; class=link-pick-row'
            + 'img src=' + (t.photo'') + ' style=width56px;height56px;object-fitcover;border-radius6px;flex-shrink0; onerror=imgFail(this)'
            + 'div style=flex1;min-width0;'
            + 'div style=font-weight700;font-size13px;color#1a1d2e;' + (t.title'(no title)') + 'div'
            + 'div style=font-size11px;color#6b7280;white-spacenowrap;overflowhidden;text-overflowellipsis;' + (t.subtitle'') + 'div'
            + 'div style=font-size10px;color#94a3b8;font-familymonospace;margin-top2px;' + (t.redirect'').replace('https','') + 'div'
            + 'div'
            + 'button class=link-pick-btn qbtn data-src=' + srcId + ' data-partner=' + t.id + ' style=background#6d28d9;white-spacenowrap;🔗 Linkbutton'
            + 'div';
        }).join('');
        var html = 'div id=link-picker-modal style=positionfixed;inset0;backgroundrgba(0,0,0,0.5);z-index9999;displayflex;align-itemscenter;justify-contentcenter;padding20px;'
          + 'div style=background#fff;border-radius12px;width100%;max-width560px;max-height80vh;displayflex;flex-directioncolumn;box-shadow0 20px 60px rgba(0,0,0,0.3);'
          + 'div style=padding16px 20px;border-bottom1px solid #e2e8f0;displayflex;align-itemscenter;justify-contentspace-between;'
          + 'div'
          + 'div style=font-weight700;font-size16px;color#1a1d2e;🔗 Link to ' + otherSet + ' carddiv'
          + 'div style=font-size12px;color#6b7280;margin-top2px;Linking strong' + (src.titlesrcId) + 'strong → pick a ' + otherSet + ' card belowdiv'
          + 'div'
          + 'button class=link-modal-close style=backgroundnone;bordernone;font-size22px;cursorpointer;color#94a3b8;padding0;line-height1;×button'
          + 'div'
          + 'div style=overflow-yauto;padding16px;displayflex;flex-directioncolumn;gap8px;'
          + (candidates.length  cards  'div style=text-aligncenter;padding32px;color#94a3b8;No unlinked ' + otherSet + ' cards available.brDuplicate first, or create a new ' + otherSet + ' card.div')
          + 'div'
          + 'div'
          + 'div';
        document.body.insertAdjacentHTML('beforeend', html);
      }
      function doLink(srcId, partnerId) {
        fetch('template-link', { method 'POST', headers { 'Content-Type' 'applicationjson' }, body JSON.stringify({ id srcId, partnerId partnerId }) })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d && d.ok) { location.href = 'page=templates&lib_msg=Cards+linked+successfully'; }
            else { alert('Link failed ' + ((d && d.error)  'unknown')); }
          })
          .catch(function(e){ alert('Error ' + e.message); });
      }
       All template data in ONE safe block — avoids inline script tags per card breaking on special chars
       getTmpl is lazy reads the JSON element on first call (it's parsed by then since script runs after DOM)
      function getTmpl(id){
        if (!window.__tmplData) {
          var el = document.getElementById('tmpl-data-json');
          window.__tmplData = el  JSON.parse(el.textContent)  {};
        }
        return window.__tmplData[id]  null;
      }
    script
    script type=applicationjson id=tmpl-data-json${JSON.stringify(
      Object.fromEntries((lib.cardTemplates  []).map(t = [t.id, t]))
    ).replace(scriptgi, 'script')}script
  div`;
}

function renderAllPagesView(pages, req) {
  const todayStr = new Date().toISOString().split('T')[0];
  const globalMode = getGlobalContentMode();
  const rows = pages.map(p = {
    const fans = loadFans(p.pageId);
    const stats = loadStats(p.pageId);
    const clicks = (stats.clicks  []).length;
    const clicksToday = (stats.clicks  []).filter(c = c.time.startsWith(todayStr)).length;
    const sent = stats.messagesSent  0;
    const failed = stats.messagesFailed  0;
    const sendNowOn = p.sendNowEnabled !== false;
    const groupBadge = p.group
       `span class=group-badge${esc(p.group)}span`
       `span class=group-badge unassigned—span`;
    const pauseBtn = p.broadcastEnabled
       `form action=toggle-page method=POST style=displayinline;margin0;input type=hidden name=pageId value=${esc(p.pageId)}button type=submit class=qbtn qbtn-pause⏸️ Pausebuttonform`
       `form action=toggle-page method=POST style=displayinline;margin0;input type=hidden name=pageId value=${esc(p.pageId)}button type=submit class=qbtn qbtn-resume▶️ Resumebuttonform`;
    const sendNowToggle = sendNowOn
       `form action=toggle-sendnow method=POST style=displayinline;margin0;input type=hidden name=pageId value=${esc(p.pageId)}button type=submit class=qbtn style=background#f59e0b;🚫 Pause SNbuttonform`
       `form action=toggle-sendnow method=POST style=displayinline;margin0;input type=hidden name=pageId value=${esc(p.pageId)}button type=submit class=qbtn qbtn-resume✅ Resume SNbuttonform`;
    return `tr class=page-row data-id=${esc(p.pageId)}
      td style=width28px;text-aligncenter;cursorgrab;color#cbd5e1;font-size18px;padding10px 4px; class=drag-handle draggable=true title=Drag to reorder⠿td
      tdstrong${esc(p.label)}strongbrspan style=font-size11px;color#6b7280;${esc(p.pageId)}spanbr${groupBadge}td
      td${fans.length}td
      td${clicksToday}  ${clicks}td
      td style=white-spacenowrap;font-size13px;${sent} ✅ · ${failed} ❌td
      tdspan class=bp-cell data-bp=${esc(p.pageId)} style=font-size12px;color#94a3b8;—spantd
      td
        div class=actions
          ${pauseBtn}
          ${sendNowToggle}
          a href=send-nowpage=${esc(p.pageId)} class=qbtn qbtn-send onclick=return confirm('Send to ${fans.length} fans on ${esc(p.label)} now')🚀 Senda
          a href=page=${esc(p.pageId)} class=qbtn qbtn-open⚙️ Opena
        div
      td
    tr`;
  }).join('');

  return `div class=container
    ${renderAlerts(req)}
    ${renderMasterRedirectBanner()}

    div style=displayflex;align-itemscenter;gap12px;margin-bottom16px;flex-wrapwrap;
      div style=background#fff;border-radius8px;padding10px 18px;box-shadow0 1px 3px rgba(0,0,0,0.06);displayflex;align-itemscenter;gap10px;white-spacenowrap;
        span style=font-size28px;font-weight800;color#1a1d2e;${pages.length}span
        span style=font-size11px;color#6b7280;text-transformuppercase;letter-spacing0.5px;font-weight600;Pagesspan
      div
      div style=flex1;min-width280px;background#fff;border-radius8px;padding10px 14px;box-shadow0 1px 3px rgba(0,0,0,0.06);displayflex;gap8px;align-itemscenter;
        textarea id=bulk-pages-input rows=1 placeholder=Paste rows Name TAB PageID TAB Token  (one per line) style=flex1;font-familymonospace;font-size12px;padding6px 8px;border1px solid #86efac;border-radius6px;resizenone;min-height34px;max-height120px;overflow-yauto; oninput=this.style.height='34px';this.style.height=Math.min(this.scrollHeight,120)+'px';textarea
        button type=button class=qbtn style=background#16a34a;white-spacenowrap; onclick=parseBulkPages()🔍 Previewbutton
        button type=button id=bulk-add-btn class=qbtn style=background#15803d;displaynone;white-spacenowrap; onclick=submitBulkPages()➕ Addbutton
        span id=bulk-status style=font-size12px;font-weight600;white-spacenowrap;span
      div
    div
    div id=bulk-preview style=margin-bottom12px;div
    script
      var bulkParsed = [];
      function parseBulkPages() {
        var raw = document.getElementById('bulk-pages-input').value  '';
        if (!raw.trim()) { return; }

        var CR=String.fromCharCode(13), TAB=String.fromCharCode(9), NL=String.fromCharCode(10);
        var allCells = raw.split(CR).join('').split(TAB).join(NL).split(NL)
          .map(function(c){ return c.trim(); })
          .filter(function(c){ return c.length  0; });

         Classify every cell by type
        function isDigit(ch) { var c=ch.charCodeAt(0); return c=48&&c=57; }
        function isAllDigits(s) { if(s.length8) return false; for(var i=0;is.length;i++){if(!isDigit(s[i]))return false;} return true; }
        function extractDigits(s) {
          var best='', cur='';
          for(var i=0;is.length;i++){
            if(isDigit(s[i])){ cur+=s[i]; }
            else { if(cur.lengthbest.length) best=cur; cur=''; }
          }
          if(cur.lengthbest.length) best=cur;
          return best.length=8  best  null;
        }
        function isToken(s) { return s.length10&&s.slice(0,3).toUpperCase()==='EAA'; }
        var tokens = [], pageIds = [], names = [];
        allCells.forEach(function(c) {
          if (isToken(c)) {
            tokens.push(c);
          } else if (isAllDigits(c)) {
            pageIds.push(c);
          } else {
            var found = extractDigits(c);
            if (found) {
              pageIds.push(found);
              var namepart = c.replace(found, '').trim();
              if (namepart) names.push(namepart);
            } else {
              names.push(c);
            }
          }
        });

         Match by position pageIds[0]+tokens[0]+names[0] = page 1, etc.
        bulkParsed = [];
        var errors = [];
        var count = Math.max(tokens.length, pageIds.length);
        if (count === 0) {
          document.getElementById('bulk-status').style.color='#92400e';
          document.getElementById('bulk-status').textContent='Nothing recognized — need Page ID (long number) and Token (starts with EAA)';
          document.getElementById('bulk-preview').innerHTML='';
          document.getElementById('bulk-add-btn').style.display='none';
          return;
        }
        for (var i = 0; i  count; i++) {
          if (!pageIds[i]) { errors.push('Entry '+(i+1)+' missing Page ID'); continue; }
          if (!tokens[i]) { errors.push('Entry '+(i+1)+' missing Token (EAA...)'); continue; }
          bulkParsed.push({ name names[i]  'Page '+pageIds[i], pageId pageIds[i], token tokens[i] });
        }

        var preview = document.getElementById('bulk-preview');
        var status = document.getElementById('bulk-status');
        var addBtn = document.getElementById('bulk-add-btn');

        var rows = bulkParsed.map(function(p,i){
          return 'tr style=background'+(i%2===0'#f9fafb''#fff')+''
            +'td style=padding5px 8px;font-weight600;font-size13px;'+escHtml(p.name)+'td'
            +'td style=padding5px 8px;font-familymonospace;font-size11px;color#6b7280;'+escHtml(p.pageId)+'td'
            +'td style=padding5px 8px;font-familymonospace;font-size11px;color#16a34a;'+escHtml(p.token.slice(0,14))+'...td'
            +'tr';
        }).join('');

        var errHtml = errors.length
           'div style=background#fef2f2;border1px solid #fca5a5;border-radius6px;padding6px 10px;margin-top6px;font-size12px;color#dc2626;'
            +errors.map(function(e){ return 'div&#10060; '+escHtml(e)+'div'; }).join('')+'div'
           '';

        preview.innerHTML = bulkParsed.length
           'div style=background#fff;border-radius8px;border1px solid #86efac;overflowhidden;box-shadow0 1px 3px rgba(0,0,0,0.06);'
            +'table style=width100%;border-collapsecollapse;theadtr style=background#f0fdf4;'
            +'th style=padding6px 8px;text-alignleft;font-size11px;color#166534;Nameth'
            +'th style=padding6px 8px;text-alignleft;font-size11px;color#166534;Page IDth'
            +'th style=padding6px 8px;text-alignleft;font-size11px;color#166534;Tokenth'
            +'trtheadtbody'+rows+'tbodytablediv'+errHtml
           errHtml;

        if (bulkParsed.length  0) {
          status.style.color='#16a34a';
          status.textContent=bulkParsed.length+' ready'+(errors.length' ('+errors.length+' skipped)''');
          addBtn.style.display='inline-block';
          addBtn.textContent='Add '+bulkParsed.length;
        } else {
          status.style.color='#dc2626';
          status.textContent=errors.length+' error(s) — check format';
          addBtn.style.display='none';
        }
      }
      function escHtml(s){ return String(s).replace(&g,'&amp;').replace(g,'&lt;').replace(g,'&gt;'); }
      function submitBulkPages() {
        if (!bulkParsed.length) return;
        var btn=document.getElementById('bulk-add-btn');
        var status=document.getElementById('bulk-status');
        btn.disabled=true; btn.textContent='Adding...';
        status.style.color='#6b7280'; status.textContent='Saving...';
        fetch('bulk-add-pages',{method'POST',headers{'Content-Type''applicationjson'},bodyJSON.stringify({pagesbulkParsed})})
          .then(function(r){return r.json();})
          .then(function(d){
            if(d.ok){
              status.style.color='#16a34a'; status.textContent=d.added+' added, '+d.skipped+' skipped';
              btn.style.display='none';
              document.getElementById('bulk-pages-input').value='';
              document.getElementById('bulk-pages-input').style.height='34px';
              document.getElementById('bulk-preview').innerHTML='';
              bulkParsed=[];
              setTimeout(function(){ location.reload(); }, 1200);
            } else {
              status.style.color='#dc2626'; status.textContent='Error '+(d.error'unknown');
              btn.disabled=false;
            }
          })
          .catch(function(e){ status.style.color='#dc2626'; status.textContent='Error '+e.message; btn.disabled=false; });
      }
    script

    div style=displayflex;align-itemscenter;gap10px;flex-wrapwrap;margin-bottom16px;background#1a1d2e;border-radius8px;padding12px 16px;
      span style=font-size12px;font-weight700;color#a5b4fc;text-transformuppercase;letter-spacing0.5px;All Pagesspan
      button type=button class=qbtn style=background#dc2626; onclick=clearAllFans()&#128465;&#65039; Clear ALL Fansbutton
      button type=button class=qbtn style=background#2563eb; onclick=importAllPages()&#128229; Import ALL Pagesbutton
      button type=button class=qbtn style=background#7c3aed; onclick=triggerRedeploy()&#128260; Redeploy Railwaybutton
      span id=bulk-ops-status style=font-size13px;font-weight600;color#a5b4fc;span
    div

    div style=background#fff;border-radius8px;padding14px 16px;box-shadow0 1px 3px rgba(0,0,0,0.06);margin-bottom16px;
      div style=font-size12px;font-weight700;color#6b7280;text-transformuppercase;letter-spacing0.5px;margin-bottom10px;&#128269; Find Fan by PSID — open inbox to message manuallydiv
      div style=displayflex;gap8px;align-itemscenter;flex-wrapwrap;
        input type=text id=psid-search-input placeholder=Paste PSID (e.g. 1234567890) style=flex1;min-width200px;padding8px 12px;border1px solid #d1d5db;border-radius6px;font-familymonospace;font-size13px;
        button type=button class=qbtn style=background#6366f1; onclick=findPsid()&#128269; Findbutton
      div
      div id=psid-result style=margin-top10px;div
    div
    script
      var psidPageMap = ${JSON.stringify((() = {
        const map = {};
        pages.forEach(p = { map[p.pageId] = { label p.label, pageId p.pageId }; });
        return map;
      })())};
      function findPsid() {
        var psid = (document.getElementById('psid-search-input').value  '').trim();
        var result = document.getElementById('psid-result');
        if (!psid) { result.innerHTML = ''; return; }
        result.innerHTML = 'span style=color#6b7280;font-size13px;Searching...span';
        fetch('find-psidpsid=' + encodeURIComponent(psid))
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (!d.pages  !d.pages.length) {
              result.innerHTML = 'span style=color#dc2626;font-size13px;&#10060; PSID not found in any page fan list.span';
              return;
            }
            var rows = d.pages.map(function(p) {
              var inboxUrl = 'httpsbusiness.facebook.comlatestinboxmessengerpage_id=' + encodeURIComponent(p.pageId);
              var threadUrl = 'httpsbusiness.facebook.comlatestinboxmessengerpage_id=' + encodeURIComponent(p.pageId) + '&selected_item_id=' + encodeURIComponent(psid);
              return 'div style=displayflex;align-itemscenter;gap10px;padding8px 12px;background#f0f9ff;border1px solid #bae6fd;border-radius7px;margin-bottom6px;flex-wrapwrap;'
                + 'div style=flex1;min-width150px;div style=font-weight700;font-size14px;color#1a1d2e;' + escHtml(p.label) + 'divdiv style=font-size11px;color#6b7280;font-familymonospace;' + escHtml(p.pageId) + 'divdiv'
                + 'a href=' + threadUrl + ' target=_blank class=qbtn style=background#1877f2;text-decorationnone;&#128172; Open Conversationa'
                + 'a href=' + inboxUrl + ' target=_blank class=qbtn style=background#6b7280;text-decorationnone;&#128236; Page Inboxa'
                + 'div';
            }).join('');
            result.innerHTML = 'div style=font-size12px;color#166534;font-weight600;margin-bottom6px;&#9989; Found on ' + d.pages.length + ' page(s)div' + rows;
          })
          .catch(function(e){ result.innerHTML = 'span style=color#dc2626;Error ' + escHtml(e.message) + 'span'; });
      }
      function escHtml(s){ return String(s).replace(&g,'&amp;').replace(g,'&lt;').replace(g,'&gt;'); }
      document.getElementById('psid-search-input').addEventListener('keydown', function(e){ if(e.key==='Enter') findPsid(); });
    script

    ${renderGroupManager(pages)}

    div class=card
      h2📋 Pagesh2
      ${pages.length === 0
         'p style=color#6b7280;No pages yet. Add one below.p'
         `
          ${renderGroupSendNow(pages)}

          div style=margin-bottom12px;padding10px;background#f7f8fc;border-radius8px;displayflex;gap8px;align-itemscenter;flex-wrapwrap;
            span style=font-size13px;font-weight600;color#4a5568;Other bulk actionsspan
            form action=pause-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn qbtn-pause onclick=return confirm('Pause daily auto-broadcast for ALL pages')⏸️ Pause Allbutton
            form
            form action=resume-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn qbtn-resume onclick=return confirm('Resume daily auto-broadcast for ALL pages')▶️ Resume Allbutton
            form
            form action=disable-cleanup-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn style=background#3a8dde; onclick=return confirm('Disable auto-cleanup on ALL pages')🛡️ Disable Cleanup (All)button
            form
            form action=enable-cleanup-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn style=background#28a745; onclick=return confirm('Enable auto-cleanup (threshold=1) on ALL pages')🧹 Enable Cleanup (All)button
            form
            form action=randomize-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn style=background#8b5cf6; onclick=return confirm('Randomize ALL pages')🎲 Randomize ALLbutton
            form
            form action=reset-stats-all method=POST style=displayinline;margin0;
              button type=submit class=qbtn style=background#dc2626; onclick=return confirm('Reset ALL stats on all pages Fan counts are kept.')🗑️ Reset All Statsbutton
            form
            a href=backup class=qbtn style=background#0f766e;text-decorationnone;⬇️ Backupa
            button type=button class=qbtn style=background#7c3aed; onclick=document.getElementById('restore-file').click()♻️ Restorebutton
            input type=file id=restore-file accept=applicationjson,.json style=displaynone; onchange=restoreBackup(this)
          div

          div style=margin-bottom12px;padding12px;background#faf5ff;border2px solid #e9d5ff;border-radius8px;displayflex;gap12px;align-itemscenter;flex-wrapwrap;
            span style=font-size13px;font-weight700;color#6b21a8;🎚️ Global Content Modespan
            form action=set-global-mode method=POST style=margin0;displayinline;
              input type=hidden name=mode value=classic
              button type=submit class=qbtn style=background${globalMode === 'classic'  '#16a34a'  '#cbd5e1'};color${globalMode === 'classic'  '#fff'  '#475569'};${globalMode === 'classic'  '✓ '  ''}📷 Classicbutton
            form
            form action=set-global-mode method=POST style=margin0;displayinline;
              input type=hidden name=mode value=templates
              button type=submit class=qbtn style=background${globalMode === 'templates'  '#16a34a'  '#cbd5e1'};color${globalMode === 'templates'  '#fff'  '#475569'};${globalMode === 'templates'  '✓ '  ''}🎴 Templatesbutton
            form
          div

          table style=user-selecttext;
            theadtrth style=width28px; title=Drag rows to reorder⠿ththPage  Group span id=reorder-status style=font-size11px;font-weight400;margin-left8px;spanththFansththClicks (todaytotal)ththMessagesththSend ProgressththActionsthtrthead
            tbody id=pages-tbody${rows}tbody
          table
        `
      }
    div

    script
       Global scope — accessible from onclick handlers
      var allPageIds = ${JSON.stringify(pages.map(p = p.pageId))};
      var allPageLabels = ${JSON.stringify(Object.fromEntries(pages.map(p = [p.pageId, p.label])))};
      function clearAllFans() {
        if (!confirm('CLEAR ALL FANS on ALL ' + allPageIds.length + ' pages This cannot be undone!')) return;
        if (!confirm('Are you absolutely sure This deletes every fan list on every page.')) return;
        var status = document.getElementById('bulk-ops-status');
        status.style.color = '#6b7280'; status.textContent = 'Clearing...';
        fetch('clear-all-fans', { method 'POST', headers { 'Content-Type' 'applicationjson' } })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.ok) { status.style.color='#16a34a'; status.textContent='Cleared fans on '+d.cleared+' pages'; setTimeout(function(){ location.reload(); }, 1500); }
            else { status.style.color='#dc2626'; status.textContent='Error '+(d.error'unknown'); }
          }).catch(function(e){ status.style.color='#dc2626'; status.textContent='Error '+e.message; });
      }
      function importAllPages() {
        if (!confirm('Import contacts for ALL ' + allPageIds.length + ' pages Will run 10 at a time in parallel.')) return;
        var status = document.getElementById('bulk-ops-status');
        var BATCH = 20;
        var done = 0, failed = 0, processed = 0;
        var total = allPageIds.length;
        var batches = [];
        for (var i = 0; i  total; i += BATCH) batches.push(allPageIds.slice(i, i + BATCH));
        var bIdx = 0;
        function runBatch() {
          if (bIdx = batches.length) {
            status.style.color = '#16a34a';
            status.textContent = 'Done — ' + done + ' imported, ' + failed + ' failed (' + total + ' pages)';
            return;
          }
          var batch = batches[bIdx++];
          status.style.color = '#6b7280';
          status.textContent = 'Batch ' + bIdx + '' + batches.length + ' — importing ' + batch.length + ' pages in parallel... (' + processed + '' + total + ' done)';
          fetch('import-contacts-batch', {
            method 'POST',
            headers { 'Content-Type' 'applicationjson' },
            body JSON.stringify({ pageIds batch })
          })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d && d.results) {
              d.results.forEach(function(r) {
                processed++;
                if (r.ok) done++; else failed++;
              });
            } else {
              processed += batch.length; failed += batch.length;
            }
            runBatch();
          })
          .catch(function() { processed += batch.length; failed += batch.length; runBatch(); });
        }
        runBatch();
      }
      function triggerRedeploy() {
        if (!confirm('Redeploy Railway now The bot will be offline for ~30 seconds.')) return;
        var status = document.getElementById('bulk-ops-status');
        status.style.color='#7c3aed'; status.textContent='Deploying...';
        fetch('redeploy', { method 'POST' })
          .then(function(r){ return r.json(); })
          .then(function(d){
            if (d.ok) { status.style.color='#16a34a'; status.textContent='Redeployment triggered — bot will restart in ~30s'; }
            else { status.style.color='#dc2626'; status.textContent='Failed '+(d.error'check RAILWAY_API_TOKEN + RAILWAY_SERVICE_ID env vars'); }
          }).catch(function(e){ status.style.color='#dc2626'; status.textContent='Error '+e.message; });
      }
    script

    script
      (function() {
        function pollAll() {
          var cells = document.querySelectorAll('.bp-cell');
          cells.forEach(function(cell) {
            var pid = cell.getAttribute('data-bp');
            fetch('broadcast-statuspage=' + encodeURIComponent(pid))
              .then(function(r){ return r.json(); })
              .then(function(d){
                if (!d.active) { cell.innerHTML = 'span style=color#cbd5e1;— idlespan'; return; }
                if (d.status === 'complete') {
                  cell.innerHTML = 'span style=color#16a34a;font-weight600;✅ Donespanbrspan style=font-size10px;color#6b7280;' + d.total + ' sentspan';
                } else {
                  var pct = d.total  0  Math.round(d.done  d.total  100)  100;
                  cell.innerHTML = 'span style=color#6366f1;font-weight600;📡 ' + pct + '%spanbr'
                    + 'span style=font-size10px;color#6b7280;' + d.done + '' + d.total + 'span'
                    + 'div style=background#e2e8f0;border-radius999px;height5px;margin-top3px;overflowhidden;div style=background#6366f1;height100%;width' + pct + '%;divdiv';
                }
              }).catch(function(){});
          });
        }
        pollAll(); setInterval(pollAll, 5000);
      })();
    script

    script
       ── Drag & drop row reorder for pages table ──
      (function() {
        var tbody = document.getElementById('pages-tbody');
        if (!tbody) return;
        var dragging = null;

        tbody.addEventListener('dragstart', function(e) {
          if (!e.target.classList.contains('drag-handle')) { e.preventDefault(); return; }
          var row = e.target.closest('tr.page-row');
          if (!row) return;
          dragging = row;
          row.style.opacity = '0.4';
          e.dataTransfer.effectAllowed = 'move';
        });

        tbody.addEventListener('dragend', function(e) {
          if (dragging) dragging.style.opacity = '';
          document.querySelectorAll('tr.page-row').forEach(function(r) {
            r.style.borderTop = ''; r.style.borderBottom = '';
          });
          dragging = null;
        });

        tbody.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          var row = e.target.closest('tr.page-row');
          if (!row  row === dragging) return;
          document.querySelectorAll('tr.page-row').forEach(function(r) { r.style.borderTop = ''; });
          var rect = row.getBoundingClientRect();
          var mid = rect.top + rect.height  2;
          if (e.clientY  mid) {
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
          if (!row  row === dragging) return;
          document.querySelectorAll('tr.page-row').forEach(function(r) {
            r.style.borderTop = ''; r.style.borderBottom = '';
          });
          var rect = row.getBoundingClientRect();
          var mid = rect.top + rect.height  2;
          if (e.clientY  mid) {
            tbody.insertBefore(dragging, row);
          } else {
            tbody.insertBefore(dragging, row.nextSibling);
          }
           Save new order
          var ids = [];
          tbody.querySelectorAll('tr.page-row').forEach(function(r) {
            ids.push(r.getAttribute('data-id'));
          });
          var indicator = document.getElementById('reorder-status');
          if (indicator) { indicator.style.color = '#6b7280'; indicator.textContent = 'Saving order…'; }
          fetch('pages-reorder', {
            method 'POST',
            headers { 'Content-Type' 'applicationjson' },
            body JSON.stringify({ order ids })
          })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (indicator) {
              indicator.style.color = d.ok  '#16a34a'  '#dc2626';
              indicator.textContent = d.ok  '✓ Order saved'  '✗ Save failed';
              setTimeout(function() { indicator.textContent = ''; }, 2000);
            }
          })
          .catch(function() {
            if (indicator) { indicator.style.color = '#dc2626'; indicator.textContent = '✗ Error'; }
          });
        });
      })();
    script

    ${renderLibraryManager()}


    div class=card
      h2➕ Add New Pageh2
      p style=color#6b7280;font-size13px;New pages default to ⏸️ Broadcast Paused · 🛡️ Auto-cleanup Disabled. Enable them manually after setup.p

      div style=background#eef6ff;border1px solid #b5d4f4;border-radius8px;padding12px 14px;margin-bottom14px;
        div style=font-size12px;font-weight600;color#0c447c;margin-bottom8px;📋 Paste into Facebook Developerdiv
        div style=displayflex;align-itemscenter;gap8px;margin-bottom6px;flex-wrapwrap;
          span style=font-size11px;color#0c447c;font-weight600;min-width100px;Callback URLspan
          input type=text id=webhook-url value=${esc(PUBLIC_URL)}webhook readonly onclick=this.select(); style=flex1;min-width240px;padding6px 10px;font-familymonospace;font-size12px;background#fff;border1px solid #b5d4f4;border-radius5px;color#0c447c;
          button type=button onclick=(function(b){var i=document.getElementById('webhook-url');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='✓ Copied';setTimeout(function(){b.innerText=t;},1200);})(this) style=padding6px 12px;background#3a8dde;color#fff;bordernone;border-radius5px;font-size11px;font-weight600;cursorpointer;📋 Copybutton
        div
        div style=displayflex;align-itemscenter;gap8px;flex-wrapwrap;
          span style=font-size11px;color#0c447c;font-weight600;min-width100px;Verify Tokenspan
          input type=text id=verify-token value=${esc(VERIFY_TOKEN)} readonly onclick=this.select(); style=flex1;min-width240px;padding6px 10px;font-familymonospace;font-size12px;background#fff;border1px solid #b5d4f4;border-radius5px;color#0c447c;
          button type=button onclick=(function(b){var i=document.getElementById('verify-token');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='✓ Copied';setTimeout(function(){b.innerText=t;},1200);})(this) style=padding6px 12px;background#3a8dde;color#fff;bordernone;border-radius5px;font-size11px;font-weight600;cursorpointer;📋 Copybutton
        div
        div style=font-size11px;color#4a5568;margin-top8px;Subscribe to codemessagescode, codemessaging_postbackscode, codemessaging_optinscode, codemessage_readscode, codemessage_deliveriescodediv
      div

      form action=add-page method=POST
        div class=row
          div
            labelPage ID label
            input name=pageId required placeholder=e.g. 1051803118023056
          div
          div
            labelPage Label  Nicknamelabel
            input name=label placeholder=e.g. Mature, Friend Requests
          div
        div
        labelPage Access Token label
        input name=accessToken required placeholder=EAAxxx... style=font-familymonospace;font-size12px;
        labelAssign to Group (optional)label
        select name=group style=width100%;padding9px 12px;border1px solid #d1d5db;border-radius6px;font-size14px;
          option value=— unassigned —option
          ${getAllGroups(pages).map(g = `option value=${esc(g)}${esc(g)}option`).join('')}
        select
        details
          summaryOptional customize this page (otherwise uses defaults)summary
          div class=row
            divlabelCard Titlelabelinput name=title placeholder=${esc(getDefaults().title)}div
            divlabelCard Subtitlelabelinput name=subtitle placeholder=${esc(getDefaults().subtitle)}div
          div
          div class=row
            divlabelButton Textlabelinput name=buttonText placeholder=${esc(getDefaults().buttonText)}div
            divlabelWhatsApp  Redirect URLlabelinput name=whatsapp placeholder=${esc(getDefaults().whatsapp)}div
          div
          labelPhotos (one URL per line)label
          textarea name=photos placeholder=${esc(getDefaults().photos.join('n'))}textarea
          div class=row
            divlabelDaily Broadcast Time (HHMM)labelinput name=broadcastTime placeholder=${esc(getDefaults().broadcastTime)}div
            divlabelTimezonelabelinput name=timezone placeholder=${esc(getDefaults().timezone)}div
          div
          div class=row
            div
              labelSpacing Between Sendslabel
              ${renderSpacingSelect('spacingSeconds', getDefaults().spacingSeconds)}
            div
          div
        details
        button type=submit class=btn btn-green➕ Add Pagebutton
      form
    div
  divbodyhtml`;
}

function renderPageView(page, req) {
  const fans = loadFans(page.pageId);
  const lib = loadLibrary();
  const currentSet = pageSet(page, lib);
  const setNames = getSetNames(lib);
  const mode = pageContentMode(page);
  const pid = esc(page.pageId);

  const photosHtml = (page.photos  []).map((url, i) = {
    const isActive = url === page.currentPhoto;
    const copyId = `cpy-${i}`;
    return `
    div class=item ${isActive  'current'  ''}
      div class=img-wrapimg src=${esc(url)} alt=photo ${i}div
      div class=url-row
        input type=text id=${copyId} value=${esc(url)} readonly onclick=this.select();
      div
      div class=action-row
        button type=button class=ph-btn ph-copy onclick=(function(b){var i=document.getElementById('${copyId}');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='Copied';setTimeout(function(){b.innerText=t;},1200);})(this)Copy URLbutton
        ${isActive
           'span class=badge-currentACTIVEspan'
           `a href=set-active-photopage=${pid}&index=${i} class=ph-btn ph-activeSet Activea`
        }
        ${(page.photos.length  1)  `a href=remove-photopage=${pid}&index=${i} onclick=return confirm('Remove this photo') class=ph-btn ph-removeRemovea`  ''}
      div
    div`;
  }).join('');

  const pages = loadPages();
  const groups = getAllGroups(pages);
  const groupOpts = ['', ...groups].map(g =
    `option value=${esc(g)} ${(page.group  '') === g  'selected'  ''}${g  '--- unassigned ---'}option`
  ).join('');

  const setButtons = setNames.map(name = {
    const isCurrent = name === currentSet;
    const color = name === 'Scrollgallery'  '#3a8dde'  '#f59e0b';
    return `form action=set-page-redirect-setpage=${pid} method=POST style=margin0;displayinline;
      input type=hidden name=setName value=${esc(name)}
      button type=submit style=background${isCurrent  color  '#e2e8f0'};color${isCurrent  '#fff'  '#475569'};bordernone;border-radius6px;padding8px 14px;font-size13px;font-weight700;cursorpointer;
        ${isCurrent  '&#10003; '  ''}${esc(name)}
      button
    form`;
  }).join('');

  const randomizeBtn = mode === 'templates'
     `form action=randomize-pagepage=${pid} method=POST style=margin0;displayinline;
        button type=submit class=btn style=background#8b5cf6;color#fff;margin-top0;&#127924; Pick Random Templatebutton
       form
       form action=randomize-and-sendpage=${pid} method=POST style=margin0;displayinline;
        button type=submit class=btn style=background#7c3aed;color#fff;margin-top0; onclick=return confirm('Pick random template and send to ${fans.length} fans')&#127924;&#128640; Random + Sendbutton
       form`
     `form action=randomize-pagepage=${pid} method=POST style=margin0;displayinline;
        button type=submit class=btn style=background#8b5cf6;color#fff;margin-top0;&#127922; Pick Randombutton
       form
       form action=randomize-and-sendpage=${pid} method=POST style=margin0;displayinline;
        button type=submit class=btn style=background#7c3aed;color#fff;margin-top0; onclick=return confirm('Randomize and send to ${fans.length} fans')&#127922;&#128640; Random + Sendbutton
       form`;

  return `div class=container
    ${renderAlerts(req)}

    div class=card style=backgroundlinear-gradient(135deg,#1a1d2e 0%,#2d3154 100%);bordernone;padding18px 22px;
      div style=displayflex;align-itemscenter;gap16px;flex-wrapwrap;
        div style=backgroundrgba(255,255,255,0.1);border-radius8px;padding10px 16px;text-aligncenter;min-width90px;
          div style=font-size26px;font-weight800;color#fff;line-height1;${fans.length.toLocaleString()}div
          div style=font-size10px;color#a5b4fc;text-transformuppercase;letter-spacing1px;margin-top2px;Fansdiv
        div
        div style=width1px;height50px;backgroundrgba(255,255,255,0.15);div
        div
          div style=font-size10px;color#a5b4fc;text-transformuppercase;letter-spacing1px;margin-bottom6px;Websitediv
          div style=displayflex;gap6px;${setButtons}div
        div
        div style=width1px;height50px;backgroundrgba(255,255,255,0.15);div
        div
          div style=font-size10px;color#a5b4fc;text-transformuppercase;letter-spacing1px;margin-bottom6px;Quick Actionsdiv
          div style=displayflex;gap6px;flex-wrapwrap;
            ${randomizeBtn}
            a href=send-nowpage=${pid} class=btn style=background#22c55e;color#fff;margin-top0; onclick=return confirm('Send to ${fans.length} fans now')&#128640; Send Nowa
            a href=import-contactspage=${pid} class=btn style=background#16a34a;color#fff;margin-top0;&#128229; Import Contactsa
            a href=clear-fanspage=${pid} class=btn style=background#dc2626;color#fff;margin-top0; onclick=return confirm('CLEAR all ${fans.length} fans from ${esc(page.label)} This cannot be undone!')&#128465;&#65039; Clear Fansa
            a href=httpsbusiness.facebook.comlatestinboxmessengerpage_id=${pid} target=_blank class=btn style=background#1877f2;color#fff;margin-top0;&#128172; Open FB Inboxa
          div
        div
      div
    div

    div class=card style=padding12px 18px;displayflex;align-itemscenter;gap12px;flex-wrapwrap;
      div style=flex1;min-width200px;
        div style=font-size11px;color#6b7280;text-transformuppercase;letter-spacing0.5px;font-weight600;Page Statusdiv
        div style=font-size16px;font-weight700;color#1a1d2e;margin-top2px;
          ${page.broadcastEnabled  'span style=color#28a745;&#128994; Activespan - daily auto-broadcast ON'  'span style=color#f59e0b;&#9208;&#65039; Pausedspan - daily auto-broadcast OFF'}
        div
        div style=font-size13px;color#475569;margin-top4px;
          ${page.sendNowEnabled !== false  'span style=color#16a34a;&#9989; Send Now ONspan'  'span style=color#f59e0b;&#128683; Send Now OFFspan'}
          &nbsp;&middot;&nbsp; Group span class=group-badge ${page.group  ''  'unassigned'}${esc(page.group  'unassigned')}span
        div
      div
      div style=displayflex;flex-directioncolumn;gap6px;
        form action=toggle-page method=POST style=margin0;
          input type=hidden name=pageId value=${pid}
          input type=hidden name=returnTo value=page
          ${page.broadcastEnabled
             'button type=submit class=qbtn qbtn-pause style=padding8px 14px;font-size13px;width100%;Pause Daily Broadcastbutton'
             'button type=submit class=qbtn qbtn-resume style=padding8px 14px;font-size13px;width100%;Resume Daily Broadcastbutton'
          }
        form
        form action=toggle-sendnow method=POST style=margin0;
          input type=hidden name=pageId value=${pid}
          input type=hidden name=returnTo value=page
          ${page.sendNowEnabled !== false
             'button type=submit class=qbtn style=background#f59e0b;padding8px 14px;font-size13px;width100%;Pause Send Nowbutton'
             'button type=submit class=qbtn qbtn-resume style=padding8px 14px;font-size13px;width100%;Resume Send Nowbutton'
          }
        form
        form action=group-assign method=POST style=margin0;displayflex;gap5px;
          input type=hidden name=pageId value=${pid}
          input type=hidden name=returnTo value=page
          select name=group style=padding6px 8px;font-size12px;border1px solid #c4b5fd;border-radius5px;color#6d28d9;font-weight600;
            ${groupOpts}
          select
          button type=submit class=qbtn style=background#6d28d9;padding8px 10px;Set Groupbutton
        form
      div
    div

    ${(function(){
      const gMode = getGlobalContentMode();
      const pMode = page.contentMode;
      const isClassic = pMode === 'classic';
      const isTemplates = pMode === 'templates';
      const isGlobal = !isClassic && !isTemplates;
      const effective = isGlobal  gMode  pMode;
      return `
    div class=card style=border2px solid #e9d5ff;
      h2&#127898;&#65039; Content Modeh2
      p style=color#6b7280;font-size13px;Effective strong style=color${effective === 'templates'  '#7c3aed'  '#0c447c'};${effective === 'templates'  'Templates'  'Classic'}strongp
      div style=displayflex;gap8px;flex-wrapwrap;margin-top10px;
        form action=set-page-modepage=${pid} method=POST style=margin0;input type=hidden name=returnTo value=pageinput type=hidden name=mode value=classic
          button type=submit class=btn style=background${isClassic  '#16a34a'  '#e2e8f0'};color${isClassic  '#fff'  '#475569'};${isClassic  '&#10003; '  ''}Classicbutton
        form
        form action=set-page-modepage=${pid} method=POST style=margin0;input type=hidden name=returnTo value=pageinput type=hidden name=mode value=templates
          button type=submit class=btn style=background${isTemplates  '#16a34a'  '#e2e8f0'};color${isTemplates  '#fff'  '#475569'};${isTemplates  '&#10003; '  ''}Templatesbutton
        form
        form action=set-page-modepage=${pid} method=POST style=margin0;input type=hidden name=returnTo value=pageinput type=hidden name=mode value=global
          button type=submit class=btn style=background${isGlobal  '#16a34a'  '#e2e8f0'};color${isGlobal  '#fff'  '#475569'};${isGlobal  '&#10003; '  ''}Global (${gMode})button
        form
      div
    div`;
    })()}

    div class=card id=broadcast-progress-card style=displaynone;border2px solid #c7d2fe;
      h2&#128225; Broadcast Progressh2
      div
        div style=font-size15px;font-weight600;color#1a1d2e; id=bp-headline--div
        div style=background#e2e8f0;border-radius999px;height14px;overflowhidden;margin10px 0;
          div id=bp-bar style=background#6366f1;height100%;width0%;transitionwidth 0.4s;div
        div
        div style=font-size13px;color#6b7280; id=bp-detail--div
      div
    div
    script
      (function() {
        var pid = ${JSON.stringify(page.pageId)};
        var card = document.getElementById('broadcast-progress-card');
        var headline = document.getElementById('bp-headline');
        var bar = document.getElementById('bp-bar');
        var detail = document.getElementById('bp-detail');
        function fmtTime(s){ var m=Math.floor(s60), sec=s%60; return m0(m+'m '+sec+'s')(sec+'s'); }
        function poll() {
          fetch('broadcast-statuspage=' + encodeURIComponent(pid))
            .then(function(r){ return r.json(); })
            .then(function(d){
              if (!d.active) { card.style.display='none'; return; }
              card.style.display='block';
              var pct = d.total  0  Math.round(d.done  d.total  100)  100;
              bar.style.width = pct + '%';
              if (d.status === 'complete') {
                bar.style.background = '#22c55e';
                headline.innerHTML = 'Broadcast complete -- all ' + d.total + ' fans done';
                detail.textContent = 'Sent ' + d.done + ' in ' + fmtTime(d.elapsedSec);
              } else {
                bar.style.background = '#6366f1';
                headline.innerHTML = 'Sending ' + d.done + '  ' + d.total + ' (' + pct + '%)';
                detail.textContent = d.remaining + ' remaining';
              }
            }).catch(function(){});
        }
        poll(); setInterval(poll, 5000);
      })();
    script

    div class=card style=border2px solid #fde68a;padding0;overflowhidden;
      details
        summary style=cursorpointer;padding16px 20px;list-stylenone;displayflex;align-itemscenter;gap10px;user-selectnone;
          span style=font-size13px;color#92400e;transitiontransform 0.2s;displayinline-block; class=bp-arrow&#9654;span
          span style=font-size18px;font-weight700;color#1a1d2e;Page Settingsspan
          span style=font-size12px;color#6b7280;font-familymonospace;margin-leftauto;${esc(page.pageId)} - ${esc(page.label)}span
        summary
        div style=padding0 20px 20px;
          form action=edit-pagepage=${pid} method=POST
            labelPage Access Tokenlabel
            input name=accessToken placeholder=Paste new EAAxxx... token (leave blank to keep current) style=font-familymonospace;font-size12px;width100%;
            div class=helperCurrent code${page.accessToken  esc(page.accessToken.slice(0,12)) + '...' + esc(page.accessToken.slice(-6))  '(none)'}codediv
            labelPage Labellabel
            input name=label value=${esc(page.label)} style=width100%;
            button type=submit class=btn btn-green style=margin-top12px;Updatebutton
          form
        div
      details
    div

    div class=card
      h2Card  Message Editorh2
      form action=update-settingspage=${pid} method=POST
        div class=row
          divlabelCard Titlelabelinput name=title value=${esc(page.title)}div
          divlabelCard Subtitlelabelinput name=subtitle value=${esc(page.subtitle)}div
        div
        div class=row
          divlabelButton Textlabelinput name=buttonText value=${esc(page.buttonText)}div
          divlabelRedirect URLlabelinput name=whatsapp value=${esc(page.whatsapp)}div
        div
        labelActive Photo URLlabel
        input name=currentPhoto value=${esc(page.currentPhoto  '')}
        labelPage Labellabel
        input name=label value=${esc(page.label)}
        button type=submit class=btn btn-greenSave Settingsbutton
      form
    div

    div class=card
      h2Template Managerh2

      !-- Card 1 --
      div style=background#eef6ff;border1px solid #b5d4f4;border-radius8px;padding14px;margin-bottom14px;
        h3 style=margin0 0 10px;color#0c447c;font-size14px;📸 Card 1 Photo Cardh3
        div style=background#fff;border-radius6px;padding8px;margin-bottom10px;border1px solid #d1d5db;font-size12px;
          strong${esc(page.title  '(no title)')}strongbr
          span style=color#4a5568;${esc((page.subtitle  '').slice(0, 60))}span
        div
        a href=send-nowpage=${pid} class=btn btn-green style=displayblock;text-aligncenter;margin0; onclick=return confirm('Send Card 1 to ${fans.length} fans')🚀 Send Card 1 to Alla
      div

      !-- Card 2 --
      div style=background#f0fdf4;border1px solid #86efac;border-radius8px;padding14px;margin-bottom14px;
        h3 style=margin0 0 10px;color#166534;font-size14px;📸 Card 2 Photo Card (independent)h3
        form action=update-card2page=${pid} method=POST style=margin-bottom10px;
          div class=row style=margin-bottom8px;
            divlabel style=font-size12px;Titlelabelinput name=title2 value=${esc(page.card2.title  '')} placeholder=e.g. Sandra 58 💕 style=width100%;div
            divlabel style=font-size12px;Subtitlelabelinput name=subtitle2 value=${esc(page.card2.subtitle  '')} placeholder=e.g. I'm a widow... style=width100%;div
          div
          div class=row style=margin-bottom8px;
            divlabel style=font-size12px;Button Textlabelinput name=buttonText2 value=${esc(page.card2.buttonText  '')} placeholder=My Photos 📞 style=width100%;div
            divlabel style=font-size12px;Redirect URLlabelinput name=redirect2 value=${esc(page.card2.redirect  '')} placeholder=https... style=width100%;font-familymonospace;font-size12px;div
          div
          div style=margin-bottom8px;label style=font-size12px;Photo URLlabelinput name=photo2 value=${esc(page.card2.photo  '')} placeholder=httpsi.imgur.com... style=width100%;font-familymonospace;font-size12px;div
          button type=submit class=btn btn-green style=margin-top0;💾 Save Card 2button
        form
        ${page.card2.photo  `a href=send-now2page=${pid} class=btn btn-green style=displayblock;text-aligncenter; onclick=return confirm('Send Card 2 to ${fans.length} fans')🚀 Send Card 2 to Alla`  'div style=font-size12px;color#94a3b8;Save Card 2 settings first to enable sending.div'}
      div

      !-- Plain Text Messages --
      div style=border1px solid #e2e8f0;border-radius8px;padding14px;
        h3 style=margin0 0 12px;color#1a1d2e;font-size14px;💬 Plain Text Messagesh3
        ${(() = {
          const msgs = page.textMessages  [];
          if (!msgs.length) return 'div style=color#94a3b8;font-size13px;margin-bottom12px;No text messages saved yet — add one below.div';
          return msgs.map((msg, i) = `
            div style=background#f9fafb;border1px solid #e2e8f0;border-radius8px;padding10px 12px;margin-bottom10px;
              div style=displayflex;align-itemsflex-start;gap8px;
                span style=background#6366f1;color#fff;font-size10px;font-weight700;padding2px 7px;border-radius4px;white-spacenowrap;margin-top2px;#${i+1}span
                div style=flex1;font-size13px;color#1a1d2e;white-spacepre-wrap;word-breakbreak-word;${esc(msg.text)}div
              div
              div style=displayflex;gap6px;margin-top8px;
                form action=send-text-message-nowpage=${pid}&msgId=${esc(msg.id)} method=POST style=margin0;
                  button type=submit class=btn btn-green style=font-size12px;padding5px 12px;margin0; onclick=return confirm('Send this text to ${fans.length} fans')🚀 Send to Allbutton
                form
                form action=delete-text-messagepage=${pid}&msgId=${esc(msg.id)} method=POST style=margin0;
                  button type=submit class=btn style=background#dc2626;color#fff;font-size12px;padding5px 12px;margin0; onclick=return confirm('Delete this message')🗑️ Deletebutton
                form
              div
            div`).join('');
        })()}
        form action=add-text-messagepage=${pid} method=POST style=margin-top4px;
          textarea name=text placeholder=Type your message here... e.g. Hey 😊 How's your day going style=width100%;min-height80px;padding8px;border1px solid #cbd5e1;border-radius6px;font-size13px;font-familyinherit;resizevertical;textarea
          button type=submit class=btn btn-green style=margin-top6px;➕ Add Text Messagebutton
        form
      div
    div

    div class=card
      h2Scheduleh2
      form action=update-schedulepage=${pid} method=POST
        div class=row
          divlabelDaily Broadcast Time (HHMM)labelinput name=broadcastTime value=${esc(page.broadcastTime)}div
          divlabelTimezonelabelinput name=timezone value=${esc(page.timezone)}div
        div
        div class=row
          div
            labelSpacing Between Sendslabel
            ${renderSpacingSelect('spacingSeconds', page.spacingSeconds  10)}
          div
          div
            labelDaily Auto-Broadcastlabel
            select name=broadcastEnabled
              option value=true ${page.broadcastEnabled  'selected'  ''}Enabledoption
              option value=false ${!page.broadcastEnabled  'selected'  ''}Pausedoption
            select
          div
        div
        div class=row
          div
            labelAuto-Cleanup Thresholdlabel
            select name=cleanupThreshold
              option value=0 ${page.cleanupThreshold === 0  'selected'  ''}0 - Disabledoption
              option value=1 ${(page.cleanupThreshold === undefined  page.cleanupThreshold === 1)  'selected'  ''}1 - Remove on 1st failureoption
              option value=2 ${page.cleanupThreshold === 2  'selected'  ''}2 - Remove after 2 failuresoption
              option value=3 ${page.cleanupThreshold === 3  'selected'  ''}3 - Remove after 3 failuresoption
              option value=5 ${page.cleanupThreshold === 5  'selected'  ''}5 - Very safeoption
              option value=10 ${page.cleanupThreshold === 10  'selected'  ''}10 - Almost never removeoption
            select
          div
          divdiv
        div
        button type=submit class=btn btn-greenSave Schedulebutton
      form
    div

    div class=card
      h2Photosh2
      div class=photo-grid${photosHtml}div
      form action=add-photopage=${pid} method=POST style=margin-top14px;
        labelAdd Photo URLlabel
        input name=photoUrl placeholder=httpsi.imgur.com...
        button type=submit class=btn btn-blueAdd Photobutton
      form
    div

    ${renderPageLibrarySection(page)}

    div class=card
      h2Broadcastsh2
      div style=background#fffbeb;border1px solid #fde68a;border-radius8px;padding12px;margin-bottom14px;
        h3 style=margin-top0;color#92400e;Test Send to Specific PSIDh3
        form action=test-sendpage=${pid} method=POST style=displayflex;gap8px;flex-wrapwrap;align-itemsflex-end;
          div style=flex1;min-width200px;labelPSIDlabelinput name=psid placeholder=e.g. 1234567890 requireddiv
          button type=submit class=btn btn-orange style=margin-top0;Send Testbutton
        form
      div
      p style=font-size13px;color#6b7280;Send to ALL ${fans.length} fans, spaced strong${page.spacingSeconds  10}sstrong apart. Est. ~${Math.ceil(fans.length  (page.spacingSeconds  10)  60)} min.p
      a href=send-nowpage=${pid} class=btn btn-green onclick=return confirm('Send to ${fans.length} fans now')Send Nowa
      h3Custom Broadcasth3
      form action=send-custompage=${pid} method=POST
        labelPhoto URL (optional)label
        input name=photo placeholder=${esc(page.currentPhoto  '')}
        button type=submit class=btn btn-blue onclick=return confirm('Send custom broadcast to ${fans.length} fans')Send Custombutton
      form
      h3Schedule One-Timeh3
      form action=schedule-oncepage=${pid} method=POST
        labelSend atlabel
        input name=scheduleTime type=datetime-local
        button type=submit class=btn btn-blueSchedulebutton
      form
    div

    div class=card
      h2Fan Managementh2
      div class=row
        div
          h3Import from Facebookh3
          a href=import-contactspage=${pid} class=btn btn-blueImport All Contactsa
        div
        div
          h3Export  Backuph3
          a href=export-fanspage=${pid} class=btn btn-blueExport Fan Lista
        div
      div
      h3Bulk Importh3
      form action=bulk-add-fanspage=${pid} method=POST
        labelPaste PSIDs (one per line or comma-separated)label
        textarea name=psids placeholder=1234567890textarea
        button type=submit class=btn btn-greenBulk Importbutton
      form
      h3Manualh3
      form action=add-fanpage=${pid} method=POST style=margin-bottom10px;
        labelAdd single PSIDlabel
        input name=psid
        button type=submit class=btn btn-greenAdd Fanbutton
      form
      form action=set-baselinepage=${pid} method=POST style=margin-bottom10px;
        labelSet Baselinelabel
        input name=value type=number value=${page.baselineFans  0}
        button type=submit class=btn btn-orangeSet Baselinebutton
      form
      a href=clear-fanspage=${pid} class=btn btn-red onclick=return confirm('CLEAR all ${fans.length} fans Export first!')Clear All Fansa
      form action=reset-statspage=${pid} method=POST style=margin-top10px;
        button type=submit class=btn style=background#dc2626;color#fff; onclick=return confirm('Reset stats Fans kept.')Reset Stats (keep fans)button
      form
    div

    div class=card danger-zone
      h2Danger Zoneh2
      form action=remove-page method=POST style=displayinline;
        input type=hidden name=pageId value=${pid}
        button type=submit class=btn btn-red onclick=return confirm('REMOVE page ${esc(page.label)} Fans + stats deleted.')Remove This Pagebutton
      form
    div
  divbodyhtml`;
}

 ============================================
 MAIN ROUTE
 ============================================
app.get('', (req, res) = {
  const pages = loadPages();
  const selectedPageId = req.query.page;
  const showAll = !selectedPageId  selectedPageId === 'all';
  let html = renderHead('messagebot');
  html += renderTopbar(pages, selectedPageId);
  if (selectedPageId === 'templates') {
    html += renderTemplateManager(req);
  } else if (showAll) {
    html += renderAllPagesView(pages, req);
  } else {
    const page = getPage(selectedPageId);
    if (!page) {
      html += `div class=containerdiv class=alert alert-errorPage not found. a href=Go backadivdiv`;
    } else {
      html += renderPageView(page, req);
    }
  }
  res.send(html);
});

 ============================================
 PAGE MANAGEMENT
 ============================================
 Bulk add pages from paste
 Trigger Railway redeployment via GraphQL API
app.post('redeploy', async (req, res) = {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_SERVICE_ID;
  if (!token) return res.json({ ok false, error 'RAILWAY_API_TOKEN not set' });
  if (!serviceId) return res.json({ ok false, error 'RAILWAY_SERVICE_ID not set' });
  try {
     Step 1 get latest deployment ID
    const r1 = await fetch('httpsbackboard.railway.appgraphqlv2', {
      method 'POST',
      headers { 'Content-Type' 'applicationjson', 'Authorization' 'Bearer ' + token },
      body JSON.stringify({ query `query { service(id ${serviceId}) { deployments(first 1) { edges { node { id } } } } }` })
    });
    const d1 = await r1.json();
    if (d1.errors) return res.json({ ok false, error d1.errors[0].message });
    const depId = d1.data && d1.data.service && d1.data.service.deployments && d1.data.service.deployments.edges[0] && d1.data.service.deployments.edges[0].node.id;
    if (!depId) return res.json({ ok false, error 'No deployment found for this service' });
     Step 2 redeploy it
    const r2 = await fetch('httpsbackboard.railway.appgraphqlv2', {
      method 'POST',
      headers { 'Content-Type' 'applicationjson', 'Authorization' 'Bearer ' + token },
      body JSON.stringify({ query `mutation { deploymentRedeploy(id ${depId}) { id } }` })
    });
    const d2 = await r2.json();
    if (d2.errors) return res.json({ ok false, error d2.errors[0].message });
    res.json({ ok true });
  } catch(e) {
    res.json({ ok false, error e.message });
  }
});

 Clear fans for ALL pages at once
app.post('clear-all-fans', (req, res) = {
  const pages = loadPages();
  let cleared = 0;
  pages.forEach(p = {
    try { saveFansList(p.pageId, []); cleared++; } catch(e) {}
  });
  res.json({ ok true, cleared });
});

app.post('bulk-add-pages', (req, res) = {
  const pages = req.body.pages;
  if (!Array.isArray(pages)  !pages.length) return res.json({ ok false, error 'No pages provided' });
  let added = 0, skipped = 0;
  pages.forEach(p = {
    if (!p.pageId  !p.token) { skipped++; return; }
    const result = addPage({
      pageId String(p.pageId).trim(),
      accessToken String(p.token).trim(),
      label (p.name  '').trim()  `Page ${p.pageId}`
    });
    if (result) {
      added++;
      try { setupMessenger(result); } catch {}
    } else {
      skipped++;  already exists
    }
  });
  res.json({ ok true, added, skipped });
});

app.post('add-page', (req, res) = {
  const b = req.body;
  if (!b.pageId  !b.accessToken) {
    return res.redirect('error=' + encodeURIComponent('Page ID and Access Token required'));
  }
  const photos = (b.photos  '').split(rn).map(s = s.trim()).filter(Boolean);
  const data = {
    pageId b.pageId,
    accessToken b.accessToken,
    label b.label  undefined,
    title b.title  undefined,
    subtitle b.subtitle  undefined,
    buttonText b.buttonText  undefined,
    whatsapp b.whatsapp  undefined,
    photos photos.length  photos  undefined,
    broadcastTime b.broadcastTime  undefined,
    timezone b.timezone  undefined,
    spacingSeconds b.spacingSeconds  parseInt(b.spacingSeconds)  undefined,
    group b.group  ''
  };
  const newPage = addPage(data);
  if (!newPage) {
    return res.redirect('error=' + encodeURIComponent('Page ID already exists'));
  }
  setupMessenger(newPage);
  res.redirect(`page=${encodeURIComponent(newPage.pageId)}&added=1`);
});

app.post('remove-page', (req, res) = {
  if (req.body.pageId) removePage(req.body.pageId);
  res.redirect('removed=1');
});

 Reorder pages — saves new order from drag & drop
app.post('pages-reorder', (req, res) = {
  const order = req.body.order;
  if (!Array.isArray(order)  !order.length) return res.json({ ok false, error 'No order provided' });
  const pages = loadPages();
   Build a map for quick lookup
  const pageMap = {};
  pages.forEach(p = { pageMap[p.pageId] = p; });
   Reorder put pages in the new order, append any missing ones at the end
  const reordered = order.filter(id = pageMap[id]).map(id = pageMap[id]);
  const missing = pages.filter(p = !order.includes(p.pageId));
  savePages([...reordered, ...missing]);
  res.json({ ok true });
});

app.post('toggle-page', (req, res) = {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  updatePage(pageId, { broadcastEnabled !page.broadcastEnabled });
  res.redirect(req.body.returnTo === 'page'  `page=${encodeURIComponent(pageId)}&saved=1`  'saved=1');
});

app.post('toggle-sendnow', (req, res) = {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const current = page.sendNowEnabled !== false;
  updatePage(pageId, { sendNowEnabled !current });
  res.redirect(req.body.returnTo === 'page'  `page=${encodeURIComponent(pageId)}&saved=1`  'saved=1');
});

 ============================================
 PAGE GROUPS ROUTES
 ============================================
 Create a new group name — stored in settings so it shows in dropdowns immediately
app.post('group-create', (req, res) = {
  const group = (req.body.group  '').trim();
  if (!group) return res.redirect('error=' + encodeURIComponent('Group name cannot be empty'));
  saveGroupName(group);
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Group ' + group + ' created — now assign pages to it below.'));
});

 Assign a page to a group (or unassign with empty string)
app.post('group-assign', (req, res) = {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  updatePage(pageId, { group (req.body.group  '').trim() });
  if (req.body.returnTo === 'page') {
    res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
  } else {
    res.redirect('page=all&saved=1');
  }
});

 Bulk assign multiple pages to a group in one AJAX call — no redirect
app.post('group-assign-bulk', (req, res) = {
  const { pageIds, group } = req.body;
  if (!Array.isArray(pageIds)  !pageIds.length) return res.json({ ok false, error 'No pages provided' });
  const groupName = (group  '').trim();
  let updated = 0;
  pageIds.forEach(pid = {
    if (getPage(pid)) { updatePage(pid, { group groupName }); updated++; }
  });
  res.json({ ok true, updated });
});

 Delete a group — unassigns all pages in it and removes from settings
app.post('group-delete', (req, res) = {
  const group = (req.body.group  '').trim();
  if (!group) return res.redirect('page=all');
  const pages = loadPages();
  pages.forEach(p = { if (p.group === group) updatePage(p.pageId, { group '' }); });
  deleteGroupName(group);
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Group ' + group + ' deleted — pages unassigned'));
});

 Send Now to a specific GROUP only
app.post('send-now-group', (req, res) = {
  const group = (req.body.group  '').trim();
  const doRandomize = req.body.randomize === '1';
  if (!group) return res.redirect('error=No+group+selected');
  const pages = loadPages();
  const eligible = pages.filter(p = p.group === group && p.sendNowEnabled !== false);
  if (!eligible.length) {
    return res.redirect('page=all&error=' + encodeURIComponent('No eligible pages in group ' + group + ' (all have Send Now paused or group is empty)'));
  }
  let totalFans = 0;
  const perPage = [];
  eligible.forEach(p = {
    let page = getPage(p.pageId);
    if (doRandomize) page = randomizePage(page, {});
    const count = broadcastToPage(page, {});
    totalFans += count;
    perPage.push({ label page.label, count, redirect page.whatsapp });
  });
  console.log(`📣 Group Send Now ${group}${doRandomize  ' (randomized)'  ''} ${eligible.length} pages, ${totalFans} fans`);
  const rows = perPage.map(x = `trtd${esc(x.label)}tdtd style=text-alignright;${x.count}tdtd style=font-size11px;color#6b7280;${esc((x.redirect'').replace(^https,''))}tdtr`).join('');
  res.send(`${renderHead('Group Send')}div class=containerdiv class=card
    h2📣 Group ${esc(group)} Send${doRandomize  ' + Randomize'  ''} Startedh2
    pBroadcasting to strong${eligible.length} pagesstrong in group strong${esc(group)}strong · strong${totalFans} total fansstrong.p
    table style=width100%;margin-top12px;theadtrthPagethth style=text-alignright;FansththRedirectthtrtheadtbody${rows}tbodytable
    a href=page=all class=btn btn-green style=margin-top16px;← Back to Dashboarda
  divdivbodyhtml`);
});

 ============================================
 BULK SEND NOW (ALL)
 ============================================
app.post('send-now-all', (req, res) = {
  const pages = loadPages();
  const doRandomize = req.query.randomize === '1';
  const eligible = pages.filter(p = p.sendNowEnabled !== false);
  let totalFans = 0;
  const perPage = [];
  eligible.forEach(p = {
    let page = getPage(p.pageId);
    if (doRandomize) page = randomizePage(page, {});
    const count = broadcastToPage(page, {});
    totalFans += count;
    perPage.push({ label page.label, count, redirect page.whatsapp });
  });
  const skipped = pages.length - eligible.length;
  console.log(`📣 Bulk Send Now${doRandomize  ' (randomized)'  ''} ${eligible.length} pages, ${totalFans} fans, ${skipped} skipped`);
  const rows = perPage.map(x = `trtd${esc(x.label)}tdtd style=text-alignright;${x.count}tdtd style=font-size11px;color#6b7280;${esc((x.redirect'').replace(^https,''))}tdtr`).join('');
  res.send(`${renderHead('Bulk Send')}div class=containerdiv class=card
    h2📣 Bulk Send Now${doRandomize  ' + Randomize'  ''} Startedh2
    pstrong${eligible.length} pagesstrong · strong${totalFans} total fansstrong.${skipped  ` span style=color#92400e;${skipped} skipped (Send Now paused).span`  ''}p
    table style=width100%;margin-top12px;theadtrthPagethth style=text-alignright;FansththRedirectthtrtheadtbody${rows}tbodytable
    a href=page=all class=btn btn-green style=margin-top16px;← Back to Dashboarda
  divdivbodyhtml`);
});

app.post('pause-sendnow-all', (req, res) = {
  loadPages().forEach(p = updatePage(p.pageId, { sendNowEnabled false }));
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Send Now PAUSED on all pages'));
});

app.post('resume-sendnow-all', (req, res) = {
  loadPages().forEach(p = updatePage(p.pageId, { sendNowEnabled true }));
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Send Now RESUMED on all pages'));
});

app.post('pause-all', (req, res) = {
  loadPages().forEach(p = { if (p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled false }); });
  res.redirect('saved=1');
});

app.post('resume-all', (req, res) = {
  loadPages().forEach(p = { if (!p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled true }); });
  res.redirect('saved=1');
});

app.post('disable-cleanup-all', (req, res) = {
  loadPages().forEach(p = updatePage(p.pageId, { cleanupThreshold 0 }));
  res.redirect('saved=1');
});

app.post('enable-cleanup-all', (req, res) = {
  loadPages().forEach(p = updatePage(p.pageId, { cleanupThreshold 1 }));
  res.redirect('saved=1');
});

 ============================================
 PER-PAGE SETTINGS  SCHEDULE
 ============================================
app.post('update-settings', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  updatePage(pageId, {
    title req.body.title,
    subtitle req.body.subtitle,
    buttonText req.body.buttonText  getDefaults().buttonText,
    whatsapp req.body.whatsapp,
    currentPhoto req.body.currentPhoto  undefined,
    label req.body.label  undefined
  });
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('page-update-inline', (req, res) = {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.json({ ok false, error 'page not found' });
  const updates = {};
  if (typeof req.body.label === 'string' && req.body.label.trim()) updates.label = req.body.label.trim();
  if (typeof req.body.token === 'string' && req.body.token.trim()) updates.accessToken = req.body.token.trim();
  const newPageId = (req.body.newPageId  '').trim();
  let finalId = pageId;
  if (newPageId && newPageId !== pageId) {
    if (getPage(newPageId)) return res.json({ ok false, error 'that Page ID already exists' });
    updates.pageId = newPageId;
    finalId = newPageId;
  }
  updatePage(pageId, updates);
  if (finalId !== pageId) {
    try { if (fs.existsSync(fansFile(pageId))) fs.renameSync(fansFile(pageId), fansFile(finalId)); } catch (e) {}
    try { if (fs.existsSync(statsFile(pageId))) fs.renameSync(statsFile(pageId), statsFile(finalId)); } catch (e) {}
  }
  if (updates.accessToken) { try { setupMessenger(getPage(finalId)); } catch (e) {} }
  res.json({ ok true, pageId finalId });
});

app.post('edit-page', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const updates = {};
  if (req.body.accessToken && req.body.accessToken.trim()) updates.accessToken = req.body.accessToken.trim();
  if (req.body.label && req.body.label.trim()) updates.label = req.body.label.trim();
  updatePage(pageId, updates);
  if (updates.accessToken) { try { setupMessenger(getPage(pageId)); } catch {} }
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

app.get('broadcast-status', (req, res) = {
  const pageId = req.query.page;
  const b = broadcastProgress[pageId];
  if (!b) return res.json({ active false });
  const elapsed = (b.finishedAt  Date.now()) - b.startedAt;
  res.json({ active true, status b.status, total b.total, done b.done, remaining Math.max(0, b.total - b.done), type b.type, elapsedSec Math.round(elapsed  1000) });
});

app.post('update-schedule', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  const threshold = req.body.cleanupThreshold !== undefined  parseInt(req.body.cleanupThreshold)  0;
  updatePage(pageId, {
    broadcastTime req.body.broadcastTime,
    timezone req.body.timezone,
    spacingSeconds parseInt(req.body.spacingSeconds)  10,
    broadcastEnabled req.body.broadcastEnabled === 'true',
    cleanupThreshold isNaN(threshold)  0  threshold
  });
  res.redirect(`page=${encodeURIComponent(pageId)}&schedule_saved=1`);
});

app.post('set-baseline', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  updatePage(pageId, { baselineFans parseInt(req.body.value)  0 });
  res.redirect(`page=${encodeURIComponent(pageId)}`);
});

 ============================================
 PHOTOS
 ============================================
app.post('add-photo', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  if (req.body.photoUrl) {
    const photos = [...(page.photos  []), req.body.photoUrl];
    updatePage(pageId, { photos });
  }
  res.redirect(`page=${encodeURIComponent(pageId)}`);
});

app.get('remove-photo', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const i = parseInt(req.query.index);
  if (i = 0 && page.photos && page.photos.length  1) {
    const photos = [...page.photos];
    photos.splice(i, 1);
    updatePage(pageId, { photos });
  }
  res.redirect(`page=${encodeURIComponent(pageId)}`);
});

app.get('set-active-photo', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const i = parseInt(req.query.index);
  if (page.photos && i = 0 && i  page.photos.length) {
    updatePage(pageId, { currentPhoto page.photos[i] });
  }
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 ============================================
 SHARED LIBRARY
 ============================================
app.post('library-add-text', (req, res) = {
  const lib = loadLibrary();
  const key = req.body.key;
  if (!['titles', 'subtitles', 'buttonTexts'].includes(key)) return res.redirect('page=all&error=Invalid+key');
  const raw = req.body.items  '';
  const items = raw.split('n').map(s = s.trim()).filter(Boolean);
  lib[key] = lib[key]  [];
  let added = 0;
  items.forEach(item = { if (!lib[key].includes(item)) { lib[key].push(item); added++; } });
  saveLibrary(lib);
  res.redirect(`page=all&lib_msg=${encodeURIComponent('Added ' + added + ' item(s) to ' + key)}`);
});

app.get('library-remove-text', (req, res) = {
  const lib = loadLibrary();
  const key = req.query.key;
  if (!['titles', 'subtitles', 'buttonTexts'].includes(key)) return res.redirect('page=all&error=Invalid+key');
  lib[key] = lib[key]  [];
  const i = parseInt(req.query.index);
  if (i = 0 && i  lib[key].length) lib[key].splice(i, 1);
  saveLibrary(lib);
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Item removed from ' + key));
});

app.post('library-add-photo', (req, res) = {
  const lib = loadLibrary();
  const raw = req.body.photoUrls  req.body.photoUrl  '';
  const urls = raw.split([s,]+).map(s = s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u = { if (!lib.photos.includes(u)) { lib.photos.push(u); added++; } });
  saveLibrary(lib);
  res.redirect(`page=all&lib_msg=${encodeURIComponent('Added ' + added + ' photo(s) to shared library')}`);
});

app.get('library-remove-photo', (req, res) = {
  const lib = loadLibrary();
  const i = parseInt(req.query.index);
  if (i = 0 && i  lib.photos.length) lib.photos.splice(i, 1);
  saveLibrary(lib);
  res.redirect('page=all&lib_msg=' + encodeURIComponent('Photo removed'));
});

app.post('library-add-redirect', (req, res) = {
  const lib = loadLibrary();
  const setName = req.body.setName && lib.redirectSets[req.body.setName]  req.body.setName  DEFAULT_SET;
  const raw = req.body.redirectUrls  req.body.redirectUrl  '';
  const urls = raw.split([s,]+).map(s = s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u = { if (!lib.redirectSets[setName].includes(u)) { lib.redirectSets[setName].push(u); added++; } });
  saveLibrary(lib);
  res.redirect(`page=all&lib_msg=${encodeURIComponent('Added ' + added + ' URL(s) to ' + setName + '')}`);
});

app.get('library-remove-redirect', (req, res) = {
  const lib = loadLibrary();
  const setName = req.query.set && lib.redirectSets[req.query.set]  req.query.set  DEFAULT_SET;
  const i = parseInt(req.query.index);
  if (i = 0 && i  lib.redirectSets[setName].length) lib.redirectSets[setName].splice(i, 1);
  saveLibrary(lib);
  res.redirect('page=all&lib_msg=' + encodeURIComponent('URL removed from ' + setName + ''));
});

app.post('set-page-redirect-set', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const lib = loadLibrary();
  const setName = req.body.setName  req.query.set;
  if (setName && lib.redirectSets[setName]) {
    updatePage(pageId, { redirectSet setName });
  }
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 ============================================
 CARD TEMPLATES
 ============================================
app.get('backup', (req, res) = {
  const out = { exportedAt new Date().toISOString(), dataDir DATA_DIR, files {} };
  try {
    fs.readdirSync(DATA_DIR).filter(f = f.endsWith('.json') && f !== 'package.json' && f !== 'package-lock.json' && !^prerestore-.test(f)).forEach(f = {
      const raw = fs.readFileSync(`${DATA_DIR}${f}`, 'utf8');
      try { out.files[f] = JSON.parse(raw); } catch (e) { out.files[f] = { __unparsed raw }; }
    });
  } catch (e) {}
  const stamp = new Date().toISOString().slice(0, 19).replace([T]g, '-');
  res.setHeader('Content-Type', 'applicationjson; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=messagebot-backup-${stamp}.json`);
  res.send(JSON.stringify(out, null, 2));
});

app.post('restore-backup', (req, res) = {
  const body = req.body  {};
  const files = (body.files && typeof body.files === 'object')  body.files  null;
  if (!files  typeof files !== 'object'  Array.isArray(files)) {
    return res.json({ ok false, error 'This does not look like a backup file.' });
  }
  const safe = n = ^[w.-]+.json$.test(n) && n !== 'package.json' && n !== 'package-lock.json' && !^prerestore-.test(n);
  const names = Object.keys(files).filter(safe);
  if (!names.length) return res.json({ ok false, error 'No restorable data found.' });
  try {
    const snap = { exportedAt new Date().toISOString(), files {} };
    fs.readdirSync(DATA_DIR).filter(f = f.endsWith('.json') && safe(f)).forEach(f = {
      try { snap.files[f] = JSON.parse(fs.readFileSync(`${DATA_DIR}${f}`, 'utf8')); } catch (e) {}
    });
    const stamp = new Date().toISOString().slice(0, 19).replace([T]g, '-');
    fs.writeFileSync(`${DATA_DIR}prerestore-${stamp}.json`, JSON.stringify(snap));
  } catch (e) {}
  let restored = 0; const skipped = [];
  names.forEach(name = {
    try {
      const v = files[name];
      const content = (v && v.__unparsed !== undefined)  v.__unparsed  JSON.stringify(v, null, 2);
      fs.writeFileSync(`${DATA_DIR}${name}`, content);
      restored++;
    } catch (e) { skipped.push(name); }
  });
  res.json({ ok true, restored, skipped });
});

app.post('upload-image', async (req, res) = {
  const clientId = process.env.IMGUR_CLIENT_ID;
  if (!clientId) return res.status(400).json({ error 'IMGUR_CLIENT_ID is not set.' });
  const b64 = (req.body.image  '').replace(^dataimagew+;base64,, '');
  if (!b64) return res.status(400).json({ error 'No image provided' });
  try {
    const r = await fetch('httpsapi.imgur.com3image', {
      method 'POST',
      headers { 'Authorization' 'Client-ID ' + clientId, 'Content-Type' 'applicationjson' },
      body JSON.stringify({ image b64, type 'base64' })
    });
    const d = await r.json();
    if (d && d.success && d.data && d.data.link) return res.json({ url d.data.link });
    const msg = (d && d.data && d.data.error)  (typeof d.data.error === 'string'  d.data.error  'Imgur rejected')  'Imgur upload failed';
    return res.status(502).json({ error msg });
  } catch (e) {
    return res.status(502).json({ error 'Upload error ' + e.message });
  }
});

app.post('template-add', (req, res) = {
  const lib = loadLibrary();
  const b = req.body;
  const photos = parsePhotos(b.photos, b.photo);
  if (!photos.length) return res.redirect('page=templates&error=' + encodeURIComponent('At least one photo is required'));

  const setNames = getSetNames(lib);
  const sharedFields = {
    title (b.title  '').trim(),
    subtitle (b.subtitle  '').trim(),
    photos,
    photo photos[0],
    buttonText (b.buttonText  '').trim()  'My Photos 📞',
    active true
  };

   Collect filled redirect URLs per set
  const toCreate = [];
  setNames.forEach(name = {
    const url = normalizeUrl((b['redirect_' + name]  '').trim());
    if (url) toCreate.push({ set name, redirect url });
  });
   Fallback old single redirect field (used in edit mode)
  if (!toCreate.length && b.redirect) {
    const setName = (b.set && lib.redirectSets[b.set])  b.set  DEFAULT_SET;
    toCreate.push({ set setName, redirect normalizeUrl(b.redirect) });
  }
  if (!toCreate.length) return res.redirect('page=templates&error=' + encodeURIComponent('At least one redirect URL is required'));

   Generate IDs first so we can cross-link
  const newIds = toCreate.map(() = 't' + Date.now() + Math.floor(Math.random()  10000));
  const linkGroup = newIds.length  1  ('lg' + Date.now())  '';

  const newCards = toCreate.map((item, i) = ({
    ...sharedFields,
    id newIds[i],
    set item.set,
    redirect item.redirect,
    linkGroup,
     For backward compat with existing 2-card linked system
    linkedId newIds.length === 2  newIds[1 - i]  undefined
  }));

  lib.cardTemplates = lib.cardTemplates  [];
   Add all new cards at the front
  newCards.reverse().forEach(card = lib.cardTemplates.unshift(card));
  saveLibrary(lib);

  const firstId = newIds[0];
  const msg = newCards.length  1
     `${newCards.length} cards created (${toCreate.map(t = t.set).join(', ')}) — all linked`
     'Template added to ' + toCreate[0].set;
  res.redirect('page=templates&new=' + firstId + '&lib_msg=' + encodeURIComponent(msg));
});

app.post('template-edit', (req, res) = {
  const lib = loadLibrary();
  const b = req.body;
  const t = (lib.cardTemplates  []).find(x = x.id === b.id);
  if (!t) return res.redirect('page=templates&error=Template+not+found');

   Update this card's shared fields
  if (b.title !== undefined) t.title = b.title.trim();
  if (b.subtitle !== undefined) t.subtitle = b.subtitle.trim();
  if (b.photos !== undefined) {
    const photos = parsePhotos(b.photos, b.photo);
    if (photos.length) {
      t.photos = photos;
      t.photo = photos[0];
       Save activePhotos — if submitted, use them; otherwise keep existing or default to all
      if (b.activePhotos) {
        try {
          const ap = JSON.parse(b.activePhotos);
          t.activePhotos = Array.isArray(ap) && ap.length  ap  photos;
        } catch { t.activePhotos = photos; }
      }
    }
  } else if (b.photo && b.photo.trim()) {
    t.photo = b.photo.trim(); t.photos = [t.photo];
  }
  if (b.buttonText !== undefined) t.buttonText = b.buttonText.trim()  'My Photos 📞';

   Update this card's OWN redirect
  const setNames = getSetNames(lib);
  const ownRedirectKey = 'redirect_' + t.set;
  if (b[ownRedirectKey]) t.redirect = normalizeUrl(b[ownRedirectKey]);
  else if (b.redirect) t.redirect = normalizeUrl(b.redirect);

   Find all linked cards — by linkGroup first, then fall back to linkedId pair
  const groupMembers = t.linkGroup
     (lib.cardTemplates  []).filter(x = x.linkGroup === t.linkGroup && x.id !== t.id)
     [];
  const legacyPartner = (!t.linkGroup && b.linkedId)
     (lib.cardTemplates  []).find(x = x.id === b.linkedId)
     null;
  const partners = groupMembers.length  groupMembers  (legacyPartner  [legacyPartner]  []);

  let synced = 0;
  partners.forEach(partner = {
    partner.title = t.title;
    partner.subtitle = t.subtitle;
    partner.photos = t.photos  [...t.photos]  [];
    partner.photo = t.photo;
    partner.buttonText = t.buttonText;
     Update partner's own redirect if a field for its set was submitted
    const partnerRedirectKey = 'redirect_' + partner.set;
    if (b[partnerRedirectKey] && b[partnerRedirectKey].trim()) {
      partner.redirect = normalizeUrl(b[partnerRedirectKey].trim());
    } else if (b.linkedRedirect && b.linkedRedirect.trim() && !t.linkGroup) {
      partner.redirect = normalizeUrl(b.linkedRedirect.trim());
    }
     Keep legacy linkedId in sync
    partner.linkedId = t.id;
    t.linkedId = partner.id;
    synced++;
  });

  saveLibrary(lib);
  const msg = synced  0
     `Template updated + synced to ${synced} linked card(s) ✅`
     'Template updated';
  res.redirect('page=templates&lib_msg=' + encodeURIComponent(msg));
});

app.get('template-duplicate', (req, res) = {
  const lib = loadLibrary();
  const src = (lib.cardTemplates  []).find(t = t.id === req.query.id);
  if (!src) return res.redirect('page=templates&error=Template+not+found');
  const toSet = (req.query.to && lib.redirectSets[req.query.to])  req.query.to  (src.set === SECOND_SET  DEFAULT_SET  SECOND_SET);
  const url = normalizeUrl(req.query.url  '');
  if (!url) return res.redirect('page=templates&error=' + encodeURIComponent('A gallery URL is required'));
  const photos = (Array.isArray(src.photos) && src.photos.length)  src.photos.slice()  (src.photo  [src.photo]  []);
  const dupId = 't' + Date.now() + Math.floor(Math.random()  1000);
  const dup = {
    id dupId,
    title src.title, subtitle src.subtitle,
    photos, photo photos[0]  '',
    redirect url, buttonText src.buttonText, active true, set toSet,
    linkedId src.id   link dup → src
  };
   Also link src → dup (bidirectional)
  src.linkedId = dupId;
  lib.cardTemplates = lib.cardTemplates  [];
  lib.cardTemplates.unshift(dup);
  saveLibrary(lib);
  res.redirect('page=templates&new=' + dup.id + '&lib_msg=' + encodeURIComponent('Card duplicated to ' + toSet + ' and linked — edits will sync between them'));
});

app.post('templates-bulk-active', (req, res) = {
  const lib = loadLibrary();
  const ids = Array.isArray(req.body.ids)  req.body.ids  [];
  const makeActive = !!req.body.active;
  let n = 0;
  (lib.cardTemplates  []).forEach(t = { if (ids.indexOf(t.id) !== -1) { t.active = makeActive; n++; } });
  saveLibrary(lib);
  res.json({ ok true, updated n });
});

 Manually link two existing cards (bidirectional)
app.post('template-link', (req, res) = {
  const lib = loadLibrary();
  const { id, partnerId } = req.body;
  const t = (lib.cardTemplates  []).find(x = x.id === id);
  const partner = (lib.cardTemplates  []).find(x = x.id === partnerId);
  if (!t) return res.json({ ok false, error 'Card not found ' + id });
  if (!partner) return res.json({ ok false, error 'Partner card not found ' + partnerId + ' — check the ID is correct' });
  if (t.set === partner.set) return res.json({ ok false, error 'Both cards are in the same set (' + t.set + ') — link one Scrollgallery card to one TheViralBox card' });
   Clear any old links first
  if (t.linkedId) { const old = lib.cardTemplates.find(x = x.id === t.linkedId); if (old) old.linkedId = undefined; }
  if (partner.linkedId) { const old = lib.cardTemplates.find(x = x.id === partner.linkedId); if (old) old.linkedId = undefined; }
   Set new bidirectional link
  t.linkedId = partner.id;
  partner.linkedId = t.id;
  saveLibrary(lib);
  res.json({ ok true });
});

 Unlink a card pair (removes linkedId from both)
app.get('template-unlink', (req, res) = {
  const lib = loadLibrary();
  const t = (lib.cardTemplates  []).find(x = x.id === req.query.id);
  if (t) {
    if (t.linkedId) {
      const partner = lib.cardTemplates.find(x = x.id === t.linkedId);
      if (partner) partner.linkedId = undefined;
    }
    t.linkedId = undefined;
    saveLibrary(lib);
  }
  res.redirect('page=templates&lib_msg=' + encodeURIComponent('Cards unlinked — each now edits independently'));
});

app.get('template-delete', (req, res) = {
  const lib = loadLibrary();
  lib.cardTemplates = (lib.cardTemplates  []).filter(t = t.id !== req.query.id);
  saveLibrary(lib);
  res.redirect('page=templates&lib_msg=' + encodeURIComponent('Template deleted'));
});

 ============================================
 CONTENT MODE
 ============================================
app.post('master-redirect-on', (req, res) = {
  const s = loadSettings();
  const url = normalizeUrl(req.body.url  '');
  if (!url) return res.redirect('page=templates&error=' + encodeURIComponent('Enter a URL first'));
  s.masterRedirect = { enabled true, url };
  saveSettings(s);
  res.redirect('page=templates&lib_msg=' + encodeURIComponent('Master redirect ON → ' + url));
});

app.post('master-redirect-off', (req, res) = {
  const s = loadSettings();
  const url = (s.masterRedirect && s.masterRedirect.url)  '';
  s.masterRedirect = { enabled false, url };
  saveSettings(s);
  res.redirect('page=templates&lib_msg=' + encodeURIComponent('Master redirect OFF'));
});

app.post('set-global-mode', (req, res) = {
  const s = loadSettings();
  s.contentMode = req.body.mode === 'templates'  'templates'  'classic';
  saveSettings(s);
  const back = req.body.returnTo === 'templates'  'page=templates'  'page=all';
  res.redirect(back + '&lib_msg=' + encodeURIComponent('Global mode set to ' + s.contentMode.toUpperCase()));
});

app.post('set-page-mode', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const m = req.body.mode;
  updatePage(pageId, { contentMode (m === 'classic'  m === 'templates')  m  'global' });
  res.redirect(req.body.returnTo === 'page'  `page=${encodeURIComponent(pageId)}&saved=1`  'saved=1');
});

 ============================================
 SET ACTIVE FROM LIBRARY
 ============================================
app.get('set-active-from-library', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const lib = loadLibrary();
  const updates = {};
  if (req.query.photoIndex !== undefined) {
    const i = parseInt(req.query.photoIndex);
    if (i = 0 && i  lib.photos.length) {
      const photo = lib.photos[i];
      updates.currentPhoto = photo; updates.lastPhoto = photo;
      const photos = Array.isArray(page.photos)  [...page.photos]  [];
      if (!photos.includes(photo)) photos.unshift(photo);
      updates.photos = photos;
    }
  }
  if (req.query.redirectIndex !== undefined) {
    const setName = pageSet(page, lib);
    const pool = lib.redirectSets[setName]  [];
    const i = parseInt(req.query.redirectIndex);
    if (i = 0 && i  pool.length) { updates.whatsapp = pool[i]; updates.lastRedirect = pool[i]; }
  }
  if (Object.keys(updates).length) updatePage(pageId, updates);
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 ============================================
 RANDOMIZE
 ============================================
app.post('randomize-page', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const only = req.query.only;
  const opts = only === 'photo'  { photo true, redirect false }  only === 'redirect'  { photo false, redirect true }  {};
  randomizePage(page, opts);
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('randomize-and-send', (req, res) = {
  const pageId = req.query.page;
  let page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  page = randomizePage(page, {});
  const count = broadcastToPage(page, {});
  res.send(`${renderHead('Randomize + Send')}div class=containerdiv class=card
    h2🎲 Randomized & Broadcasting — ${esc(page.label)}h2
    pSending to strong${count} fansstrong.p
    div style=background#f0f6ff;border1px solid #b5d4f4;border-radius8px;padding12px;margin14px 0;font-size13px;
      div📸 Photo code${esc(page.currentPhoto  '')}codediv
      div style=margin-top6px;🔗 Redirect code${esc(page.whatsapp  '')}codediv
    div
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

app.post('randomize-all', (req, res) = {
  const pages = loadPages();
  pages.forEach(p = { const fresh = getPage(p.pageId); if (fresh) randomizePage(fresh, {}); });
  res.redirect('page=all&lib_msg=' + encodeURIComponent('All ' + pages.length + ' pages randomized'));
});

 ============================================
 RESET STATS
 ============================================
app.post('reset-stats', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  resetStats(pageId);
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('reset-stats-all', (req, res) = {
  const pages = loadPages();
  pages.forEach(p = resetStats(p.pageId));
  res.redirect('page=all&lib_msg=' + encodeURIComponent('All stats reset on ' + pages.length + ' pages'));
});

 ============================================
 FANS
 ============================================
app.post('add-fan', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  if (req.body.psid) saveFan(pageId, req.body.psid.trim());
  res.redirect(`page=${encodeURIComponent(pageId)}`);
});

app.get('clear-fans', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  saveFansList(pageId, []);
  res.redirect(`page=${encodeURIComponent(pageId)}`);
});

app.post('bulk-add-fans', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  const text = req.body.psids  '';
  const psids = text.split([s,]+).map(s = s.trim()).filter(s = ^d{6,}$.test(s));
  const before = loadFans(pageId).length;
  const combined = [...new Set([...loadFans(pageId), ...psids])];
  saveFansList(pageId, combined);
  const added = combined.length - before;
  res.send(`${renderHead('Bulk Import')}div class=containerdiv class=card
    h2✅ Bulk Import Doneh2
    pFound strong${psids.length}strong · Added strong${added}strong · Duplicates skipped strong${psids.length - added}strong · Total fans strong${combined.length}strongp
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

app.get('export-fans', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  const filename = `fans-${pageId}-${new Date().toISOString().split('T')[0]}.txt`;
  res.setHeader('Content-Type', 'textplain');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.send(loadFans(pageId).join('n'));
});

async function importContactsForPage(pageId) {
  const page = getPage(pageId);
  if (!page) throw new Error('Unknown page');
  let all = [];
  let url = `httpsgraph.facebook.comv2.6meconversationsfields=participants&access_token=${page.accessToken}`;
  while (url) {
    const d = await fetch(url).then(r = r.json());
    if (d.error) throw new Error(d.error.message);
    (d.data  []).forEach(c = (c.participants.data  []).forEach(p = {
      if (p.id !== page.pageId && !all.includes(p.id)) all.push(p.id);
    }));
    url = d.paging.next  null;
  }
  const combined = [...new Set([...loadFans(pageId), ...all])];
  saveFansList(pageId, combined);
  if (!page.baselineFans  page.baselineFans === 0) {
    updatePage(pageId, { baselineFans combined.length });
  }
  return { found all.length, total combined.length };
}

 Find which pages have a given PSID as a fan
app.get('find-psid', (req, res) = {
  const psid = (req.query.psid  '').trim();
  if (!psid) return res.json({ pages [] });
  const pages = loadPages();
  const found = pages.filter(p = loadFans(p.pageId).includes(psid))
    .map(p = ({ pageId p.pageId, label p.label }));
  res.json({ pages found });
});

app.post('import-contacts-json', async (req, res) = {
  try {
    const r = await importContactsForPage(req.query.page);
    res.json({ ok true, found r.found, total r.total });
  } catch (e) {
    res.json({ ok false, error e.message });
  }
});

 Batch import — multiple pages in parallel
app.post('import-contacts-batch', async (req, res) = {
  const pageIds = Array.isArray(req.body.pageIds)  req.body.pageIds  [];
  if (!pageIds.length) return res.json({ ok false, error 'No pages' });
  const results = await Promise.allSettled(
    pageIds.map(pid =
      importContactsForPage(pid)
        .then(r = ({ pid, ok true, found r.found, total r.total }))
        .catch(e = ({ pid, ok false, error e.message }))
    )
  );
  const out = results.map(r = r.value  { pid '', ok false, error 'unknown' });
  res.json({ ok true, results out });
});

app.get('import-contacts', async (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  try {
    const _imp = await importContactsForPage(pageId);
    res.send(`${renderHead('Import')}div class=containerdiv class=card
      h2✅ Import Complete for ${esc(page.label)}h2
      pFound strong${_imp.found}strong · Total fans strong${_imp.total}strongp
      a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
    divdivbodyhtml`);
  } catch (e) {
    res.send(`${renderHead('Import Error')}div class=containerdiv class=card
      h2❌ ${esc(e.message)}h2
      a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
    divdivbodyhtml`);
  }
});

 ============================================
 BROADCASTS
 ============================================
app.post('test-send', async (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const psid = (req.body.psid  '').trim();
  if (!^d{6,}$.test(psid)) {
    return res.send(`${renderHead('Test Send')}div class=containerdiv class=card
      h2❌ Invalid PSIDh2pPSID must be at least 6 digits.p
      a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
    divdivbodyhtml`);
  }
  const result = await sendCard(page, psid, { skipRemoval true });
  if (result && result.error) {
    const errCode = result.error.code  '';
    const errMsg = result.error.message  'Unknown error';
    return res.send(`${renderHead('Test Send Failed')}div class=containerdiv class=card style=border1px solid #fca5a5;background#fef2f2;
      h2 style=color#991b1b;❌ Test Send Failedh2
      pstrongCodestrong ${esc(String(errCode))} · strongMessagestrong ${esc(errMsg)}p
      a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
    divdivbodyhtml`);
  }
  res.send(`${renderHead('Test Send')}div class=containerdiv class=card style=border1px solid #86efac;background#f0fdf4;
    h2 style=color#166534;✅ Test Card Sent!h2
    pPSID ${esc(psid)} · Photo a href=${esc(page.currentPhoto)} target=_blank${esc(page.currentPhoto)}ap
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

app.get('send-now', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const count = broadcastToPage(page, { subtitle getRotatingSubtitle() });
  res.send(`${renderHead('Broadcast')}div class=containerdiv class=card
    h2📣 Broadcast Started for ${esc(page.label)}h2
    pSending to strong${count} fansstrong, spaced ${page.spacingSeconds  10}s apart. Est. ~${Math.ceil(count  (page.spacingSeconds  10)  60)} min.p
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

app.post('send-custom', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const count = broadcastToPage(page, { photo req.body.photo  undefined });
  res.send(`${renderHead('Broadcast')}div class=containerdiv class=card
    h2🚀 Custom Broadcast Started for ${esc(page.label)}h2
    pSending to strong${count} fansstrong.p
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

 Card 2 — save settings
app.post('update-card2', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  updatePage(pageId, { card2 {
    title (req.body.title2  '').trim(),
    subtitle (req.body.subtitle2  '').trim(),
    buttonText (req.body.buttonText2  '').trim()  'My Photos',
    redirect (req.body.redirect2  '').trim(),
    photo (req.body.photo2  '').trim()
  }});
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 Card 2 — send to all fans
app.get('send-now2', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const card2 = page.card2;
  if (!card2  !card2.photo) return res.redirect(`page=${encodeURIComponent(pageId)}&error=Card+2+not+set+up`);
  broadcastToPage(page, { photo card2.photo, title card2.title, subtitle card2.subtitle, buttonText card2.buttonText, redirect card2.redirect });
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 Plain text messages — add
app.post('add-text-message', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const text = (req.body.text  '').trim();
  if (!text) return res.redirect(`page=${encodeURIComponent(pageId)}&error=Empty+message`);
  const msgs = page.textMessages  [];
  msgs.push({ id 'tm' + Date.now(), text });
  updatePage(pageId, { textMessages msgs });
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 Plain text messages — delete
app.post('delete-text-message', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const msgId = req.query.msgId;
  const msgs = (page.textMessages  []).filter(m = m.id !== msgId);
  updatePage(pageId, { textMessages msgs });
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

 Plain text messages — send to all fans
app.post('send-text-message-now', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const msgId = req.query.msgId;
  const msg = (page.textMessages  []).find(m = m.id === msgId);
  if (!msg) return res.redirect(`page=${encodeURIComponent(pageId)}&error=Message+not+found`);
  broadcastToPage(page, { textOnly true, text msg.text });
  res.redirect(`page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('save-text-template', (req, res) = {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('error=Unknown+page');
  updatePage(pageId, { textTemplate req.body.textTemplate  '' });
  res.redirect(`page=${encodeURIComponent(pageId)}&text_saved=1`);
});

app.post('send-text-now', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const text = (page.textTemplate  '').trim();
  if (!text) return res.redirect(`page=${encodeURIComponent(pageId)}&error=${encodeURIComponent('No text template saved.')}`);
  const count = broadcastTextToPage(page, text);
  res.send(`${renderHead('Text Broadcast')}div class=containerdiv class=card
    h2💬 Text Broadcast Started for ${esc(page.label)}h2
    pSending to strong${count} fansstrong.p
    div style=background#fef3e7;border1px solid #fde68a;border-radius8px;padding12px;margin14px 0;
      div style=font-size13px;white-spacepre-wrap;${esc(text)}div
    div
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

const scheduledBroadcasts = {};
app.post('schedule-once', (req, res) = {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('error=Unknown+page');
  const t = new Date(req.body.scheduleTime);
  const delay = t.getTime() - Date.now();
  if (delay = 0) {
    return res.send(`${renderHead('Schedule')}div class=containerdiv class=card
      h2❌ Time must be in the future!h2
      a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
    divdivbodyhtml`);
  }
  if (scheduledBroadcasts[pageId]) clearTimeout(scheduledBroadcasts[pageId]);
  scheduledBroadcasts[pageId] = setTimeout(() = {
    const p2 = getPage(pageId);
    if (p2) broadcastToPage(p2);
    delete scheduledBroadcasts[pageId];
  }, delay);
  res.send(`${renderHead('Scheduled')}div class=containerdiv class=card
    h2📅 Scheduled for ${esc(page.label)}h2
    pWill send at strong${esc(t.toLocaleString())}strongp
    a href=page=${encodeURIComponent(pageId)} class=btn btn-green← Backa
  divdivbodyhtml`);
});

 ============================================
 MASTER CRON
 ============================================
const broadcastGuard = {};
cron.schedule('    ', () = {
  const pages = loadPages();
  const now = new Date();
  pages.forEach(page = {
    if (!page.broadcastEnabled) return;
    if (!page.broadcastTime  !page.broadcastTime.includes('')) return;
    const [h, m] = page.broadcastTime.split('');
    const hh = h.padStart(2, '0');
    const mm = m.padStart(2, '0');
    let curH, curM, curDate;
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone page.timezone  'UTC',
        year 'numeric', month '2-digit', day '2-digit',
        hour '2-digit', minute '2-digit', hour12 false
      });
      const parts = fmt.formatToParts(now);
      curH = parts.find(p = p.type === 'hour').value;
      curM = parts.find(p = p.type === 'minute').value;
      curDate = `${parts.find(p = p.type === 'year').value}-${parts.find(p = p.type === 'month').value}-${parts.find(p = p.type === 'day').value}`;
    } catch (e) {
      console.error(`[${page.label}] Bad timezone ${page.timezone}`, e.message);
      return;
    }
    if (curH === hh && curM === mm && broadcastGuard[page.pageId] !== curDate) {
      broadcastGuard[page.pageId] = curDate;
      console.log(`⏰ [${page.label}] Daily broadcast at ${curH}${curM} ${page.timezone}`);
      let fresh = page;
      try {
        const lib = loadLibrary();
        if (lib.photos.length  Object.values(lib.redirectSets).some(a = a.length)) {
          fresh = randomizePage(page, {});
        }
      } catch (e) {
        console.error(`[${page.label}] Auto-randomize failed`, e.message);
      }
      broadcastToPage(fresh, { subtitle getRotatingSubtitle() });
    }
  });
});

 ============================================
 START
 ============================================
app.listen(PORT, () = {
  console.log(`✅ messagebot running on port ${PORT}`);
  console.log(`🌐 Public URL ${PUBLIC_URL  '(not set yet)'}`);
  console.log(`🔒 Admin ${ADMIN_USER}  ${ADMIN_PASS === 'changeme'  '⚠️  CHANGE DEFAULT PASSWORD!'  '(set)'}`);
  const pages = loadPages();
  console.log(`📋 Loaded ${pages.length} page(s)`);
  pages.forEach(p = console.log(`   - ${p.label} (${p.pageId}) — broadcast ${p.broadcastEnabled  'ON'  'OFF'} at ${p.broadcastTime} ${p.timezone} · group ${p.group  'none'}`));
});
