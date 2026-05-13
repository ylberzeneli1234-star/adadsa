const express = require('express');
const cron = require('node-cron');
const fetch = require('node-fetch');
const fs = require('fs');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'abc123';
const PAGE_ID = process.env.PAGE_ID || '';
const PORT = process.env.PORT || 3000;

// Auto-detects Railway URL — no need to hardcode anymore
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : (process.env.PUBLIC_URL || '');

// ============================================
// DATA FUNCTIONS
// ============================================
function loadSettings() {
  try { return JSON.parse(fs.readFileSync('settings.json', 'utf8')); }
  catch {
    return {
      whatsapp: "https://wa.me/1234567890",
      photos: [
        "https://i.imgur.com/photo1.png",
        "https://i.imgur.com/photo2.png",
        "https://i.imgur.com/photo3.png",
        "https://i.imgur.com/photo4.png"
      ],
      title: "Heyy darling 💕",
      subtitle: "I'm on WhatsApp... lets talk",
      message: "Hey gorgeous! 💕 Thinking of you...",
      broadcastTime: "07:30",
      timezone: "UTC",
      broadcastEnabled: true
    };
  }
}

function saveSettings(s) { fs.writeFileSync('settings.json', JSON.stringify(s)); }
function loadFans() { try { return JSON.parse(fs.readFileSync('fans.json', 'utf8')); } catch { return []; } }
function saveFans(f) { fs.writeFileSync('fans.json', JSON.stringify(f)); }
function isFanSaved(psid) { return loadFans().includes(psid); }

function loadStats() {
  try { return JSON.parse(fs.readFileSync('stats.json', 'utf8')); }
  catch { return { clicks: [], messagesSent: 0, messagesFailed: 0, fansAdded: [] }; }
}

function saveStats(s) { fs.writeFileSync('stats.json', JSON.stringify(s)); }

function trackClick(psid) {
  let stats = loadStats();
  stats.clicks.push({ psid, time: new Date().toISOString() });
  saveStats(stats);
}

function trackMessage(success) {
  let stats = loadStats();
  if (success) stats.messagesSent = (stats.messagesSent || 0) + 1;
  else stats.messagesFailed = (stats.messagesFailed || 0) + 1;
  saveStats(stats);
}

function trackFanAdded(psid) {
  let stats = loadStats();
  if (!stats.fansAdded) stats.fansAdded = [];
  stats.fansAdded.push({ psid, time: new Date().toISOString() });
  saveStats(stats);
}

function saveFan(psid) {
  let fans = loadFans();
  if (!fans.includes(psid)) {
    fans.push(psid);
    saveFans(fans);
    trackFanAdded(psid);
    console.log('New fan saved:', psid, '| Total:', fans.length);
  }
}

function getTodaysPhoto() {
  let settings = loadSettings();
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return settings.photos[dayOfYear % settings.photos.length];
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
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return DAILY_MESSAGES[dayOfYear % DAILY_MESSAGES.length];
}

// ============================================
// MESSENGER SETUP
// ============================================
function setupMessenger() {
  fetch(`https://graph.facebook.com/v2.6/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      "get_started": { "payload": "GET_STARTED" },
      "greeting": [{ "locale": "default", "text": `Hey gorgeous! 💕 Tap Get Started to chat with us!` }]
    })
  }).then(r => r.json()).then(data => console.log('Messenger setup:', data));
}

// ============================================
// SEND FUNCTIONS
// ============================================
function sendMessage(psid, text) {
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: psid }, message: { text } })
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) { trackMessage(false); console.log('Failed:', data.error.message); }
    else { trackMessage(true); console.log('Sent to:', psid); }
  })
  .catch(err => { trackMessage(false); console.error('Error:', err); });
}

function sendCard(psid, title, subtitle, photo, whatsapp) {
  // Tracking URL — auto-built from Railway's public domain
  const trackUrl = `${PUBLIC_URL}/track?psid=${psid}`;
  return fetch(`https://graph.facebook.com/v2.6/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [{
              title, subtitle,
              image_url: photo,
              buttons: [{ type: "web_url", url: trackUrl, title: "WHATSAPP 📞" }]
            }]
          }
        }
      }
    })
  }).then(r => r.json()).then(data => console.log('Card sent:', data.message_id || data.error?.message));
}

// ============================================
// CONTROL PANEL
// ============================================
app.get('/', (req, res) => {
  let fans = loadFans();
  let settings = loadSettings();
  let stats = loadStats();
  let today = getTodaysMessage();

  // Stats calculations
  let todayStr = new Date().toISOString().split('T')[0];
  let clicksToday = (stats.clicks || []).filter(c => c.time.startsWith(todayStr)).length;
  let totalClicks = (stats.clicks || []).length;
  let weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
  let fansThisWeek = (stats.fansAdded || []).filter(f => f.time > weekAgo).length;

  // Clicks by day chart data
  let clicksByDay = {};
  (stats.clicks || []).forEach(c => {
    let day = c.time.split('T')[0];
    clicksByDay[day] = (clicksByDay[day] || 0) + 1;
  });
  let clickRows = Object.entries(clicksByDay)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([day, count]) => `<tr><td style="padding:6px 10px;">${day}</td><td style="padding:6px 10px;"><strong>${count}</strong> clicks</td></tr>`)
    .join('');

  // Photo previews
  let photoRows = settings.photos.map((p, i) => `
    <div style="display:inline-block;margin:5px;text-align:center;">
      <img src="${p}" style="width:100px;height:80px;object-fit:cover;border-radius:8px;border:2px solid #ddd;"/>
      <br/><small>Photo ${i+1}</small>
      <br/><a href="/remove-photo?index=${i}" style="color:red;font-size:11px;" onclick="return confirm('Remove photo ${i+1}?')">Remove</a>
    </div>
  `).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bot Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #f0f2f5; padding: 15px; }
        h1 { color: #1a1a2e; margin-bottom: 15px; font-size: 22px; }
        h2 { color: #0f3460; font-size: 15px; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; }
        .card { background: white; border-radius: 12px; padding: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .stat-box { background: #f8f9fa; border-radius: 8px; padding: 12px; text-align: center; }
        .stat-num { font-size: 28px; font-weight: bold; color: #0f3460; }
        .stat-label { font-size: 11px; color: #666; margin-top: 3px; }
        input, textarea, select { width: 100%; padding: 8px 10px; margin: 4px 0 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
        .btn { display: inline-block; padding: 10px 18px; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; text-decoration: none; margin: 4px 2px; }
        .btn-green { background: #28a745; }
        .btn-blue { background: #007bff; }
        .btn-red { background: #dc3545; }
        .btn-orange { background: #fd7e14; }
        .btn-purple { background: #6f42c1; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        tr:nth-child(even) { background: #f8f9fa; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: bold; }
        .badge-green { background: #d4edda; color: #155724; }
        .badge-red { background: #f8d7da; color: #721c24; }
        label { font-size: 12px; font-weight: bold; color: #555; display: block; margin-top: 6px; }
      </style>
    </head>
    <body>
      <h1>🤖 Bot Dashboard</h1>

      <div class="grid">

        <!-- STATS -->
        <div class="card">
          <h2>📊 Stats</h2>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="stat-num">${fans.length}</div>
              <div class="stat-label">Total Fans</div>
            </div>
            <div class="stat-box">
              <div class="stat-num">${clicksToday}</div>
              <div class="stat-label">Clicks Today</div>
            </div>
            <div class="stat-box">
              <div class="stat-num">${totalClicks}</div>
              <div class="stat-label">Total Clicks</div>
            </div>
            <div class="stat-box">
              <div class="stat-num">${fansThisWeek}</div>
              <div class="stat-label">New This Week</div>
            </div>
            <div class="stat-box">
              <div class="stat-num" style="color:#28a745">${stats.messagesSent || 0}</div>
              <div class="stat-label">Messages Sent ✅</div>
            </div>
            <div class="stat-box">
              <div class="stat-num" style="color:#dc3545">${stats.messagesFailed || 0}</div>
              <div class="stat-label">Messages Failed ❌</div>
            </div>
          </div>

          ${clickRows ? `
          <h2 style="margin-top:15px;">📈 Clicks by Day</h2>
          <table>${clickRows}</table>
          ` : '<p style="color:#999;font-size:13px;margin-top:10px;">No clicks yet</p>'}
        </div>

        <!-- MESSAGE EDITOR -->
        <div class="card">
          <h2>✏️ Message Editor</h2>
          <form action="/update-settings" method="POST">
            <label>Text message:</label>
            <input name="message" value="${settings.message}" />
            <label>Card title:</label>
            <input name="title" value="${settings.title}" />
            <label>Card subtitle:</label>
            <input name="subtitle" value="${settings.subtitle}" />
            <label>WhatsApp / Redirect URL:</label>
            <input name="whatsapp" value="${settings.whatsapp}" />
            <button type="submit" class="btn btn-blue">💾 Save Settings</button>
          </form>
        </div>

        <!-- BROADCAST -->
        <div class="card">
          <h2>📣 Broadcast Controls</h2>
          <p style="font-size:13px;margin-bottom:10px;">Send to <strong>${fans.length} fans</strong></p>
          <a href="/send-now" class="btn btn-green">📣 Send Daily Broadcast Now</a>
          <br/><br/>
          <h2>💬 Custom Broadcast</h2>
          <form action="/send-custom" method="POST">
            <label>Custom text message:</label>
            <textarea name="message" rows="3" placeholder="Type your message here...">${settings.message}</textarea>
            <label>Custom photo URL (optional):</label>
            <input name="photo" placeholder="https://i.imgur.com/..." value="${settings.photos[0]}" />
            <button type="submit" class="btn btn-orange" onclick="return confirm('Send this to all ${fans.length} fans?')">🚀 Send Custom Now</button>
          </form>
        </div>

        <!-- SCHEDULE -->
        <div class="card">
          <h2>📅 Schedule Settings</h2>
          <form action="/update-schedule" method="POST">
            <label>Broadcast time (24hr format):</label>
            <input name="broadcastTime" value="${settings.broadcastTime || '07:30'}" placeholder="07:30" />
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
            <label>Send at (date and time):</label>
            <input type="datetime-local" name="scheduleTime" />
            <label>Message:</label>
            <input name="message" placeholder="Your message..." />
            <button type="submit" class="btn btn-purple">📅 Schedule It</button>
          </form>
        </div>

        <!-- PHOTO MANAGER -->
        <div class="card">
          <h2>🖼️ Photo Manager</h2>
          <p style="font-size:13px;margin-bottom:10px;">Rotating ${settings.photos.length} photos — today using Photo ${(Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000) % settings.photos.length) + 1}</p>
          <div>${photoRows}</div>
          <br/>
          <form action="/add-photo" method="POST">
            <label>Add new photo URL:</label>
            <input name="photoUrl" placeholder="https://i.imgur.com/..." />
            <button type="submit" class="btn btn-blue">➕ Add Photo</button>
          </form>
        </div>

        <!-- FAN MANAGER -->
        <div class="card">
          <h2>📋 Fan Manager</h2>
          <p style="font-size:13px;margin-bottom:15px;">Total fans: <strong>${fans.length}</strong></p>
          <a href="/import-contacts" class="btn btn-blue">🔄 Import All Contacts</a>
          <a href="/export-fans" class="btn btn-green">📥 Export Fan List</a>
          <br/><br/>
          <a href="/clear-fans" class="btn btn-red" onclick="return confirm('Are you sure? This deletes ALL ${fans.length} fans!')">🗑️ Clear All Fans</a>
          <br/><br/>
          <form action="/add-fan" method="POST">
            <label>Add fan manually (PSID):</label>
            <input name="psid" placeholder="Fan PSID number..." />
            <button type="submit" class="btn btn-green">➕ Add Fan</button>
          </form>
        </div>

      </div>
    </body>
    </html>
  `);
});

// ============================================
// SETTINGS ROUTES
// ============================================
app.post('/update-settings', (req, res) => {
  let settings = loadSettings();
  settings.message = req.body.message;
  settings.title = req.body.title;
  settings.subtitle = req.body.subtitle;
  settings.whatsapp = req.body.whatsapp;
  saveSettings(settings);
  res.redirect('/?saved=1');
});

app.post('/update-schedule', (req, res) => {
  let settings = loadSettings();
  settings.broadcastTime = req.body.broadcastTime;
  settings.timezone = req.body.timezone;
  settings.broadcastEnabled = req.body.broadcastEnabled === 'true';
  saveSettings(settings);
  startCron(); // restart cron with new schedule
  res.redirect('/?schedule_saved=1');
});

app.post('/add-photo', (req, res) => {
  let settings = loadSettings();
  if (req.body.photoUrl) settings.photos.push(req.body.photoUrl);
  saveSettings(settings);
  res.redirect('/');
});

app.get('/remove-photo', (req, res) => {
  let settings = loadSettings();
  let index = parseInt(req.query.index);
  if (index >= 0 && settings.photos.length > 1) {
    settings.photos.splice(index, 1);
    saveSettings(settings);
  }
  res.redirect('/');
});

// ============================================
// FAN ROUTES
// ============================================
app.get('/clear-fans', (req, res) => {
  saveFans([]);
  res.redirect('/');
});

app.post('/add-fan', (req, res) => {
  if (req.body.psid) saveFan(req.body.psid);
  res.redirect('/');
});

app.get('/export-fans', (req, res) => {
  let fans = loadFans();
  res.setHeader('Content-Type', 'text/plain');
  res.send(fans.join('\n'));
});

// ============================================
// BROADCAST ROUTES
// ============================================
app.get('/send-now', (req, res) => {
  let fans = loadFans();
  let settings = loadSettings();
  let today = getTodaysMessage();
  console.log('📣 Broadcast triggered! Fans:', fans.length);

  fans.forEach((psid, i) => {
    setTimeout(() => {
      sendMessage(psid, today.text);
      setTimeout(() => sendCard(psid, settings.title, today.subtitle, getTodaysPhoto(), settings.whatsapp), 1500);
    }, i * 18000);
  });

  res.send(`
    <h2>📣 Broadcast Started!</h2>
    <p>Sending to <strong>${fans.length} fans</strong></p>
    <p>Rate: 200/hour</p>
    <p>Estimated: <strong>${Math.ceil(fans.length / 200)} hours</strong></p>
    <br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back to Dashboard</a>
  `);
});

app.post('/send-custom', (req, res) => {
  let fans = loadFans();
  let settings = loadSettings();
  let msg = req.body.message;
  let photo = req.body.photo || getTodaysPhoto();
  console.log('📣 Custom broadcast! Message:', msg);

  fans.forEach((psid, i) => {
    setTimeout(() => {
      sendMessage(psid, msg);
      setTimeout(() => sendCard(psid, settings.title, settings.subtitle, photo, settings.whatsapp), 1500);
    }, i * 18000);
  });

  res.send(`
    <h2>🚀 Custom Broadcast Started!</h2>
    <p>Message: <em>${msg}</em></p>
    <p>Sending to <strong>${fans.length} fans</strong></p>
    <br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back to Dashboard</a>
  `);
});

// One-time scheduled broadcast
let scheduledBroadcast = null;
app.post('/schedule-once', (req, res) => {
  let scheduleTime = new Date(req.body.scheduleTime);
  let msg = req.body.message;
  let delay = scheduleTime.getTime() - Date.now();

  if (delay > 0) {
    if (scheduledBroadcast) clearTimeout(scheduledBroadcast);
    scheduledBroadcast = setTimeout(() => {
      let fans = loadFans();
      let settings = loadSettings();
      fans.forEach((psid, i) => {
        setTimeout(() => {
          sendMessage(psid, msg);
          setTimeout(() => sendCard(psid, settings.title, settings.subtitle, getTodaysPhoto(), settings.whatsapp), 1500);
        }, i * 18000);
      });
      console.log('⏰ Scheduled broadcast sent!');
    }, delay);

    res.send(`
      <h2>📅 Broadcast Scheduled!</h2>
      <p>Will send at: <strong>${scheduleTime.toLocaleString()}</strong></p>
      <p>Message: <em>${msg}</em></p>
      <br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back to Dashboard</a>
    `);
  } else {
    res.send(`<h2>❌ Time must be in the future!</h2><a href="/">← Back</a>`);
  }
});

// ============================================
// TRACKING
// ============================================
app.get('/track', (req, res) => {
  let psid = req.query.psid || 'unknown';
  trackClick(psid);
  console.log('Click tracked:', psid);
  res.redirect(loadSettings().whatsapp);
});

// ============================================
// IMPORT CONTACTS
// ============================================
app.get('/import-contacts', async (req, res) => {
  try {
    let allPsids = [];
    let url = `https://graph.facebook.com/v2.6/me/conversations?fields=participants&access_token=${PAGE_ACCESS_TOKEN}`;
    while (url) {
      const data = await fetch(url).then(r => r.json());
      data.data?.forEach(conv => {
        conv.participants?.data?.forEach(p => {
          if (p.id !== PAGE_ID && !allPsids.includes(p.id)) allPsids.push(p.id);
        });
      });
      url = data.paging?.next || null;
    }
    let combined = [...new Set([...loadFans(), ...allPsids])];
    saveFans(combined);
    res.send(`
      <h2>✅ Import Complete!</h2>
      <p>Found: <strong>${allPsids.length}</strong> contacts</p>
      <p>Total saved: <strong>${combined.length}</strong> fans</p>
      <br/><a href="/" style="background:#28a745;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;">← Back to Dashboard</a>
    `);
  } catch (err) {
    res.send(`<h2>❌ Error: ${err.message}</h2><a href="/">← Back</a>`);
  }
});

// ============================================
// WEBHOOK
// ============================================
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.status(200).send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(entry => {
      let event = entry.messaging[0];
      let psid = event.sender.id;
      const isNewFan = !isFanSaved(psid);
      saveFan(psid);

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
    res.status(200).send('EVENT_RECEIVED');
  } else res.sendStatus(404);
});

// ============================================
// DAILY CRON
// ============================================
let cronJob = null;

function startCron() {
  let settings = loadSettings();
  if (cronJob) cronJob.stop();
  if (!settings.broadcastEnabled) {
    console.log('⏸️ Daily broadcast disabled');
    return;
  }
  let [hour, min] = (settings.broadcastTime || '07:30').split(':');

  // Now actually uses the timezone from settings
  cronJob = cron.schedule(`${min} ${hour} * * *`, () => {
    console.log('🔔 Daily broadcast running...');
    let fans = loadFans();
    let today = getTodaysMessage();
    let s = loadSettings();
    fans.forEach((psid, i) => {
      setTimeout(() => {
        sendMessage(psid, today.text);
        setTimeout(() => sendCard(psid, s.title, today.subtitle, getTodaysPhoto(), s.whatsapp), 1500);
      }, i * 18000);
    });
  }, { timezone: settings.timezone || 'UTC' });
  console.log(`✅ Cron set for ${hour}:${min} (${settings.timezone || 'UTC'})`);
}

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Public URL: ${PUBLIC_URL || '(not set yet)'}`);
  setupMessenger();
  startCron();
});
