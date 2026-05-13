const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'abc123';
const PAGE_ID = process.env.PAGE_ID || '1057807767407930';
const PORT = process.env.PORT || 3000;

const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || '');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '.';
const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
const FANS_FILE = `${DATA_DIR}/fans.json`;
const STATS_FILE = `${DATA_DIR}/stats.json`;
console.log(`💾 Data directory: ${DATA_DIR}`);

const STARTED_AT = new Date();

// ============================================
// DEFAULTS — read from env vars (persist across redeploys)
// If env var not set, falls back to hardcoded value
// ============================================
function getDefaults() {
  return {
    whatsapp: process.env.DEFAULT_WHATSAPP || "https://photos.theviralbox.info/archives/1441",
    photos: (process.env.DEFAULT_PHOTOS
      ? process.env.DEFAULT_PHOTOS.split(',').map(s => s.trim()).filter(Boolean)
      : [
          "https://i.imgur.com/2J3Jne9.png",
          "https://i.imgur.com/0gCjxrP.png",
          "https://i.imgur.com/aDQ1ScR.png",
          "https://i.imgur.com/MHT57vc.png"
        ]),
    title: process.env.DEFAULT_TITLE || "Heyy darling 💕",
    subtitle: process.env.DEFAULT_SUBTITLE || "I'm on WhatsApp... lets talk",
    message: process.env.DEFAULT_MESSAGE || "Hey gorgeous! 💕 Thinking of you...",
    buttonText: process.env.DEFAULT_BUTTON_TEXT || "My Photos 📞",
    currentPhoto: process.env.DEFAULT_CURRENT_PHOTO || "https://i.imgur.com/2J3Jne9.png",
    broadcastTime: process.env.DEFAULT_BROADCAST_TIME || "07:30",
    timezone: process.env.DEFAULT_TIMEZONE || "UTC",
    broadcastEnabled: true,
    baselineFans: parseInt(process.env.DEFAULT_BASELINE_FANS) || 0
  };
}

function loadSettings() {
  try {
    let s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const d = getDefaults();
    return { ...d, ...s };
  }
  catch { return getDefaults(); }
}

function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s)); }
function loadFans() { try { return JSON.parse(fs.readFileSync(FANS_FILE, 'utf8')); } catch { return []; } }
function saveFans(f) { fs.writeFileSync(FANS_FILE, JSON.stringify(f)); }
function isFanSaved(psid) { return loadFans().includes(psid); }

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return { clicks: [], messagesSent: 0, messagesFailed: 0, fansAdded: [], reads: [], readers: [], deliveries: [], delivered: [] }; }
}

function saveStats(s) { fs.writeFileSync(STATS_FILE, JSON.stringify(s)); }

function trackClick(psid) { let stats = loadStats(); stats.clicks.push({ psid, time: new Date().toISOString() }); saveStats(stats); }
function trackMessage(success) { let stats = loadStats(); if (success) stats.messagesSent = (stats.messagesSent || 0) + 1; else stats.messagesFailed = (stats.messagesFailed || 0) + 1; saveStats(stats); }
function trackRead(psid, w) { let stats = loadStats(); if (!stats.reads) stats.reads = []; if (!stats.readers) stats.readers = []; stats.reads.push({ psid, watermark: w, time: new Date().toISOString() }); if (!stats.readers.includes(psid)) stats.readers.push(psid); saveStats(stats); }
function trackDelivery(psid, w) { let stats = loadStats(); if (!stats.deliveries) stats.deliveries = []; if (!stats.delivered) stats.delivered = []; stats.deliveries.push({ psid, watermark: w, time: new Date().toISOString() }); if (!stats.delivered.includes(psid)) stats.delivered.push(psid); saveStats(stats); }
function trackFanAdded(psid) { let stats = loadStats(); if (!stats.fansAdded) stats.fansAdded = []; stats.fansAdded.push({ psid, time: new Date().toISOString() }); saveStats(stats); }

function saveFan(psid) {
  let fans = loadFans();
  if (!fans.includes(psid)) {
    fans.push(psid); saveFans(fans); trackFanAdded(psid);
    console.log('New fan saved:', psid, '| Total:', fans.length);
  }
}

function getTodaysPhoto() {
  let s = loadSettings();
  // If user has set a specific photo URL, use it (manual control)
  if (s.currentPhoto) return s.currentPhoto;
  // Otherwise rotate through photo library
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return s.photos[day % s.photos.length];
}

const DAILY_MESSAGES = [
  { text: `Hey gorgeous! 💕 Thinking of you...`, subtitle: `I'm on WhatsApp... lets talk` },
  { text: `Good morning beautiful! 🌸 Miss you...`, subtitle: `Come chat with me 💬` },
  { text: `Hey darling! 💋 How are you today?`, subtitle: `Message me on WhatsApp... I'm waiting 😊` },
  { text: `Hi sweetheart! ❤️ Just thinking of you...`, subtitle: `Let's talk on WhatsApp today 👇` },
  { text: `Good morning! ☀️ You crossed my mind...`, subtitle: `Come find me on WhatsApp 💕` },
  { text: `Hey you! 💕 Don't be a stranger...`, subtitle: `I'm on WhatsApp... come say hi 👋` },
  { text: `Morning gorgeous! 🌺 Hope you're having a great day...`, subtitle: `Let's chat on WhatsApp 💬` },
  { text: `Hey baby! 💕 Just woke up thinking of you...`, subtitle: `Talk to me on WhatsApp 😘` },
  { text: `Good morning! 💋 You make me smile...`, subtitle: `Come chat on WhatsApp today 💕` },
  { text: `Hey handsome! ❤️ Another beautiful day...`, subtitle: `Message me on WhatsApp 👇` },
];

function getTodaysMessage() {
  const day = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return DAILY_MESSAGES[day % DAILY_MESSAGES.length];
}

function setupMessenger() {
  fetch(`https://graph.facebook.com/v2.6/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      "get_started": { "payload": "GET_STARTED" },
      "greeting": [{ "locale": "default", "text": `Hey gorgeous! 💕 Tap Get Started to chat with us!` }]
    })
  }).then(r => r.json()).then(data => console.log('Messenger setup:', data));
}

function sendMessage(psid, text) {
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text } })
  }).then(r => r.json()).then(data => {
    if (data.error) { trackMessage(false); console.log('Failed:', data.error.message); }
    else { trackMessage(true); console.log('Sent to:', psid); }
  }).catch(err => { trackMessage(false); console.error('Error:', err); });
}

function sendCard(psid, title, subtitle, photo, whatsapp) {
  const buttonText = loadSettings().buttonText;
  const trackUrl = `${PUBLIC_URL}/track?psid=${psid}`;
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { attachment: { type: "template", payload: { template_type: "generic", elements: [{ title, subtitle, image_url: photo, default_action: { type: "web_url", url: trackUrl, webview_height_ratio: "tall" }, buttons: [{ type: "web_url", url: trackUrl, title: buttonText }] }] } } }
    })
  }).then(r => r.json()).then(data => console.log('Card sent:', data.message_id || data.error?.message));
}

function uptimeText() {
  const ms = Date.now() - STARTED_AT.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

app.get('/', (req, res) => {
  let fans = loadFans(); let settings = loadSettings(); let stats = loadStats();
  let todayStr = new Date().toISOString().split('T')[0];
  let clicksToday = (stats.clicks || []).filter(c => c.time.startsWith(todayStr)).length;
  let totalClicks = (stats.clicks || []).length;
  let weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
  let fansThisWeek = (stats.fansAdded || []).filter(f => f.time > weekAgo).length;
  let baseline = settings.baselineFans || 0;
  let growth = Math.max(fans.length - baseline, 0);
  let growthPct = baseline > 0 ? Math.round((growth / baseline) * 100) : 0;
  let uniqueReaders = (stats.readers || []).length;
  let totalOpens = (stats.reads || []).length;
  let opensToday = (stats.reads || []).filter(r => r.time.startsWith(todayStr)).length;
  let uniqueDelivered = (stats.delivered || []).length;
  let totalDeliveries = (stats.deliveries || []).length;
  let deliveryRate = fans.length > 0 ? Math.round((uniqueDelivered / fans.length) * 100) : 0;
  let openRate = uniqueDelivered > 0 ? Math.round((uniqueReaders / uniqueDelivered) * 100) : 0;
  let clickRate = uniqueReaders > 0 ? Math.round((totalClicks / uniqueReaders) * 100) : 0;

  let clicksByDay = {};
  (stats.clicks || []).forEach(c => { let day = c.time.split('T')[0]; clicksByDay[day] = (clicksByDay[day] || 0) + 1; });
  let clickRows = Object.entries(clicksByDay).sort((a,b) => b[0].localeCompare(a[0])).slice(0, 7)
    .map(([day, count]) => `<tr><td style="padding:6px 10px;">${day}</td><td style="padding:6px 10px;"><strong>${count}</strong> clicks</td></tr>`).join('');

  let photoRows = settings.photos.map((p, i) => `
    <div style="display:flex;align-items:center;gap:10px;margin:8px 0;padding:8px;background:#f8f9fa;border-radius:8px;">
      <img src="${p}" style="width:70px;height:55px;object-fit:cover;border-radius:6px;border:2px solid #ddd;flex-shrink:0;"/>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:#666;margin-bottom:3px;"><strong>Photo ${i+1}</strong></div>
        <input type="text" readonly value="${p}" onclick="this.select()" style="width:100%;font-size:10px;padding:4px 6px;border:1px solid #ddd;border-radius:4px;background:white;" />
      </div>
      <button onclick="navigator.clipboard.writeText('${p}');this.textContent='✅ Copied!';setTimeout(()=>this.textContent='📋 Copy',1500);return false;" style="background:#007bff;color:white;border:none;padding:6px 10px;border-radius:6px;font-size:11px;cursor:pointer;white-space:nowrap;">📋 Copy</button>
      <a href="/remove-photo?index=${i}" onclick="return confirm('Remove photo ${i+1}?')" style="color:red;font-size:11px;text-decoration:none;white-space:nowrap;">🗑️</a>
    </div>
  `).join('');

  const storageBadge = DATA_DIR === '/data'
    ? '<span style="background:#d4edda;color:#155724;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:bold;">💾 Persistent storage ON</span>'
    : '<span style="background:#fff3cd;color:#856404;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:bold;">💡 Defaults from env vars</span>';

  res.send(`<!DOCTYPE html><html><head><title>Bot Dashboard</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; background: #f0f2f5; padding: 15px; }
h1 { color: #1a1a2e; margin-bottom: 15px; font-size: 22px; }
h2 { color: #0f3460; font-size: 15px; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; }
.card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
.stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stat-box { background: #f8f9fa; border-radius: 8px; padding: 12px; text-align: center; }
.stat-num { font-size: 26px; font-weight: bold; color: #0f3460; }
.stat-label { font-size: 11px; color: #666; margin-top: 3px; }
input, textarea, select { width: 100%; padding: 8px 10px; margin: 4px 0 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
.btn { display: inline-block; padding: 10px 18px; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; text-decoration: none; margin: 4px 2px; }
.btn-green { background: #28a745; } .btn-blue { background: #007bff; } .btn-red { background: #dc3545; } .btn-orange { background: #fd7e14; } .btn-purple { background: #6f42c1; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
tr:nth-child(even) { background: #f8f9fa; }
label { font-size: 12px; font-weight: bold; color: #555; display: block; margin-top: 6px; }
.hint { font-size: 11px; color: #888; margin-top: -6px; margin-bottom: 6px; }
.funnel { background: linear-gradient(to right, #007bff, #6f42c1); color: white; padding: 12px; border-radius: 8px; margin-top: 10px; font-size: 13px; }
.funnel-step { display: inline-block; margin-right: 8px; }
.funnel-arrow { color: rgba(255,255,255,0.6); margin-right: 4px; }
.status-banner { background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 18px 22px; border-radius: 12px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; box-shadow: 0 4px 12px rgba(40, 167, 69, 0.25); }
.status-left { display: flex; align-items: center; gap: 14px; }
.status-pulse { width: 12px; height: 12px; border-radius: 50%; background: white; box-shadow: 0 0 0 0 rgba(255,255,255,0.8); animation: pulse 1.6s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); } 70% { box-shadow: 0 0 0 14px rgba(255,255,255,0); } 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); } }
.status-title { font-size: 18px; font-weight: bold; }
.status-sub { font-size: 12px; opacity: 0.9; margin-top: 2px; }
.status-fans { text-align: right; }
.status-fans-num { font-size: 32px; font-weight: bold; line-height: 1; }
.status-fans-label { font-size: 11px; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px; }
.growth-card { background: #fff8e1; border: 1px solid #ffe082; border-radius: 8px; padding: 12px; margin-top: 10px; font-size: 13px; }
.growth-card strong { color: #f57c00; }
</style></head><body>
<h1 style="margin-bottom:10px;">🤖 Bot Dashboard</h1>
<div class="status-banner">
  <div class="status-left">
    <div class="status-pulse"></div>
    <div><div class="status-title">✅ Bot is running!</div><div class="status-sub">Uptime: ${uptimeText()} · ${storageBadge}</div></div>
  </div>
  <div class="status-fans"><div class="status-fans-num">${fans.length.toLocaleString()}</div><div class="status-fans-label">Total fans saved</div></div>
</div>
<div class="grid">
  <div class="card">
    <h2>📊 Stats</h2>
    <div class="funnel"><strong>📈 Funnel</strong><br>
      <span class="funnel-step">👥 ${fans.length}</span> <span class="funnel-arrow">→</span>
      <span class="funnel-step">✉️ ${uniqueDelivered} (${deliveryRate}%)</span> <span class="funnel-arrow">→</span>
      <span class="funnel-step">👁️ ${uniqueReaders} (${openRate}%)</span> <span class="funnel-arrow">→</span>
      <span class="funnel-step">🖱️ ${totalClicks} (${clickRate}%)</span>
    </div>
    ${baseline > 0 ? `<div class="growth-card"><strong>📈 Growth since baseline:</strong><br>Started with: <strong>${baseline.toLocaleString()}</strong> fans<br>Gained: <strong style="color:#28a745">+${growth.toLocaleString()}</strong> (${growthPct}% growth)<br>Current: <strong>${fans.length.toLocaleString()}</strong></div>` : ''}
    <div class="stat-grid" style="margin-top:12px;">
      <div class="stat-box"><div class="stat-num">${fans.length}</div><div class="stat-label">Total Fans 👥</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#007bff">${uniqueDelivered}</div><div class="stat-label">Delivered ✉️</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#6f42c1">${uniqueReaders}</div><div class="stat-label">Seen 👁️</div></div>
      <div class="stat-box"><div class="stat-num">${opensToday}</div><div class="stat-label">Opens Today</div></div>
      <div class="stat-box"><div class="stat-num">${totalOpens}</div><div class="stat-label">Total Opens 📖</div></div>
      <div class="stat-box"><div class="stat-num">${totalDeliveries}</div><div class="stat-label">Total Deliveries</div></div>
      <div class="stat-box"><div class="stat-num">${clicksToday}</div><div class="stat-label">Clicks Today</div></div>
      <div class="stat-box"><div class="stat-num">${totalClicks}</div><div class="stat-label">Total Clicks 🖱️</div></div>
      <div class="stat-box"><div class="stat-num">${fansThisWeek}</div><div class="stat-label">New This Week</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#fd7e14">${openRate}%</div><div class="stat-label">Open Rate</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#28a745">${stats.messagesSent || 0}</div><div class="stat-label">Sent ✅</div></div>
      <div class="stat-box"><div class="stat-num" style="color:#dc3545">${stats.messagesFailed || 0}</div><div class="stat-label">Failed ❌</div></div>
    </div>
    ${clickRows ? `<h2 style="margin-top:15px;">📈 Clicks by Day</h2><table>${clickRows}</table>` : '<p style="color:#999;font-size:13px;margin-top:10px;">No clicks yet</p>'}
  </div>
  <div class="card">
    <h2>✏️ Message Editor</h2>
    <form action="/update-settings" method="POST">
      <label>Text message:</label><input name="message" value="${settings.message}" />
      <label>Card title:</label><input name="title" value="${settings.title}" />
      <label>Card subtitle:</label><input name="subtitle" value="${settings.subtitle}" />
      <label>Button text:</label><input name="buttonText" value="${settings.buttonText}" maxlength="20" />
      <div class="hint">Max 20 chars. Examples: "Call Me 📞", "💕 Chat Now"</div>
      <label>📷 Photo URL (what fans see):</label>
      <input name="currentPhoto" value="${settings.currentPhoto || settings.photos[0]}" placeholder="https://i.imgur.com/..." />
      <div class="hint">Copy a URL from Photo Manager ↓ and paste it here</div>
      <label>WhatsApp / Redirect URL:</label><input name="whatsapp" value="${settings.whatsapp}" />
      <button type="submit" class="btn btn-blue">💾 Save Settings</button>
    </form>
  </div>
  <div class="card">
    <h2>📣 Broadcast Controls</h2>
    <p style="font-size:13px;margin-bottom:10px;">Send to <strong>${fans.length} fans</strong></p>
    <a href="/send-now" class="btn btn-green">📣 Send Daily Broadcast Now</a>
    <br/><br/>
    <h2>💬 Custom Broadcast</h2>
    <form action="/send-custom" method="POST">
      <label>Custom text message:</label><textarea name="message" rows="3">${settings.message}</textarea>
      <label>Custom photo URL (optional):</label><input name="photo" value="${settings.photos[0]}" />
      <button type="submit" class="btn btn-orange" onclick="return confirm('Send to all ${fans.length} fans?')">🚀 Send Custom Now</button>
    </form>
  </div>
  <div class="card">
    <h2>📅 Schedule Settings</h2>
    <form action="/update-schedule" method="POST">
      <label>Broadcast time (24hr format):</label><input name="broadcastTime" value="${settings.broadcastTime}" />
      <label>Timezone:</label>
      <select name="timezone">
        <option value="UTC" ${settings.timezone === 'UTC' ? 'selected' : ''}>UTC</option>
        <option value="America/New_York" ${settings.timezone === 'America/New_York' ? 'selected' : ''}>New York (EST)</option>
        <option value="America/Los_Angeles" ${settings.timezone === 'America/Los_Angeles' ? 'selected' : ''}>Los Angeles (PST)</option>
        <option value="Europe/London" ${settings.timezone === 'Europe/London' ? 'selected' : ''}>London (GMT)</option>
        <option value="Europe/Tirane" ${settings.timezone === 'Europe/Tirane' ? 'selected' : ''}>Albania (CET)</option>
        <option value="Asia/Dubai" ${settings.timezone === 'Asia/Dubai' ? 'selected' : ''}>Dubai (GST)</option>
      </select>
      <label>Daily broadcast:</label>
      <select name="broadcastEnabled">
        <option value="true" ${settings.broadcastEnabled !== false ? 'selected' : ''}>✅ Enabled</option>
        <option value="false" ${settings.broadcastEnabled === false ? 'selected' : ''}>❌ Disabled</option>
      </select>
      <button type="submit" class="btn btn-purple">⏰ Save Schedule</button>
    </form>
    <br/>
    <h2>⏰ One-Time Broadcast</h2>
    <form action="/schedule-once" method="POST">
      <label>Send at (date and time):</label><input type="datetime-local" name="scheduleTime" />
      <label>Message:</label><input name="message" placeholder="Your message..." />
      <button type="submit" class="btn btn-purple">📅 Schedule It</button>
    </form>
  </div>
  <div class="card">
    <h2>🖼️ Photo Manager</h2>
    <p style="font-size:13px;margin-bottom:10px;">Rotating ${settings.photos.length} photos — today using Photo ${(Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000) % settings.photos.length) + 1}</p>
    <div>${photoRows}</div><br/>
    <form action="/add-photo" method="POST">
      <label>Add new photo URL:</label><input name="photoUrl" />
      <button type="submit" class="btn btn-blue">➕ Add Photo</button>
    </form>
  </div>
  <div class="card">
    <h2>📋 Fan Manager</h2>
    <p style="font-size:13px;margin-bottom:8px;">Total fans: <strong>${fans.length}</strong></p>
    ${baseline > 0 ? `<p style="font-size:13px;margin-bottom:15px;color:#28a745;">📈 +${growth.toLocaleString()} new since baseline of ${baseline.toLocaleString()}</p>` : '<p style="font-size:13px;margin-bottom:15px;color:#888;">No baseline set yet</p>'}
    <a href="/import-contacts" class="btn btn-blue">🔄 Import All Contacts</a>
    <a href="/export-fans" class="btn btn-green">📥 Export Fan List</a>
    <br/><br/>
    <div style="background:#fff8e1;padding:12px;border-radius:8px;border:1px solid #ffe082;">
      <strong style="font-size:13px;color:#f57c00;">📌 Baseline (track growth)</strong>
      <p style="font-size:11px;color:#666;margin:4px 0 8px;">Current baseline: <strong>${baseline.toLocaleString()}</strong> fans</p>
      <form action="/set-baseline" method="POST" style="display:inline;">
        <input type="hidden" name="value" value="${fans.length}">
        <button type="submit" class="btn btn-orange" onclick="return confirm('Set baseline to ${fans.length}?')">📌 Snapshot now</button>
      </form>
      <form action="/set-baseline" method="POST" style="display:inline;">
        <input type="hidden" name="value" value="0">
        <button type="submit" class="btn btn-red" onclick="return confirm('Reset to 0?')">🔄 Reset</button>
      </form>
      <form action="/set-baseline" method="POST" style="margin-top:8px;">
        <label style="font-size:11px;">Custom number:</label>
        <input name="value" type="number" placeholder="200" style="width:120px;display:inline-block;">
        <button type="submit" class="btn btn-blue">💾 Save</button>
      </form>
    </div>
    <br/>
    <a href="/clear-fans" class="btn btn-red" onclick="return confirm('Delete ALL ${fans.length} fans?')">🗑️ Clear All Fans</a>
    <br/><br/>
    <form action="/add-fan" method="POST">
      <label>Add fan manually (PSID):</label><input name="psid" />
      <button type="submit" class="btn btn-green">➕ Add Fan</button>
    </form>
  </div>
</div></body></html>`);
});

app.post('/update-settings', (req, res) => {
  let s = loadSettings();
  s.message = req.body.message; s.title = req.body.title; s.subtitle = req.body.subtitle;
  s.buttonText = req.body.buttonText || getDefaults().buttonText; s.whatsapp = req.body.whatsapp;
  s.currentPhoto = req.body.currentPhoto || s.photos[0];
  saveSettings(s); res.redirect('/?saved=1');
});
app.post('/update-schedule', (req, res) => {
  let s = loadSettings();
  s.broadcastTime = req.body.broadcastTime; s.timezone = req.body.timezone;
  s.broadcastEnabled = req.body.broadcastEnabled === 'true';
  saveSettings(s); startCron(); res.redirect('/?schedule_saved=1');
});
app.post('/set-baseline', (req, res) => {
  let s = loadSettings(); s.baselineFans = parseInt(req.body.value) || 0; saveSettings(s); res.redirect('/');
});
app.post('/add-photo', (req, res) => {
  let s = loadSettings(); if (req.body.photoUrl) s.photos.push(req.body.photoUrl); saveSettings(s); res.redirect('/');
});
app.get('/remove-photo', (req, res) => {
  let s = loadSettings(); let i = parseInt(req.query.index);
  if (i >= 0 && s.photos.length > 1) { s.photos.splice(i, 1); saveSettings(s); }
  res.redirect('/');
});
app.get('/clear-fans', (req, res) => { saveFans([]); res.redirect('/'); });
app.post('/add-fan', (req, res) => { if (req.body.psid) saveFan(req.body.psid); res.redirect('/'); });
app.get('/export-fans', (req, res) => { res.setHeader('Content-Type', 'text/plain'); res.send(loadFans().join('\n')); });

app.get('/send-now', (req, res) => {
  let fans = loadFans(); let s = loadSettings(); let today = getTodaysMessage();
  fans.forEach((psid, i) => {
    setTimeout(() => {
      sendMessage(psid, today.text);
      setTimeout(() => sendCard(psid, s.title, today.subtitle, getTodaysPhoto(), s.whatsapp), 1500);
    }, i * 18000);
  });
  res.send(`<h2>📣 Broadcast Started!</h2><p>Sending to <strong>${fans.length} fans</strong></p><br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back</a>`);
});

app.post('/send-custom', (req, res) => {
  let fans = loadFans(); let s = loadSettings(); let msg = req.body.message; let photo = req.body.photo || getTodaysPhoto();
  fans.forEach((psid, i) => {
    setTimeout(() => {
      sendMessage(psid, msg);
      setTimeout(() => sendCard(psid, s.title, s.subtitle, photo, s.whatsapp), 1500);
    }, i * 18000);
  });
  res.send(`<h2>🚀 Sent!</h2><p>To <strong>${fans.length} fans</strong></p><br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back</a>`);
});

let scheduledBroadcast = null;
app.post('/schedule-once', (req, res) => {
  let t = new Date(req.body.scheduleTime); let msg = req.body.message; let delay = t.getTime() - Date.now();
  if (delay > 0) {
    if (scheduledBroadcast) clearTimeout(scheduledBroadcast);
    scheduledBroadcast = setTimeout(() => {
      let fans = loadFans(); let s = loadSettings();
      fans.forEach((psid, i) => {
        setTimeout(() => {
          sendMessage(psid, msg);
          setTimeout(() => sendCard(psid, s.title, s.subtitle, getTodaysPhoto(), s.whatsapp), 1500);
        }, i * 18000);
      });
    }, delay);
    res.send(`<h2>📅 Scheduled!</h2><p>Will send at: <strong>${t.toLocaleString()}</strong></p><br/><a href="/">← Back</a>`);
  } else { res.send(`<h2>❌ Time must be future!</h2><a href="/">← Back</a>`); }
});

app.get('/track', (req, res) => { trackClick(req.query.psid || 'unknown'); res.redirect(loadSettings().whatsapp); });

app.get('/import-contacts', async (req, res) => {
  try {
    let all = [];
    let url = `https://graph.facebook.com/v2.6/me/conversations?fields=participants&access_token=${PAGE_ACCESS_TOKEN}`;
    while (url) {
      const d = await fetch(url).then(r => r.json());
      d.data?.forEach(c => c.participants?.data?.forEach(p => { if (p.id !== PAGE_ID && !all.includes(p.id)) all.push(p.id); }));
      url = d.paging?.next || null;
    }
    let combined = [...new Set([...loadFans(), ...all])];
    saveFans(combined);
    let s = loadSettings();
    if (!s.baselineFans || s.baselineFans === 0) { s.baselineFans = combined.length; saveSettings(s); }
    res.send(`<h2>✅ Import Complete!</h2><p>Found: <strong>${all.length}</strong></p><p>Total: <strong>${combined.length}</strong></p><br/><a href="/">← Back</a>`);
  } catch (e) { res.send(`<h2>❌ ${e.message}</h2><a href="/">← Back</a>`); }
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (req.body.object === 'page') {
    req.body.entry.forEach(entry => {
      (entry.messaging || []).forEach(event => {
        let psid = event.sender?.id; if (!psid) return;
        if (event.read) { trackRead(psid, event.read.watermark); return; }
        if (event.delivery) { trackDelivery(psid, event.delivery.watermark); return; }
        const isNewFan = !isFanSaved(psid); saveFan(psid);
        if (event.postback?.payload === 'GET_STARTED') {
          let s = loadSettings();
          sendMessage(psid, `Hey gorgeous! 💕 So happy you're here!`);
          setTimeout(() => sendCard(psid, s.title, s.subtitle, getTodaysPhoto(), s.whatsapp), 1000);
        } else if (event.message && isNewFan) {
          let s = loadSettings();
          sendMessage(psid, `Hey beautiful! 💕 Message me on WhatsApp 👇`);
          setTimeout(() => sendCard(psid, s.title, s.subtitle, getTodaysPhoto(), s.whatsapp), 1000);
        }
      });
    });
    res.status(200).send('EVENT_RECEIVED');
  } else res.sendStatus(404);
});

let cronJob = null;
function startCron() {
  let s = loadSettings(); if (cronJob) cronJob.stop();
  if (!s.broadcastEnabled) return;
  let [hour, min] = (s.broadcastTime || '07:30').split(':');
  cronJob = cron.schedule(`${min} ${hour} * * *`, () => {
    let fans = loadFans(); let today = getTodaysMessage(); let s2 = loadSettings();
    fans.forEach((psid, i) => {
      setTimeout(() => {
        sendMessage(psid, today.text);
        setTimeout(() => sendCard(psid, s2.title, today.subtitle, getTodaysPhoto(), s2.whatsapp), 1500);
      }, i * 18000);
    });
  }, { timezone: s.timezone || 'UTC' });
  console.log(`✅ Cron set for ${hour}:${min} (${s.timezone || 'UTC'})`);
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_URL || '(not set yet)'}`);
  setupMessenger(); startCron();
});
