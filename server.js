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
app.use(express.json());
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
    broadcastEnabled: process.env.DEFAULT_BROADCAST_ENABLED !== 'false',
    spacingSeconds: parseInt(process.env.DEFAULT_SPACING_SECONDS) || 10
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
    broadcastEnabled: data.broadcastEnabled !== undefined ? data.broadcastEnabled : d.broadcastEnabled,
    sendNowEnabled: data.sendNowEnabled !== undefined ? data.sendNowEnabled : true,
    spacingSeconds: data.spacingSeconds || d.spacingSeconds,
    cleanupThreshold: data.cleanupThreshold !== undefined ? data.cleanupThreshold : 1,
    baselineFans: data.baselineFans || 0,
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
// SHARED LIBRARY (library.json on volume)
// One global pool of photos + redirect URLs, shared by ALL pages.
// Add/remove from main dashboard → instantly available everywhere.
// ============================================
const LIBRARY_FILE = `${DATA_DIR}/library.json`;

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

// Redirect Sets: named pools of redirect URLs. Each page is assigned to one set.
// Photos stay in ONE shared pool (all pages). Only redirects are split by set.
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
    // First run — seed
    const seed = {
      photos: [...LIBRARY_SEED_PHOTOS],
      redirectSets: JSON.parse(JSON.stringify(LIBRARY_SEED_REDIRECT_SETS))
    };
    try { saveLibrary(seed); } catch {}
    return seed;
  }
  // Normalize + migrate older formats
  const photos = Array.isArray(lib.photos) ? lib.photos : [];
  let redirectSets = lib.redirectSets && typeof lib.redirectSets === 'object' ? lib.redirectSets : null;
  if (!redirectSets) {
    // Migrate old flat `redirects` array → wrap into the default set
    const oldFlat = Array.isArray(lib.redirects) ? lib.redirects : [];
    redirectSets = { [DEFAULT_SET]: oldFlat, [SECOND_SET]: [] };
  }
  // Guarantee both default sets always exist
  if (!Array.isArray(redirectSets[DEFAULT_SET])) redirectSets[DEFAULT_SET] = [];
  if (!Array.isArray(redirectSets[SECOND_SET])) redirectSets[SECOND_SET] = [];
  const normalized = { photos, redirectSets };
  // Persist migration if shape changed
  if (!lib.redirectSets) { try { saveLibrary(normalized); } catch {} }
  return normalized;
}
function saveLibrary(lib) {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2));
}
// Return the list of set names (ordered, defaults first)
function getSetNames(lib) {
  lib = lib || loadLibrary();
  const names = Object.keys(lib.redirectSets);
  // Ensure default sets lead the list
  const ordered = [DEFAULT_SET, SECOND_SET].filter(n => names.includes(n));
  names.forEach(n => { if (!ordered.includes(n)) ordered.push(n); });
  return ordered;
}
// Resolve which set a page uses (default if unset/invalid)
function pageSet(page, lib) {
  lib = lib || loadLibrary();
  const s = page.redirectSet;
  if (s && Array.isArray(lib.redirectSets[s])) return s;
  return DEFAULT_SET;
}

// Pick a random item from arr that isn't `avoid` (when possible)
function pickRandom(arr, avoid) {
  if (!arr || arr.length === 0) return undefined;
  if (arr.length === 1) return arr[0];
  const pool = arr.filter(x => x !== avoid);
  const choices = pool.length ? pool : arr;
  return choices[Math.floor(Math.random() * choices.length)];
}

// Randomize one page's active photo + redirect.
// Photo comes from the shared photo pool; redirect comes from the page's assigned SET.
// Honors "different from previous" by avoiding the page's last picks.
// opts: { photo: true, redirect: true } — which to randomize (default both)
function randomizePage(page, opts = {}) {
  const doPhoto = opts.photo !== false;
  const doRedirect = opts.redirect !== false;
  const lib = loadLibrary();
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
    const setName = pageSet(page, lib);
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

// Track a send failure for a fan, increment their consecutive-failure counter.
// Only remove the fan if their counter reaches the page's cleanupThreshold.
// This protects against FB's "outside 24h window" false negatives — some fans
// (admins, testers, very active users) can receive messages even when FB returns
// error code 10. Requiring N consecutive failures avoids removing those fans.
function trackFailureForFan(pageId, psid, reason) {
  const page = getPage(pageId);
  const threshold = (page && page.cleanupThreshold !== undefined) ? page.cleanupThreshold : 1;
  if (threshold === 0) return; // auto-cleanup disabled
  const s = loadStats(pageId);
  s.fanFailures = s.fanFailures || {};
  s.fanFailures[psid] = (s.fanFailures[psid] || 0) + 1;
  const count = s.fanFailures[psid];
  if (count >= threshold) {
    // Remove the fan
    const fans = loadFans(pageId);
    const filtered = fans.filter(p => p !== psid);
    if (filtered.length !== fans.length) {
      saveFansList(pageId, filtered);
      s.removedFans = s.removedFans || [];
      s.removedFans.push({ psid, reason: `${count} consecutive failures: ${reason || 'unreachable'}`, time: new Date().toISOString() });
      delete s.fanFailures[psid]; // clear counter
      console.log(`[${pageId}] Auto-removed fan ${psid} after ${count} failures (${reason}) | Remaining: ${filtered.length}`);
    }
  } else {
    console.log(`[${pageId}] Fan ${psid} failure ${count}/${threshold} (${reason}) — not removed yet`);
  }
  saveStats(pageId, s);
}

// Reset a fan's failure counter when they successfully receive a message.
// This is critical: a single success "saves" them from being removed.
function clearFailuresForFan(pageId, psid) {
  const s = loadStats(pageId);
  if (s.fanFailures && s.fanFailures[psid]) {
    delete s.fanFailures[psid];
    saveStats(pageId, s);
  }
}

// Legacy helper kept for compatibility (manual remove from dashboard)
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
// Reset all stats (clicks, sent, failed, reads, deliveries, daily history) to zero.
// Does NOT touch the fan list (fans-{pageId}.json) or baselineFans.
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
  // Daily breakdown
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

// Spacing dropdown helper
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

// Daily message stats helper
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
  const trackUrl = `${PUBLIC_URL}/track?psid=${psid}&pageId=${page.pageId}`;
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
      // Track failure: only auto-remove fan after N consecutive failures
      // (default 3). Protects against FB's "outside 24h window" false negatives.
      // Match by error code primarily; regex on text as a backup in case FB rewords.
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
      // Successful send — reset failure counter for this fan
      clearFailuresForFan(page.pageId, psid);
    }
    return data;
  }).catch(err => {
    trackMessage(page.pageId, false);
    console.error(`[${page.label}] Card error (psid ${psid}):`, err.message);
    return { error: { message: err.message } };
  });
}

function broadcastToPage(page, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds || 10) * 1000;
  fans.forEach((psid, i) => {
    setTimeout(() => sendCard(page, psid, opts), i * spacing);
  });
  return fans.length;
}

// ============================================
// PLAIN TEXT MESSAGES (Template 2 — no card, just text)
// Same failure-tracking and auto-cleanup logic as sendCard.
// ============================================
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
  fans.forEach((psid, i) => {
    setTimeout(() => sendText(page, psid, text, opts), i * spacing);
  });
  return fans.length;
}

// ============================================
// PUBLIC ROUTES — no auth (Facebook + fans hit these)
// ============================================

// Webhook verification (Facebook → bot handshake)
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

// Webhook receiver — routes by entry.id to the right page
app.post('/webhook', (req, res) => {
  if (req.body.object !== 'page') return res.sendStatus(404);
  req.body.entry.forEach(entry => {
    const pageId = entry.id;
    const page = getPage(pageId);
    if (!page) {
      console.warn(`Webhook received for unknown page ${pageId} — add it to messagebot or it will be ignored`);
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

// Click tracker — routes by pageId to the right WhatsApp URL
// Redirect-first design: fan gets redirected immediately, tracking happens after.
// If tracking fails for any reason, fan experience is unaffected.
app.get('/track', (req, res) => {
  const pageId = req.query.pageId;
  const psid = req.query.psid || 'unknown';
  const page = getPage(pageId);
  const dest = page ? page.whatsapp : getDefaults().whatsapp;
  // Send the redirect FIRST so the fan never waits on disk I/O or tracking errors
  res.redirect(dest);
  // Track in background (fire-and-forget), errors logged but don't block fan
  if (page) {
    setImmediate(() => {
      try { trackClick(pageId, psid); }
      catch (e) { console.error(`[${page.label}] Click tracking failed (fan was redirected ok):`, e.message); }
    });
  }
});

// ============================================
// 🔒 AUTH WALL — everything below requires login
// ============================================
app.use(basicAuth({
  users: { [ADMIN_USER]: ADMIN_PASS },
  challenge: true,
  realm: 'messagebot'
}));

// ============================================
// DASHBOARD
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
  details { margin: 10px 0; }
  summary { cursor: pointer; font-weight: 600; color: #4a5568; padding: 6px 0; }
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

  // Set-assignment buttons (one per set)
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
        <div style="font-size:13px;font-weight:600;color:#065f46;margin-bottom:8px;">🌐 Redirect Set for this page — randomize pulls URLs ONLY from the selected set:</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${setButtons}
        </div>
        <div style="font-size:11px;color:#047857;margin-top:8px;">Currently using: <strong>${esc(currentSet)}</strong> — randomize + "tap a URL" below both use this set's URLs only.</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
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
        </form>
      </div>

      <div style="background:#faf5ff;border-radius:8px;padding:12px;margin-bottom:14px;font-size:12px;">
        <div><strong>Active now:</strong></div>
        <div style="margin-top:4px;color:#6b21a8;">📸 ${esc((page.currentPhoto || '(none)').split('/').pop())}</div>
        <div style="color:#6b21a8;">🔗 ${esc((page.whatsapp || '(none)').replace(/^https?:\/\//, ''))}</div>
      </div>

      <h3 style="font-size:14px;color:#1a1d2e;margin:0 0 8px;">📸 Tap a photo to set active (${lib.photos.length} — shared pool)</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(85px,1fr));gap:8px;margin-bottom:16px;">
        ${photoThumbs || '<span style="color:#94a3b8;font-size:12px;">Library empty — add photos on the main dashboard.</span>'}
      </div>

      <h3 style="font-size:14px;color:#1a1d2e;margin:0 0 8px;">🔗 Tap a URL to set active — from "${esc(currentSet)}" set (${pool.length})</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${redirectBtns || '<span style="color:#94a3b8;font-size:12px;">This set is empty — add URLs to it on the main dashboard.</span>'}
      </div>

      <div class="helper" style="margin-top:12px;">Photos are shared by all pages. Redirect URLs come from this page's assigned set. To edit the pools, use the 🗂️ Shared Library on the <a href="/?page=all">main dashboard</a>.</div>
    </div>`;
}

function renderLibraryManager() {
  const lib = loadLibrary();
  const photoChips = lib.photos.map((url, i) => `
    <div style="position:relative;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#fff;">
      <img src="${esc(url)}" style="width:100%;height:80px;object-fit:cover;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"/>
      <div style="display:none;width:100%;height:80px;align-items:center;justify-content:center;background:#f1f5f9;color:#94a3b8;font-size:10px;text-align:center;padding:4px;">${esc(url.split('/').pop())}</div>
      <a href="/library-remove-photo?index=${i}" onclick="return confirm('Remove this photo from the shared library? It stays on pages already using it.')" style="position:absolute;top:3px;right:3px;background:rgba(220,38,38,0.9);color:#fff;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:18px;text-align:center;text-decoration:none;">×</a>
      <div style="font-size:9px;color:#94a3b8;text-align:center;padding:2px;">#${i + 1}</div>
    </div>`).join('');

  const setNames = getSetNames(lib);
  // Build a section per redirect set
  const setSections = setNames.map(name => {
    const urls = lib.redirectSets[name] || [];
    const chips = urls.map((url, i) => {
      const short = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
      return `<div style="display:inline-flex;align-items:center;gap:4px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:4px 8px;font-size:11px;font-family:monospace;">
        <span style="color:#475569;">${esc(short)}</span>
        <a href="/library-remove-redirect?set=${encodeURIComponent(name)}&index=${i}" onclick="return confirm('Remove this URL from the ${esc(name)} set?')" style="color:#dc2626;text-decoration:none;font-weight:700;">×</a>
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
      <h2>🗂️ Shared Library <span style="font-size:12px;font-weight:400;color:#8b5cf6;">— available on every page</span></h2>
      <p style="color:#6b7280;font-size:13px;">Add photos and redirect URLs here once. They appear on <strong>all pages</strong> for one-click "set active" and feed the 🎲 randomizer. Edits here update every page instantly.</p>

      <div style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h3 style="margin:0;font-size:14px;color:#1a1d2e;">📸 Shared Photos (${lib.photos.length})</h3>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-bottom:10px;">
          ${photoChips || '<span style="color:#94a3b8;font-size:12px;">No photos yet.</span>'}
        </div>
        <form action="/library-add-photo" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;">
          <textarea name="photoUrls" placeholder="Paste one or more image URLs (one per line or comma-separated)&#10;https://i.imgur.com/xxxxx.png" style="flex:1;min-width:260px;min-height:48px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-family:monospace;font-size:12px;"></textarea>
          <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add Photo(s)</button>
        </form>
      </div>

      <div style="margin-top:20px;border-top:1px solid #f1f5f9;padding-top:16px;">
        <h3 style="margin:0 0 4px;font-size:14px;color:#1a1d2e;">🔗 Redirect Sets</h3>
        <p style="font-size:12px;color:#6b7280;margin:0 0 4px;">Each page is assigned to ONE set. When randomizing, a page only picks URLs from its assigned set. Assign a page to a set on that page's dashboard.</p>
        ${setSections}
      </div>
    </div>`;
}

function renderAllPagesView(pages, req) {
  const todayStr = new Date().toISOString().split('T')[0];
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
    const pauseBtn = p.broadcastEnabled
      ? `<form action="/toggle-page" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-pause" title="Stops daily auto-broadcast">⏸️ Pause Daily</button></form>`
      : `<form action="/toggle-page" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-resume" title="Re-enables daily auto-broadcast">▶️ Resume Daily</button></form>`;
    const sendNowToggle = sendNowOn
      ? `<form action="/toggle-sendnow" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn" style="background:#f59e0b;" title="Exclude this page from bulk Send Now to All">🚫 Pause SendNow</button></form>`
      : `<form action="/toggle-sendnow" method="POST" style="display:inline;margin:0;"><input type="hidden" name="pageId" value="${esc(p.pageId)}"/><button type="submit" class="qbtn qbtn-resume" title="Include this page in bulk Send Now to All">✅ Resume SendNow</button></form>`;
    return `<tr>
      <td><strong>${esc(p.label)}</strong><br/><span style="font-size:11px;color:#6b7280;">${esc(p.pageId)}</span></td>
      <td>${fans.length}</td>
      <td>${clicksToday} / ${clicks}</td>
      <td>${sent} ✅ · ${failed} ❌</td>
      <td>${status}<br/>${sendNowBadge}</td>
      <td>
        <div class="actions">
          ${pauseBtn}
          ${sendNowToggle}
          <a href="/send-now?page=${esc(p.pageId)}" class="qbtn qbtn-send" onclick="return confirm('Send broadcast to ${fans.length} fans on ${esc(p.label)} now?')" title="Trigger broadcast to all fans on this page now">🚀 Send Now</a>
          <a href="/?page=${esc(p.pageId)}" class="qbtn qbtn-open" title="Full settings + danger zone">⚙️ Open</a>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<div class="container">
    ${renderAlerts(req)}

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

    <div class="card">
      <h2>📋 Pages</h2>
      ${pages.length === 0
        ? '<p style="color:#6b7280;">No pages yet. Add one below to get started 👇</p>'
        : `
          <div style="margin-bottom:12px;padding:12px;background:#f0fdf4;border:2px solid #86efac;border-radius:8px;">
            <div style="font-size:13px;font-weight:700;color:#166534;margin-bottom:8px;">📣 Send Now to All Pages <span style="font-weight:400;color:#16a34a;">— fires on pages with Send Now ON (${pages.filter(p => p.sendNowEnabled !== false).length} of ${pages.length} eligible)</span></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <form action="/send-now-all" method="POST" style="display:inline;margin:0;">
                <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('SEND NOW to all eligible pages (${pages.filter(p => p.sendNowEnabled !== false).length} pages)?\\n\\nThis broadcasts the CURRENT active card on each page to ALL its fans.\\n\\nPages with Send Now PAUSED are skipped.\\n\\n⚠️ This cannot be stopped once started.')">📣 Send Now to All</button>
              </form>
              <form action="/send-now-all?randomize=1" method="POST" style="display:inline;margin:0;">
                <button type="submit" class="qbtn" style="background:#7c3aed;" onclick="return confirm('RANDOMIZE + SEND to all eligible pages (${pages.filter(p => p.sendNowEnabled !== false).length} pages)?\\n\\nEach page first gets a fresh random photo + a URL from ITS OWN set (Scrollgallery or TheViralBox), then broadcasts to all its fans.\\n\\nPages with Send Now PAUSED are skipped.\\n\\n⚠️ This cannot be stopped once started.')">🎲📣 Randomize + Send All</button>
              </form>
              <span style="color:#cbd5e1;">|</span>
              <form action="/pause-sendnow-all" method="POST" style="display:inline;margin:0;">
                <button type="submit" class="qbtn" style="background:#f59e0b;" onclick="return confirm('Pause Send Now on ALL pages? They will be EXCLUDED from bulk Send Now until resumed.\\n\\n(This does NOT affect the daily 7am auto-broadcast.)')">🚫 Pause Send Now (All)</button>
              </form>
              <form action="/resume-sendnow-all" method="POST" style="display:inline;margin:0;">
                <button type="submit" class="qbtn" style="background:#16a34a;" onclick="return confirm('Resume Send Now on ALL pages?')">✅ Resume Send Now (All)</button>
              </form>
            </div>
          </div>
          <div style="margin-bottom:12px;padding:10px;background:#f7f8fc;border-radius:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:600;color:#4a5568;">Other bulk actions:</span>
            <form action="/pause-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn qbtn-pause" onclick="return confirm('Pause daily auto-broadcast for ALL ${pages.length} pages?')">⏸️ Pause All Pages</button>
            </form>
            <form action="/resume-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn qbtn-resume" onclick="return confirm('Resume daily auto-broadcast for ALL ${pages.length} pages?')">▶️ Resume All Pages</button>
            </form>
            <form action="/disable-cleanup-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#3a8dde;" onclick="return confirm('Set auto-cleanup threshold to 0 (NEVER remove fans) for ALL ${pages.length} pages?\\n\\nFans whose 24h window expired will stay in the list but their sends will keep failing.')">🛡️ Disable Cleanup (All)</button>
            </form>
            <form action="/enable-cleanup-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#28a745;" onclick="return confirm('Set auto-cleanup threshold to 1 (remove fans on 1st failure) for ALL ${pages.length} pages?\\n\\nThis is the default, aggressive cleanup mode.')">🧹 Enable Cleanup (All)</button>
            </form>
            <form action="/randomize-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#8b5cf6;" onclick="return confirm('Randomize photo + redirect URL for ALL ${pages.length} pages?\\n\\nEach page gets a fresh random combo from the shared library, different from its previous pick.')">🎲 Randomize ALL Pages</button>
            </form>
            <form action="/reset-stats-all" method="POST" style="display:inline;margin:0;">
              <button type="submit" class="qbtn" style="background:#dc2626;" onclick="return confirm('Reset ALL stats to 0 on all ${pages.length} pages?\\n\\nThis clears clicks, messages sent/failed, and daily history.\\n\\n✅ Fan counts are KEPT.\\n❌ Stats history is permanently erased.')">🗑️ Reset All Stats (keep fans)</button>
            </form>
            <span style="font-size:11px;color:#6b7280;margin-left:8px;display:block;width:100%;">— useful before deploying code changes</span>
          </div>
          <table>
            <thead><tr><th>Page</th><th>Fans</th><th>Clicks (today / total)</th><th>Messages</th><th>Status</th><th>Quick actions</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
      }
    </div>

    ${renderLibraryManager()}

    <div class="card">
      <h2>➕ Add New Page</h2>
      <p style="color:#6b7280;font-size:13px;">Paste the Page ID and Page Access Token from Facebook Developer. Optional fields below override the defaults for this specific page.</p>

      <div style="background:#eef6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:12px;font-weight:600;color:#0c447c;margin-bottom:8px;">📋 Paste these into Facebook Developer when setting up the webhook:</div>
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
        <div style="font-size:11px;color:#4a5568;margin-top:8px;">Subscribe to: <code style="background:#fff;padding:1px 5px;border-radius:3px;">messages</code>, <code style="background:#fff;padding:1px 5px;border-radius:3px;">messaging_postbacks</code>, <code style="background:#fff;padding:1px 5px;border-radius:3px;">messaging_optins</code>, <code style="background:#fff;padding:1px 5px;border-radius:3px;">message_reads</code>, <code style="background:#fff;padding:1px 5px;border-radius:3px;">message_deliveries</code></div>
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

        <details>
          <summary>Optional: customize this page (otherwise uses defaults)</summary>
          <div class="row">
            <div>
              <label>Card Title</label>
              <input name="title" placeholder="${esc(getDefaults().title)}"/>
            </div>
            <div>
              <label>Card Subtitle</label>
              <input name="subtitle" placeholder="${esc(getDefaults().subtitle)}"/>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Button Text</label>
              <input name="buttonText" placeholder="${esc(getDefaults().buttonText)}"/>
            </div>
            <div>
              <label>WhatsApp / Redirect URL</label>
              <input name="whatsapp" placeholder="${esc(getDefaults().whatsapp)}"/>
            </div>
          </div>
          <label>Photos (one URL per line)</label>
          <textarea name="photos" placeholder="${esc(getDefaults().photos.join('\n'))}"></textarea>
          <div class="row">
            <div>
              <label>Daily Broadcast Time (HH:MM)</label>
              <input name="broadcastTime" placeholder="${esc(getDefaults().broadcastTime)}"/>
            </div>
            <div>
              <label>Timezone</label>
              <input name="timezone" placeholder="${esc(getDefaults().timezone)}"/>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Spacing Between Sends</label>
              ${renderSpacingSelect('spacingSeconds', getDefaults().spacingSeconds)}
              <div class="helper">Higher seconds = safer. Default 10s.</div>
            </div>
            <div>
              <label>Broadcast Enabled by Default?</label>
              <select name="broadcastEnabled">
                <option value="true">Yes — daily auto-send ON</option>
                <option value="false">No — paused</option>
              </select>
            </div>
          </div>
        </details>

        <button type="submit" class="btn btn-green">➕ Add Page</button>
      </form>
    </div>

    <div class="card">
      <h2>ℹ️ Setup Reminder (Facebook side)</h2>
      <p style="font-size:13px;line-height:1.7;">For each new page on the Facebook Developer side:</p>
      <ol style="font-size:13px;line-height:1.7;color:#4a5568;">
        <li>Create a new FB Developer App (or attach the page to an existing one)</li>
        <li>Set Callback URL: <code style="background:#f0f1f5;padding:2px 6px;border-radius:3px;">${esc(PUBLIC_URL || 'https://YOUR-RAILWAY/webhook')}/webhook</code></li>
        <li>Set Verify Token: <code style="background:#f0f1f5;padding:2px 6px;border-radius:3px;">${esc(VERIFY_TOKEN)}</code></li>
        <li>Subscribe to: <code>messages</code>, <code>messaging_postbacks</code>, <code>messaging_optins</code>, <code>message_reads</code>, <code>message_deliveries</code></li>
        <li>Switch app to LIVE mode</li>
        <li>Generate Page Access Token → paste it above ☝️</li>
      </ol>
    </div>
  </div></body></html>`;
}

function renderPageView(page, req) {
  const fans = loadFans(page.pageId);
  const stats = loadStats(page.pageId);
  const todayStr = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];

  const clicks = stats.clicks || [];
  const clicksToday = clicks.filter(c => c.time.startsWith(todayStr)).length;
  const totalClicks = clicks.length;
  const sent = stats.messagesSent || 0;
  const failed = stats.messagesFailed || 0;
  const delivered = (stats.delivered || []).length;
  const seen = (stats.readers || []).length;
  const fansAdded = stats.fansAdded || [];
  const fansToday = fansAdded.filter(f => f.time.startsWith(todayStr)).length;
  const fansThisWeek = fansAdded.filter(f => f.time >= weekAgo).length;
  const newOrganic = fansAdded.length;
  const removedFans = stats.removedFans || [];
  const removedToday = removedFans.filter(r => r.time.startsWith(todayStr)).length;
  const removedTotal = removedFans.length;
  const imported = Math.max(0, fans.length - newOrganic);
  const baseline = page.baselineFans || 0;
  const growth = baseline > 0 ? fans.length - baseline : 0;

  const pct = (n, d) => d > 0 ? Math.round((n/d) * 100) : 0;
  const openRate = pct(seen, delivered);

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
        <button type="button" class="ph-btn ph-copy" onclick="(function(b){var i=document.getElementById('${copyId}');i.select();document.execCommand('copy');var t=b.innerText;b.innerText='✓ Copied';setTimeout(function(){b.innerText=t;},1200);})(this)">📋 Copy URL</button>
        ${isActive
          ? '<span class="badge-current">✓ ACTIVE</span>'
          : `<a href="/set-active-photo?page=${esc(page.pageId)}&index=${i}" class="ph-btn ph-active">★ Set Active</a>`
        }
        ${(page.photos.length > 1) ? `<a href="/remove-photo?page=${esc(page.pageId)}&index=${i}" onclick="return confirm('Remove this photo?')" class="ph-btn ph-remove" title="Remove">× Remove</a>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="container">
    ${renderAlerts(req)}

    <div class="card" style="padding:12px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Page Status</div>
        <div style="font-size:16px;font-weight:700;color:#1a1d2e;margin-top:2px;">
          ${page.broadcastEnabled
            ? '<span style="color:#28a745;">🟢 Active</span> — daily auto-broadcast ON'
            : '<span style="color:#f59e0b;">⏸️ Paused</span> — daily auto-broadcast OFF'}
        </div>
        <div style="font-size:13px;color:#475569;margin-top:4px;">
          ${page.sendNowEnabled !== false
            ? '<span style="color:#16a34a;">✅ Send Now ON</span> — included in bulk "Send Now to All"'
            : '<span style="color:#f59e0b;">🚫 Send Now OFF</span> — skipped by bulk "Send Now to All"'}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <form action="/toggle-page" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${esc(page.pageId)}"/>
          <input type="hidden" name="returnTo" value="page"/>
          ${page.broadcastEnabled
            ? '<button type="submit" class="qbtn qbtn-pause" style="padding:8px 14px;font-size:13px;width:100%;">⏸️ Pause Daily Broadcast</button>'
            : '<button type="submit" class="qbtn qbtn-resume" style="padding:8px 14px;font-size:13px;width:100%;">▶️ Resume Daily Broadcast</button>'
          }
        </form>
        <form action="/toggle-sendnow" method="POST" style="margin:0;">
          <input type="hidden" name="pageId" value="${esc(page.pageId)}"/>
          <input type="hidden" name="returnTo" value="page"/>
          ${page.sendNowEnabled !== false
            ? '<button type="submit" class="qbtn" style="background:#f59e0b;padding:8px 14px;font-size:13px;width:100%;">🚫 Pause Send Now</button>'
            : '<button type="submit" class="qbtn qbtn-resume" style="padding:8px 14px;font-size:13px;width:100%;">✅ Resume Send Now</button>'
          }
        </form>
      </div>
    </div>

    <div class="card" style="border:2px solid #fde68a;">
      <h2>🔑 Page Settings <span style="font-size:12px;font-weight:400;color:#92400e;">— update token or label without losing fans/stats</span></h2>
      <p style="color:#6b7280;font-size:13px;">Use this to fix an expired token (Facebook error code 190) or rename the page. Your fans, stats, photos, and history are all kept.</p>
      <label>Page ID</label>
      <input value="${esc(page.pageId)}" readonly onclick="this.select();" style="font-family:monospace;font-size:12px;width:100%;background:#f8fafc;cursor:pointer;" title="Click to select / copy"/>
      <div class="helper" style="margin:4px 0 12px;">This is fixed — it identifies the Facebook page. Click to copy.</div>
      <form action="/edit-page?page=${esc(page.pageId)}" method="POST">
        <label>Page Access Token</label>
        <input name="accessToken" placeholder="Paste new EAAxxx... token (leave blank to keep current)" style="font-family:monospace;font-size:12px;width:100%;"/>
        <div class="helper" style="margin:4px 0 12px;">Current token: <code style="font-size:11px;">${page.accessToken ? esc(page.accessToken.slice(0, 12)) + '…' + esc(page.accessToken.slice(-6)) : '(none)'}</code></div>
        <label>Page Label / Nickname</label>
        <input name="label" value="${esc(page.label)}" style="width:100%;"/>
        <button type="submit" class="btn btn-green" style="margin-top:12px;">🔑 Update Page Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>📊 ${esc(page.label)} — Stats</h2>
      <div class="grid">
        <div class="stat"><div class="v">${fans.length}</div><div class="l">Active Fans</div></div>
        <div class="stat"><div class="v">${imported}</div><div class="l">Imported (old)</div></div>
        <div class="stat"><div class="v">${newOrganic}</div><div class="l">New (organic)</div></div>
        <div class="stat"><div class="v">${fansToday}</div><div class="l">New Today</div></div>
        <div class="stat"><div class="v">${fansThisWeek}</div><div class="l">New This Week</div></div>
        <div class="stat"><div class="v">${growth >= 0 ? '+' : ''}${growth}</div><div class="l">Growth (baseline ${baseline})</div></div>
      </div>
      <div style="background:#eef6ff;border:1px solid #b5d4f4;border-radius:8px;padding:10px 14px;margin-top:12px;font-size:12px;color:#0c447c;">
        🧹 <strong>Auto-cleanup ${page.cleanupThreshold === 0 ? '<span style="color:#dc3545;">DISABLED</span>' : `threshold = <strong>${page.cleanupThreshold === undefined ? 1 : page.cleanupThreshold}</strong>`}:</strong> ${removedTotal} fan${removedTotal === 1 ? '' : 's'} removed (${removedToday} today). ${(page.cleanupThreshold === undefined || page.cleanupThreshold === 1) ? 'Fan removed on FIRST failed send.' : `Fan removed after ${page.cleanupThreshold} consecutive failed sends.`} Auto-re-added if they message your page back. Change threshold in Schedule below.
      </div>
      <h3>📨 Message Funnel</h3>
      <div class="funnel">
        <div class="step"><div class="v">${fans.length}</div><div class="l">Active Fans</div></div>
        <div class="step"><div class="v">${delivered}</div><div class="l">Delivered</div><div class="pct">${pct(delivered, fans.length)}%</div></div>
        <div class="step"><div class="v">${seen}</div><div class="l">Seen</div><div class="pct">${pct(seen, delivered)}%</div></div>
        <div class="step"><div class="v">${totalClicks}</div><div class="l">Total Clicks</div><div class="pct">${pct(totalClicks, seen)}%</div></div>
        <div class="step"><div class="v">${clicksToday}</div><div class="l">Clicks Today</div></div>
      </div>
      <div class="grid" style="margin-top:14px;">
        <div class="stat"><div class="v">${sent}</div><div class="l">Sent ✅ (all-time)</div></div>
        <div class="stat"><div class="v">${failed}</div><div class="l">Failed ❌ (all-time)</div></div>
        <div class="stat" style="border-left-color:#3a8dde;"><div class="v">${removedTotal}</div><div class="l">🧹 Auto-Removed</div></div>
        <div class="stat"><div class="v">${openRate}%</div><div class="l">Open Rate</div></div>
        <div class="stat"><div class="v">${page.broadcastEnabled ? 'ON' : 'OFF'}</div><div class="l">Daily Broadcast</div></div>
      </div>
    </div>

    <div class="card">
      <h2>📅 Daily Activity</h2>
      ${(() => {
        const daily = getRecentDailyStats(page.pageId, 14);
        const today = daily[0];
        const older = daily.slice(1);
        const maxTotal = Math.max(1, ...daily.map(d => d.sent + d.failed));
        const renderRow = (d, isToday) => {
          const total = d.sent + d.failed;
          const successRate = total > 0 ? Math.round((d.sent / total) * 100) : 0;
          const sentPct = total > 0 ? (d.sent / maxTotal) * 100 : 0;
          const failedPct = total > 0 ? (d.failed / maxTotal) * 100 : 0;
          return `<tr${isToday ? ' style="background:#fffbeb;"' : ''}>
            <td style="font-family:monospace;font-size:12px;">${esc(d.date)}${isToday ? ' <span style="background:#fde68a;color:#92400e;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:4px;">TODAY</span>' : ''}</td>
            <td style="text-align:right;color:#28a745;font-weight:600;">${d.sent}</td>
            <td style="text-align:right;color:#dc3545;font-weight:600;">${d.failed}</td>
            <td style="text-align:right;">${total > 0 ? successRate + '%' : '—'}</td>
            <td style="width:40%;">
              <div style="display:flex;height:14px;background:#f0f1f5;border-radius:3px;overflow:hidden;">
                <div style="width:${sentPct}%;background:#28a745;"></div>
                <div style="width:${failedPct}%;background:#dc3545;"></div>
              </div>
            </td>
          </tr>`;
        };
        return `<table>
          <thead><tr><th>Date</th><th style="text-align:right;">Sent ✅</th><th style="text-align:right;">Failed ❌</th><th style="text-align:right;">Success</th><th>Volume</th></tr></thead>
          <tbody>${renderRow(today, true)}</tbody>
        </table>
        <details style="margin-top:10px;">
          <summary style="cursor:pointer;font-weight:600;color:#3a8dde;font-size:13px;padding:6px 0;">▼ Show last 14 days</summary>
          <table style="margin-top:8px;">
            <tbody>${older.map(d => renderRow(d, false)).join('')}</tbody>
          </table>
          <div class="helper" style="margin-top:6px;">Green bar = sent · Red bar = failed · Width relative to busiest day in 14 days.</div>
        </details>`;
      })()}
    </div>

    <div class="card">
      <h2>✏️ Card / Message Editor</h2>
      <form action="/update-settings?page=${esc(page.pageId)}" method="POST">
        <div class="row">
          <div>
            <label>Card Title</label>
            <input name="title" value="${esc(page.title)}"/>
          </div>
          <div>
            <label>Card Subtitle</label>
            <input name="subtitle" value="${esc(page.subtitle)}"/>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Button Text</label>
            <input name="buttonText" value="${esc(page.buttonText)}"/>
          </div>
          <div>
            <label>WhatsApp / Redirect URL</label>
            <input name="whatsapp" value="${esc(page.whatsapp)}"/>
          </div>
        </div>
        <label>Active Photo URL (the one being sent now)</label>
        <input name="currentPhoto" value="${esc(page.currentPhoto || '')}"/>
        <label>Page Label / Nickname</label>
        <input name="label" value="${esc(page.label)}"/>
        <button type="submit" class="btn btn-green">💾 Save Settings</button>
      </form>
    </div>

    <div class="card">
      <h2>📝 Template Manager — 2 Templates</h2>
      <p style="font-size:12px;color:#6b7280;margin-bottom:14px;">Choose what to broadcast: the photo card (Template 1) OR a plain text message (Template 2). Each has its own Send Now button.</p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">

        <!-- TEMPLATE 1: CARD -->
        <div style="background:#eef6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px;">
          <h3 style="margin:0 0 8px;color:#0c447c;font-size:14px;">🖼️ Template 1: Photo Card</h3>
          <p style="font-size:11px;color:#0c447c;margin:0 0 10px;line-height:1.4;">Sends the card with image + title + subtitle + button (configured in Card / Message Editor above).</p>
          <div style="background:#fff;border-radius:6px;padding:8px;margin-bottom:10px;border:1px solid #d1d5db;">
            <div style="font-size:10px;color:#6b7280;margin-bottom:3px;">Preview:</div>
            <div style="font-size:11px;font-weight:600;color:#1a1d2e;">${esc(page.title || '(no title)')}</div>
            <div style="font-size:10px;color:#4a5568;margin:2px 0;">${esc((page.subtitle || '').slice(0, 50))}${(page.subtitle || '').length > 50 ? '...' : ''}</div>
            <div style="font-size:10px;color:#3a8dde;">+ image + button</div>
          </div>
          <a href="/send-now?page=${esc(page.pageId)}" class="btn btn-green" style="display:block;text-align:center;margin:0;" onclick="return confirm('Send PHOTO CARD to ${fans.length} fans now?')">🚀 Send Card to All</a>
        </div>

        <!-- TEMPLATE 2: PLAIN TEXT -->
        <div style="background:#fef3e7;border:1px solid #fde68a;border-radius:8px;padding:12px;">
          <h3 style="margin:0 0 8px;color:#92400e;font-size:14px;">💬 Template 2: Plain Text</h3>
          <p style="font-size:11px;color:#92400e;margin:0 0 10px;line-height:1.4;">Just a simple text message — no card, no photo, no button. Perfect for questions.</p>
          <form action="/save-text-template?page=${esc(page.pageId)}" method="POST" style="margin:0;">
            <textarea name="textTemplate" placeholder="e.g. Hello! Where are you from? 💕" style="width:100%;min-height:80px;padding:7px 9px;border:1px solid #d1d5db;border-radius:5px;font-size:12px;font-family:inherit;resize:vertical;background:#fff;">${esc(page.textTemplate || '')}</textarea>
            <button type="submit" class="btn" style="background:#92400e;width:100%;margin-top:6px;">💾 Save Text</button>
          </form>
          <form action="/send-text-now?page=${esc(page.pageId)}" method="POST" style="margin:6px 0 0;">
            <button type="submit" class="btn btn-green" style="display:block;text-align:center;margin:0;width:100%;" onclick="return confirm('Send TEXT MESSAGE to ${fans.length} fans now?\\n\\nText: \\&quot;${esc((page.textTemplate || '').replace(/"/g, '\\\\&quot;').slice(0, 80))}\\&quot;\\n\\nSave first if you just edited.')">🚀 Send Text to All</button>
          </form>
        </div>

      </div>
    </div>

    <div class="card">
      <h2>📅 Schedule</h2>
      <form action="/update-schedule?page=${esc(page.pageId)}" method="POST">
        <div class="row">
          <div>
            <label>Daily Broadcast Time (HH:MM)</label>
            <input name="broadcastTime" value="${esc(page.broadcastTime)}"/>
          </div>
          <div>
            <label>Timezone</label>
            <input name="timezone" value="${esc(page.timezone)}"/>
          </div>
        </div>
        <div class="row">
          <div>
            <label>Spacing Between Sends</label>
            ${renderSpacingSelect('spacingSeconds', page.spacingSeconds || 10)}
            <div class="helper">Higher seconds = safer. Default 10s.</div>
          </div>
          <div>
            <label>Daily Auto-Broadcast</label>
            <select name="broadcastEnabled">
              <option value="true" ${page.broadcastEnabled ? 'selected' : ''}>✅ Enabled</option>
              <option value="false" ${!page.broadcastEnabled ? 'selected' : ''}>⏸️ Paused</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div>
            <label>🧹 Auto-Cleanup Threshold</label>
            <select name="cleanupThreshold">
              <option value="0" ${page.cleanupThreshold === 0 ? 'selected' : ''}>0 — Disabled (never remove fans)</option>
              <option value="1" ${(page.cleanupThreshold === undefined || page.cleanupThreshold === 1) ? 'selected' : ''}>1 — Remove on 1st failure (default, fastest cleanup)</option>
              <option value="2" ${page.cleanupThreshold === 2 ? 'selected' : ''}>2 — Remove after 2 consecutive failures</option>
              <option value="3" ${page.cleanupThreshold === 3 ? 'selected' : ''}>3 — Safer (remove after 3 in a row)</option>
              <option value="5" ${page.cleanupThreshold === 5 ? 'selected' : ''}>5 — Very safe (remove after 5 in a row)</option>
              <option value="10" ${page.cleanupThreshold === 10 ? 'selected' : ''}>10 — Almost never remove</option>
            </select>
            <div class="helper">Default 1 = aggressive cleanup, single fail = removed. They get re-added if they message back. Any success resets the counter.</div>
          </div>
          <div></div>
        </div>
        <button type="submit" class="btn btn-green">💾 Save Schedule</button>
      </form>
    </div>

    <div class="card">
      <h2>🖼️ Photos</h2>
      <div class="photo-grid">${photosHtml}</div>
      <form action="/add-photo?page=${esc(page.pageId)}" method="POST" style="margin-top:14px;">
        <label>Add Photo URL</label>
        <input name="photoUrl" placeholder="https://i.imgur.com/..."/>
        <button type="submit" class="btn btn-blue">➕ Add Photo</button>
      </form>
      <div class="helper" style="margin-top:8px;">All cards now use <strong>square (1:1)</strong> photos — bigger card on Messenger. Upload square photos (1:1 ratio) for best results, or Facebook will auto-crop. Green border = currently active. Click any URL field to select it for copy.</div>
    </div>

    ${renderPageLibrarySection(page)}

    <div class="card">
      <h2>📣 Broadcasts</h2>

      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:14px;">
        <h3 style="margin-top:0;color:#92400e;">🧪 Test Send to Specific PSID</h3>
        <p style="font-size:12px;color:#92400e;margin:0 0 8px;">Sends ONE card to a specific PSID (your own, a friend's, etc.) using current page settings. Use this to verify the card looks right BEFORE mass-broadcasting. Does NOT add the PSID to your fan list.</p>
        <form action="/test-send?page=${esc(page.pageId)}" method="POST" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <div style="flex:1;min-width:200px;">
            <label>PSID</label>
            <input name="psid" placeholder="e.g. 1234567890" required/>
          </div>
          <button type="submit" class="btn btn-orange" style="margin-top:0;">🧪 Send Test</button>
        </form>
      </div>

      <p style="font-size:13px;color:#6b7280;">Send to ALL ${fans.length} fans, spaced <strong>${page.spacingSeconds || 10}s</strong> apart (change in Schedule section above). Estimated total time: <strong>~${Math.ceil(fans.length * (page.spacingSeconds || 10) / 60)} min</strong>.</p>
      <a href="/send-now?page=${esc(page.pageId)}" class="btn btn-green" onclick="return confirm('Send to ${fans.length} fans now?')">🚀 Send Now (rotating subtitle)</a>

      <h3>Custom Broadcast</h3>
      <form action="/send-custom?page=${esc(page.pageId)}" method="POST">
        <label>Photo URL (optional — uses current photo if blank)</label>
        <input name="photo" placeholder="${esc(page.currentPhoto || '')}"/>
        <button type="submit" class="btn btn-blue" onclick="return confirm('Send custom broadcast to ${fans.length} fans?')">📤 Send Custom</button>
      </form>

      <h3>Schedule One-Time</h3>
      <form action="/schedule-once?page=${esc(page.pageId)}" method="POST">
        <label>Send at</label>
        <input name="scheduleTime" type="datetime-local"/>
        <button type="submit" class="btn btn-blue">📅 Schedule</button>
      </form>
    </div>

    <div class="card">
      <h2>👥 Fan Management</h2>
      <div class="row">
        <div>
          <h3>Import from Facebook</h3>
          <p style="font-size:13px;color:#6b7280;">Pulls all current Messenger conversations for this page.</p>
          <a href="/import-contacts?page=${esc(page.pageId)}" class="btn btn-blue">📥 Import All Contacts</a>
        </div>
        <div>
          <h3>Export / Backup</h3>
          <p style="font-size:13px;color:#6b7280;">Download all PSIDs as .txt — do this BEFORE redeploy.</p>
          <a href="/export-fans?page=${esc(page.pageId)}" class="btn btn-blue">💾 Export Fan List</a>
        </div>
      </div>

      <h3>Bulk Import (paste or upload)</h3>
      <form action="/bulk-add-fans?page=${esc(page.pageId)}" method="POST">
        <label>Paste PSIDs (one per line, or comma-separated)</label>
        <textarea name="psids" placeholder="1234567890&#10;9876543210"></textarea>
        <button type="submit" class="btn btn-green">📤 Bulk Import</button>
      </form>

      <h3>Manual / Misc</h3>
      <form action="/add-fan?page=${esc(page.pageId)}" method="POST" style="margin-bottom:10px;">
        <label>Add single PSID</label>
        <input name="psid"/>
        <button type="submit" class="btn btn-green">➕ Add Fan</button>
      </form>
      <form action="/set-baseline?page=${esc(page.pageId)}" method="POST" style="margin-bottom:10px;">
        <label>Set Baseline (for growth tracking)</label>
        <input name="value" type="number" value="${page.baselineFans || 0}"/>
        <button type="submit" class="btn btn-orange">📌 Set Baseline</button>
      </form>
      <a href="/clear-fans?page=${esc(page.pageId)}" class="btn btn-red" onclick="return confirm('CLEAR all ${fans.length} fans for this page? Export first!')">🗑️ Clear All Fans</a>
      <form action="/reset-stats?page=${esc(page.pageId)}" method="POST" style="margin-top:10px;">
        <button type="submit" class="btn" style="background:#dc2626;color:#fff;" onclick="return confirm('Reset stats to 0 for ${esc(page.label)}?\\n\\nClears clicks, messages sent/failed, and daily history.\\n\\n✅ Fans KEPT (${fans.length} fans stay).\\n❌ Stats history erased.')">📊 Reset Stats (keep fans)</button>
        <div class="helper" style="margin-top:6px;">Zeroes clicks + messages + daily history. Fan count stays at ${fans.length}.</div>
      </form>
    </div>

    <div class="card danger-zone">
      <h2>⚠️ Danger Zone</h2>
      <p style="font-size:13px;color:#991b1b;">Removing the page deletes it from messagebot — fan list, stats, settings all gone. The Facebook side is NOT touched (you can re-add later). Export fans first if you want a backup.</p>
      <form action="/remove-page" method="POST" style="display:inline;">
        <input type="hidden" name="pageId" value="${esc(page.pageId)}"/>
        <button type="submit" class="btn btn-red" onclick="return confirm('REMOVE page ${esc(page.label)} from messagebot? This deletes fans + stats. The FB page is NOT touched.')">🗑️ Remove This Page from messagebot</button>
      </form>
    </div>
  </div></body></html>`;
}

app.get('/', (req, res) => {
  const pages = loadPages();
  const selectedPageId = req.query.page;
  const showAll = !selectedPageId || selectedPageId === 'all';
  let html = renderHead('messagebot');
  html += renderTopbar(pages, selectedPageId);
  if (showAll) {
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
    broadcastEnabled: b.broadcastEnabled === 'false' ? false : true,
    spacingSeconds: b.spacingSeconds ? parseInt(b.spacingSeconds) : undefined
  };
  const newPage = addPage(data);
  if (!newPage) {
    return res.redirect('/?error=' + encodeURIComponent('Page ID already exists in messagebot'));
  }
  // Try setting up messenger profile (greeting + get_started)
  setupMessenger(newPage);
  res.redirect(`/?page=${encodeURIComponent(newPage.pageId)}&added=1`);
});

app.post('/remove-page', (req, res) => {
  if (req.body.pageId) removePage(req.body.pageId);
  res.redirect('/?removed=1');
});

// Quick pause/resume toggle from the All Pages table
app.post('/toggle-page', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  updatePage(pageId, { broadcastEnabled: !page.broadcastEnabled });
  res.redirect(req.body.returnTo === 'page' ? `/?page=${encodeURIComponent(pageId)}&saved=1` : '/?saved=1');
});

// Toggle the SEND NOW status for a page (controls inclusion in bulk Send Now to All).
// undefined is treated as enabled (true), so existing pages default to enabled.
app.post('/toggle-sendnow', (req, res) => {
  const pageId = req.body.pageId;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const current = page.sendNowEnabled !== false; // undefined => true
  updatePage(pageId, { sendNowEnabled: !current });
  res.redirect(req.body.returnTo === 'page' ? `/?page=${encodeURIComponent(pageId)}&saved=1` : '/?saved=1');
});

// Bulk: SEND NOW to all pages whose Send Now toggle is enabled.
// optional ?randomize=1 → randomize each page first (set-aware)
app.post('/send-now-all', (req, res) => {
  const pages = loadPages();
  const doRandomize = req.query.randomize === '1';
  const eligible = pages.filter(p => p.sendNowEnabled !== false);
  let totalFans = 0;
  const perPage = [];
  eligible.forEach(p => {
    let page = getPage(p.pageId);
    if (doRandomize) page = randomizePage(page, {});
    const count = broadcastToPage(page, doRandomize ? {} : {});
    totalFans += count;
    perPage.push({ label: page.label, count, photo: page.currentPhoto, redirect: page.whatsapp });
  });
  const skipped = pages.length - eligible.length;
  console.log(`📣 Bulk Send Now${doRandomize ? ' (randomized)' : ''}: ${eligible.length} pages, ${totalFans} fans, ${skipped} skipped`);

  const rows = perPage.map(x => `<tr><td>${esc(x.label)}</td><td style="text-align:right;">${x.count}</td><td style="font-size:11px;color:#6b7280;">${esc((x.redirect||'').replace(/^https?:\/\//,''))}</td></tr>`).join('');
  res.send(`${renderHead('Bulk Send')}<div class="container"><div class="card">
    <h2>📣 Bulk Send Now${doRandomize ? ' + Randomize' : ''} Started</h2>
    <p>Broadcasting to <strong>${eligible.length} active pages</strong> · <strong>${totalFans} total fans</strong>.${skipped ? ` <span style="color:#92400e;">${skipped} page(s) skipped (Send Now paused).</span>` : ''}</p>
    <table style="width:100%;margin-top:12px;"><thead><tr><th style="text-align:left;">Page</th><th style="text-align:right;">Fans</th><th style="text-align:left;">Redirect</th></tr></thead><tbody>${rows}</tbody></table>
    <a href="/?page=all" class="btn btn-green" style="margin-top:16px;">← Back to Dashboard</a>
  </div></div></body></html>`);
});

// Bulk: pause Send Now on ALL pages
app.post('/pause-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: false }));
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Send Now PAUSED on all pages — bulk Send Now will skip them'));
});

// Bulk: resume Send Now on ALL pages
app.post('/resume-sendnow-all', (req, res) => {
  loadPages().forEach(p => updatePage(p.pageId, { sendNowEnabled: true }));
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Send Now RESUMED on all pages'));
});

// Bulk: pause daily auto-broadcast on ALL pages
app.post('/pause-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => {
    if (p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled: false });
  });
  res.redirect('/?saved=1');
});

// Bulk: resume daily auto-broadcast on ALL pages
app.post('/resume-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => {
    if (!p.broadcastEnabled) updatePage(p.pageId, { broadcastEnabled: true });
  });
  res.redirect('/?saved=1');
});

// Bulk: disable auto-cleanup on ALL pages (set threshold to 0 = never remove)
app.post('/disable-cleanup-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => {
    updatePage(p.pageId, { cleanupThreshold: 0 });
  });
  console.log(`Bulk: auto-cleanup DISABLED on all ${pages.length} pages`);
  res.redirect('/?saved=1');
});

// Bulk: enable auto-cleanup on ALL pages (set threshold to 1 = aggressive)
app.post('/enable-cleanup-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => {
    updatePage(p.pageId, { cleanupThreshold: 1 });
  });
  console.log(`Bulk: auto-cleanup ENABLED (threshold=1) on all ${pages.length} pages`);
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

// Edit page token + label without losing fans/stats/photos/history.
app.post('/edit-page', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const updates = {};
  // Only update token if a new one was actually pasted (don't wipe on blank)
  if (req.body.accessToken && req.body.accessToken.trim()) {
    updates.accessToken = req.body.accessToken.trim();
  }
  if (req.body.label && req.body.label.trim()) {
    updates.label = req.body.label.trim();
  }
  updatePage(pageId, updates);
  // Re-subscribe messenger profile with the (possibly new) token so the page works immediately
  if (updates.accessToken) {
    try { setupMessenger(getPage(pageId)); } catch {}
  }
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

app.post('/update-schedule', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  const threshold = req.body.cleanupThreshold !== undefined ? parseInt(req.body.cleanupThreshold) : 1;
  updatePage(pageId, {
    broadcastTime: req.body.broadcastTime,
    timezone: req.body.timezone,
    spacingSeconds: parseInt(req.body.spacingSeconds) || 10,
    broadcastEnabled: req.body.broadcastEnabled === 'true',
    cleanupThreshold: isNaN(threshold) ? 1 : threshold
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

// Set the active photo by clicking ★ Set Active under a photo
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
// SHARED LIBRARY MANAGEMENT (from main dashboard)
// ============================================
// Add one or more photo URLs to the shared library
app.post('/library-add-photo', (req, res) => {
  const lib = loadLibrary();
  const raw = req.body.photoUrls || req.body.photoUrl || '';
  const urls = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u => {
    if (!lib.photos.includes(u)) { lib.photos.push(u); added++; }
  });
  saveLibrary(lib);
  res.redirect(`/?page=all&lib_msg=${encodeURIComponent('Added ' + added + ' photo(s) to shared library')}`);
});

// Remove a photo from the shared library
app.get('/library-remove-photo', (req, res) => {
  const lib = loadLibrary();
  const i = parseInt(req.query.index);
  if (i >= 0 && i < lib.photos.length) lib.photos.splice(i, 1);
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('Photo removed from shared library'));
});

// Add one or more redirect URLs to a specific SET
app.post('/library-add-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.body.setName && lib.redirectSets[req.body.setName] ? req.body.setName : DEFAULT_SET;
  const raw = req.body.redirectUrls || req.body.redirectUrl || '';
  const urls = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  urls.forEach(u => {
    if (!lib.redirectSets[setName].includes(u)) { lib.redirectSets[setName].push(u); added++; }
  });
  saveLibrary(lib);
  res.redirect(`/?page=all&lib_msg=${encodeURIComponent('Added ' + added + ' URL(s) to "' + setName + '" set')}`);
});

// Remove a redirect from a specific SET
app.get('/library-remove-redirect', (req, res) => {
  const lib = loadLibrary();
  const setName = req.query.set && lib.redirectSets[req.query.set] ? req.query.set : DEFAULT_SET;
  const i = parseInt(req.query.index);
  if (i >= 0 && i < lib.redirectSets[setName].length) lib.redirectSets[setName].splice(i, 1);
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('URL removed from "' + setName + '" set'));
});

// Assign a page to a redirect SET
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
// SET ACTIVE FROM SHARED LIBRARY (per page)
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
      updates.currentPhoto = photo;
      updates.lastPhoto = photo;
      const photos = Array.isArray(page.photos) ? [...page.photos] : [];
      if (!photos.includes(photo)) photos.unshift(photo);
      updates.photos = photos;
    }
  }
  if (req.query.redirectIndex !== undefined) {
    const setName = pageSet(page, lib);
    const pool = lib.redirectSets[setName] || [];
    const i = parseInt(req.query.redirectIndex);
    if (i >= 0 && i < pool.length) {
      updates.whatsapp = pool[i];
      updates.lastRedirect = pool[i];
    }
  }
  if (Object.keys(updates).length) updatePage(pageId, updates);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// ============================================
// RANDOMIZE
// ============================================
// Randomize ONE page (photo + redirect, or just one via ?only=photo|redirect)
app.post('/randomize-page', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const only = req.query.only;
  const opts = only === 'photo' ? { photo: true, redirect: false }
            : only === 'redirect' ? { photo: false, redirect: true }
            : {};
  randomizePage(page, opts);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// Randomize ONE page then immediately broadcast
app.post('/randomize-and-send', (req, res) => {
  const pageId = req.query.page;
  let page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  page = randomizePage(page, {});
  const count = broadcastToPage(page, {});
  res.send(`${renderHead('Randomize + Send')}<div class="container"><div class="card">
    <h2>🎲 Randomized & Broadcasting — ${esc(page.label)}</h2>
    <p>New random photo + redirect selected, sending to <strong>${count} fans</strong>.</p>
    <div style="background:#f0f6ff;border:1px solid #b5d4f4;border-radius:8px;padding:12px;margin:14px 0;font-size:13px;">
      <div>📸 Photo: <code style="font-size:11px;">${esc(page.currentPhoto || '')}</code></div>
      <div style="margin-top:6px;">🔗 Redirect: <code style="font-size:11px;">${esc(page.whatsapp || '')}</code></div>
    </div>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
  </div></div></body></html>`);
});

// Randomize ALL pages (each gets a fresh, different-from-previous combo)
app.post('/randomize-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => {
    const fresh = getPage(p.pageId);
    if (fresh) randomizePage(fresh, {});
  });
  console.log(`🎲 Randomized all ${pages.length} pages`);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('All ' + pages.length + ' pages randomized with fresh photo + redirect'));
});

// ============================================
// RESET STATS (keeps fans, zeroes clicks/messages/history)
// ============================================
// Reset ONE page's stats
app.post('/reset-stats', (req, res) => {
  const pageId = req.query.page;
  if (!getPage(pageId)) return res.redirect('/?error=Unknown+page');
  resetStats(pageId);
  console.log(`📊 Stats reset for page ${pageId} (fans kept)`);
  res.redirect(`/?page=${encodeURIComponent(pageId)}&saved=1`);
});

// Reset ALL pages' stats
app.post('/reset-stats-all', (req, res) => {
  const pages = loadPages();
  pages.forEach(p => resetStats(p.pageId));
  console.log(`📊 Stats reset for ALL ${pages.length} pages (fans kept)`);
  res.redirect('/?page=all&lib_msg=' + encodeURIComponent('All stats reset to 0 on ' + pages.length + ' pages (fan counts kept)'));
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
    <p>PSIDs found in input: <strong>${psids.length}</strong></p>
    <p>New fans added: <strong>${added}</strong></p>
    <p>Duplicates skipped: <strong>${psids.length - added}</strong></p>
    <p>Total fans now: <strong>${combined.length}</strong></p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
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

app.get('/import-contacts', async (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  try {
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
    res.send(`${renderHead('Import')}<div class="container"><div class="card">
      <h2>✅ Import Complete for ${esc(page.label)}</h2>
      <p>Found: <strong>${all.length}</strong></p>
      <p>Total fans now: <strong>${combined.length}</strong></p>
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

// Test send — send ONE card to a specific PSID for testing. Does not add to fans list.
app.post('/test-send', async (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const psid = (req.body.psid || '').trim();
  if (!/^\d{6,}$/.test(psid)) {
    return res.send(`${renderHead('Test Send')}<div class="container"><div class="card">
      <h2>❌ Invalid PSID</h2>
      <p>PSID must be at least 6 digits, no spaces or letters.</p>
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
    </div></div></body></html>`);
  }
  const result = await sendCard(page, psid, { skipRemoval: true });
  if (result && result.error) {
    const errCode = result.error.code || '?';
    const errMsg = result.error.message || 'Unknown error';
    let hint = '';
    if (errCode === 10 || errMsg.includes('outside of allowed window')) {
      hint = '<p style="color:#92400e;font-size:13px;">💡 This PSID is outside the 24-hour messaging window. The fan needs to message your page first (any message in the last 24 hours).</p>';
    } else if (errCode === 100 || errMsg.includes('No matching user')) {
      hint = '<p style="color:#92400e;font-size:13px;">💡 PSID does not exist or has never interacted with this page. PSIDs are page-specific — a PSID from one page won\'t work for another page.</p>';
    } else if (errCode === 190 || errMsg.includes('access token')) {
      hint = '<p style="color:#92400e;font-size:13px;">💡 Page Access Token issue. Regenerate it on Facebook Developer and update this page in messagebot.</p>';
    }
    return res.send(`${renderHead('Test Send Failed')}<div class="container"><div class="card" style="border:1px solid #fca5a5;background:#fef2f2;">
      <h2 style="color:#991b1b;">❌ Test Send Failed</h2>
      <p><strong>Page:</strong> ${esc(page.label)}</p>
      <p><strong>PSID:</strong> ${esc(psid)}</p>
      <p><strong>Facebook error code:</strong> ${esc(String(errCode))}</p>
      <p><strong>Facebook error message:</strong> ${esc(errMsg)}</p>
      ${hint}
      <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
    </div></div></body></html>`);
  }
  res.send(`${renderHead('Test Send')}<div class="container"><div class="card" style="border:1px solid #86efac;background:#f0fdf4;">
    <h2 style="color:#166534;">✅ Test Card Sent!</h2>
    <p><strong>Page:</strong> ${esc(page.label)}</p>
    <p><strong>PSID:</strong> ${esc(psid)}</p>
    <p><strong>Title:</strong> ${esc(page.title)}</p>
    <p><strong>Subtitle:</strong> ${esc(page.subtitle)}</p>
    <p><strong>Photo:</strong> <a href="${esc(page.currentPhoto)}" target="_blank">${esc(page.currentPhoto)}</a></p>
    <p style="color:#166534;font-size:13px;">👉 Check Messenger now — should arrive in a few seconds. If it doesn't, check the Failed counter on dashboard.</p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
  </div></div></body></html>`);
});

app.get('/send-now', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const count = broadcastToPage(page, { subtitle: getRotatingSubtitle() });
  res.send(`${renderHead('Broadcast')}<div class="container"><div class="card">
    <h2>📣 Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>, spaced ${page.spacingSeconds || 10}s apart.</p>
    <p>Estimated total: <strong>~${Math.ceil(count * (page.spacingSeconds || 10) / 60)} min</strong></p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
  </div></div></body></html>`);
});

app.post('/send-custom', (req, res) => {
  const pageId = req.query.page;
  const page = getPage(pageId);
  if (!page) return res.redirect('/?error=Unknown+page');
  const photo = req.body.photo || undefined;
  const count = broadcastToPage(page, { photo });
  res.send(`${renderHead('Broadcast')}<div class="container"><div class="card">
    <h2>🚀 Custom Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending to <strong>${count} fans</strong>.</p>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back</a>
  </div></div></body></html>`);
});

// ============================================
// TEMPLATE 2: PLAIN TEXT — save + broadcast
// ============================================
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
  if (!text) {
    return res.redirect(`/?page=${encodeURIComponent(pageId)}&error=${encodeURIComponent('No text template saved. Type a message and click Save Text first.')}`);
  }
  const count = broadcastTextToPage(page, text);
  res.send(`${renderHead('Text Broadcast')}<div class="container"><div class="card">
    <h2>💬 Text Broadcast Started for ${esc(page.label)}</h2>
    <p>Sending plain text to <strong>${count} fans</strong>, spaced ${page.spacingSeconds || 10}s apart.</p>
    <p>Estimated total: <strong>~${Math.ceil(count * (page.spacingSeconds || 10) / 60)} min</strong></p>
    <div style="background:#fef3e7;border:1px solid #fde68a;border-radius:8px;padding:12px;margin:14px 0;">
      <div style="font-size:11px;color:#92400e;margin-bottom:4px;">Message being sent:</div>
      <div style="font-size:13px;color:#1a1d2e;white-space:pre-wrap;">${esc(text)}</div>
    </div>
    <a href="/?page=${encodeURIComponent(pageId)}" class="btn btn-green">← Back to Dashboard</a>
  </div></div></body></html>`);
});

const scheduledBroadcasts = {}; // pageId → timeout handle
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
// MASTER CRON — runs every minute, checks all pages
// Fires daily broadcast for any page whose time matches now (in that page's timezone)
// Uses lastBroadcastDate guard to prevent double-firing in a single day
// ============================================
const broadcastGuard = {}; // pageId → 'YYYY-MM-DD' of last fire
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
      console.log(`⏰ [${page.label}] Daily broadcast triggered at ${curH}:${curM} ${page.timezone}`);
      // Auto-randomize photo + redirect from shared library (different from previous day)
      let fresh = page;
      try {
        const lib = loadLibrary();
        if (lib.photos.length || Object.values(lib.redirectSets).some(a => a.length)) {
          fresh = randomizePage(page, {});
          console.log(`🎲 [${page.label}] Auto-randomized → photo=${(fresh.currentPhoto||'').split('/').pop()} redirect=${(fresh.whatsapp||'').replace(/^https?:\/\//,'')}`);
        }
      } catch (e) {
        console.error(`[${page.label}] Auto-randomize failed:`, e.message);
      }
      broadcastToPage(fresh, { subtitle: getRotatingSubtitle() });
    }
  });
});

// ============================================
// HEALTH CHECK (public — for Railway)
// ============================================
// Note: this is BEHIND the auth wall as written above. Most hosts don't need it.
// If Railway insists on an unauthenticated /health, move this block above the auth wall.

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`✅ messagebot running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_URL || '(not set yet — wait for Railway to assign)'}`);
  console.log(`🔒 Admin login: ${ADMIN_USER} / ${ADMIN_PASS === 'changeme' ? '⚠️  CHANGE DEFAULT PASSWORD!' : '(set)'}`);
  const pages = loadPages();
  console.log(`📋 Loaded ${pages.length} page(s):`);
  pages.forEach(p => console.log(`   - ${p.label} (${p.pageId}) — broadcast ${p.broadcastEnabled ? 'ON' : 'OFF'} at ${p.broadcastTime} ${p.timezone}`));
});
