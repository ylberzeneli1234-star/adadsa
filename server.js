#!/usr/bin/env node
// ============================================
// PATCH: Add Send Mode + Text Pool to messagebot
// Run: node patch-sendmode.js
// Reads: server.js (your current file)
// Writes: server-patched.js (with new features)
// ============================================
const fs = require('fs');

const INPUT = 'server.js';
const OUTPUT = 'server-patched.js';

let code = fs.readFileSync(INPUT, 'utf8');
let applied = 0;

function patch(label, oldStr, newStr) {
  if (!code.includes(oldStr)) {
    console.log(`  ⚠️  SKIP: "${label}" — text not found (maybe already patched?)`);
    return false;
  }
  const count = code.split(oldStr).length - 1;
  if (count > 1) {
    console.log(`  ⚠️  WARN: "${label}" — found ${count} matches, replacing first only`);
  }
  code = code.replace(oldStr, newStr);
  applied++;
  console.log(`  ✅ ${label}`);
  return true;
}

console.log(`\n🔧 Patching ${INPUT}...\n`);

// ─────────────────────────────────────────────
// PATCH 1: Add getGlobalSendMode + pageSendMode after pageContentMode
// ─────────────────────────────────────────────
patch('Add sendMode functions',
  `function pageContentMode(page) {
  if (page && (page.contentMode === 'classic' || page.contentMode === 'templates')) {
    return page.contentMode;
  }
  return getGlobalContentMode();
}`,
  `function pageContentMode(page) {
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
}`
);

// ─────────────────────────────────────────────
// PATCH 2: Add textPool to loadLibrary seed
// ─────────────────────────────────────────────
patch('Add textPool to library seed',
  `      cardTemplates: []
    };`,
  `      cardTemplates: [],
      textPool: []
    };`
);

// ─────────────────────────────────────────────
// PATCH 3: Add textPool to loadLibrary normalization
// ─────────────────────────────────────────────
patch('Add textPool normalization',
  `  const buttonTexts = Array.isArray(lib.buttonTexts) ? lib.buttonTexts : [];
  const normalized = { photos, redirectSets, cardTemplates, titles, subtitles, buttonTexts };`,
  `  const buttonTexts = Array.isArray(lib.buttonTexts) ? lib.buttonTexts : [];
  const textPool = Array.isArray(lib.textPool) ? lib.textPool : [];
  const normalized = { photos, redirectSets, cardTemplates, titles, subtitles, buttonTexts, textPool };`
);

// ─────────────────────────────────────────────
// PATCH 4: Modify broadcastToPage for send modes
// ─────────────────────────────────────────────
patch('Modify broadcastToPage for send modes',
  `function broadcastToPage(page, opts = {}) {
  const fans = loadFans(page.pageId);
  const spacing = (page.spacingSeconds || 10) * 1000;
  startBroadcastTracking(page.pageId, fans.length, 'card');
  fans.forEach((psid, i) => {
    setTimeout(async () => {
      try {
        if (opts.textOnly && opts.text) {
          await sendTextMessage(page, psid, opts.text);
        } else {
          await sendCard(page, psid, opts);
        }
      } catch {}
      tickBroadcast(page.pageId);
    }, i * spacing);
  });
  return fans.length;
}`,
  `function broadcastToPage(page, opts = {}) {
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
}`
);

// ─────────────────────────────────────────────
// PATCH 5: Add Text Pool UI to Shared Library (before closing </details>)
// ─────────────────────────────────────────────
// Find the summary line that shows the library count, and add textPool count
patch('Add text count to library summary',
  `<span style="font-size:12px;color:#94a3b8;margin-left:4px;">\${lib.photos.length} photos · \${Object.values(lib.redirectSets).reduce((a,s)=>a+s.length,0)} redirect URLs</span>`,
  `<span style="font-size:12px;color:#94a3b8;margin-left:4px;">\${lib.photos.length} photos · \${Object.values(lib.redirectSets).reduce((a,s)=>a+s.length,0)} redirect URLs · \${(lib.textPool||[]).length} texts</span>`
);

// Add the text pool section before the closing </div></details></div> of renderLibraryManager
// We'll find the last closing tags of the library manager and insert before them
patch('Add Text Pool section to Shared Library',
  `        </div>
      </details>
    </div>\`;
}

function renderTemplateManager`,
  `          <div style="margin-top:20px;border-top:2px solid #c7d2fe;padding-top:16px;">
            <h3 style="margin:0 0 4px;font-size:14px;">💬 Text Message Pool <span style="font-weight:400;color:#94a3b8;font-size:12px;">— used in Text Only and Card + Text send modes</span></h3>
            <div style="font-size:11px;color:#6b7280;margin-bottom:12px;">Each fan gets a random pick from this pool. One message per line when adding.</div>

            <div style="margin-bottom:12px;">
              \${(lib.textPool||[]).length === 0 ? '<span style="color:#94a3b8;font-size:12px;">No text messages in pool yet — add some below.</span>' :
                (lib.textPool||[]).map((text, i) =>
                  \`<div style="display:flex;align-items:flex-start;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;margin-bottom:6px;">
                    <span style="background:#6366f1;color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;white-space:nowrap;margin-top:2px;">#\${i + 1}</span>
                    <div style="flex:1;font-size:13px;color:#1a1d2e;word-break:break-word;white-space:pre-wrap;">\${esc(text)}</div>
                    <a href="/library-remove-text-pool?index=\${i}" onclick="return confirm('Remove this text?')" style="color:#dc2626;text-decoration:none;font-weight:700;font-size:16px;flex-shrink:0;line-height:1;">×</a>
                  </div>\`
                ).join('')
              }
            </div>

            <form action="/library-add-text-pool" method="POST" style="margin-bottom:10px;">
              <textarea name="texts" placeholder="Paste text messages here — one per line" style="width:100%;min-height:100px;padding:10px;border:1px solid #c7d2fe;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical;"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
                <button type="submit" class="btn btn-green" style="white-space:nowrap;">+ Add Text Messages</button>
                <span style="font-size:12px;color:#6b7280;align-self:center;">Currently: <strong>\${(lib.textPool||[]).length}</strong> messages in pool</span>
              </div>
            </form>

            \${(lib.textPool||[]).length > 0 ? \`
            <form action="/library-clear-text-pool" method="POST" style="margin-top:4px;">
              <button type="submit" class="btn btn-red" style="font-size:12px;" onclick="return confirm('Remove ALL \${(lib.textPool||[]).length} text messages from the pool?')">🗑️ Clear Entire Text Pool (\${(lib.textPool||[]).length})</button>
            </form>\` : ''}
          </div>
        </div>
      </details>
    </div>\`;
}

function renderTemplateManager`
);

// ─────────────────────────────────────────────
// PATCH 6: Add Global Send Mode UI next to Global Content Mode
// ─────────────────────────────────────────────
patch('Add Global Send Mode buttons',
  `            <button type="submit" class="qbtn" style="background:\${globalMode === 'templates' ? '#16a34a' : '#cbd5e1'};color:\${globalMode === 'templates' ? '#fff' : '#475569'};">\${globalMode === 'templates' ? '✓ ' : ''}🎴 Templates</button>
            </form>
          </div>`,
  `            <button type="submit" class="qbtn" style="background:\${globalMode === 'templates' ? '#16a34a' : '#cbd5e1'};color:\${globalMode === 'templates' ? '#fff' : '#475569'};">\${globalMode === 'templates' ? '✓ ' : ''}🎴 Templates</button>
            </form>
          </div>
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px;">
            <span style="font-size:13px;font-weight:700;color:#6b21a8;">📤 Global Send Mode:</span>
            \${['card', 'text', 'card+text'].map(m => {
              const labels = { 'card': '📷 Card Only', 'text': '💬 Text Only', 'card+text': '📷💬 Card + Text' };
              const active = (loadSettings().sendMode || 'card') === m || (!loadSettings().sendMode && m === 'card');
              return \`<form action="/set-global-send-mode" method="POST" style="margin:0;display:inline;">
                <input type="hidden" name="mode" value="\${m}"/>
                <button type="submit" class="qbtn" style="background:\${active ? '#16a34a' : '#cbd5e1'};color:\${active ? '#fff' : '#475569'};">\${active ? '✓ ' : ''}\${labels[m]}</button>
              </form>\`;
            }).join('')}
            \${(loadSettings().sendMode && loadSettings().sendMode !== 'card') ? \`<span style="font-size:11px;color:#7c3aed;">(\${(loadLibrary().textPool || []).length} texts in pool)</span>\` : ''}
          </div>`
);

// ─────────────────────────────────────────────
// PATCH 7: Add new routes before the MASTER CRON section
// ─────────────────────────────────────────────
patch('Add send mode + text pool routes',
  `// ============================================
// MASTER CRON`,
  `// ============================================
// SEND MODE ROUTES
// ============================================
app.post('/set-global-send-mode', (req, res) => {
  const mode = req.body.mode;
  const valid = ['card', 'text', 'card+text'];
  const s = loadSettings();
  s.sendMode = valid.includes(mode) ? mode : 'card';
  saveSettings(s);
  res.redirect('/?page=all&saved=1');
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
  const returnTo = req.body.returnTo === 'page' ? \`/?page=\${encodeURIComponent(pid)}&saved=1\` : '/?saved=1';
  res.redirect(returnTo);
});

// ============================================
// TEXT POOL ROUTES
// ============================================
app.post('/library-add-text-pool', (req, res) => {
  const lib = loadLibrary();
  if (!Array.isArray(lib.textPool)) lib.textPool = [];
  const raw = req.body.texts || '';
  const items = raw.split(/\\n/).map(s => s.trim()).filter(Boolean);
  items.forEach(item => lib.textPool.push(item));
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=Added+' + items.length + '+text+message(s)+to+pool');
});

app.get('/library-remove-text-pool', (req, res) => {
  const lib = loadLibrary();
  const idx = parseInt(req.query.index);
  if (Array.isArray(lib.textPool) && !isNaN(idx) && idx >= 0 && idx < lib.textPool.length) {
    lib.textPool.splice(idx, 1);
  }
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=Text+message+removed+from+pool');
});

app.post('/library-clear-text-pool', (req, res) => {
  const lib = loadLibrary();
  lib.textPool = [];
  saveLibrary(lib);
  res.redirect('/?page=all&lib_msg=Text+pool+cleared');
});

// ============================================
// MASTER CRON`
);

// ─────────────────────────────────────────────
// PATCH 8: Add per-page Send Mode card in page view
// ─────────────────────────────────────────────
patch('Add per-page Send Mode card',
  `    <div class="card" id="broadcast-progress-card"`,
  `    <div class="card" style="border:2px solid #ddd6fe;">
      <h2>📤 Send Mode</h2>
      <p style="color:#6b7280;font-size:13px;">Effective: <strong style="color:#6d28d9;">\${pageSendMode(page) === 'text' ? 'Text Only' : pageSendMode(page) === 'card+text' ? 'Card + Text' : 'Card Only'}</strong> \${page.sendMode ? '<span style="background:#fbbf24;color:#92400e;padding:2px 8px;border-radius:6px;font-size:11px;margin-left:4px;">PAGE OVERRIDE</span>' : '<span style="color:#16a34a;font-size:11px;margin-left:4px;">(using global)</span>'}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        \${['card', 'text', 'card+text'].map(m => {
          const labels = { 'card': '📷 Card Only', 'text': '💬 Text Only', 'card+text': '📷💬 Card + Text' };
          const active = pageSendMode(page) === m;
          return \`<form action="/set-page-send-mode?page=\${pid}" method="POST" style="margin:0;"><input type="hidden" name="returnTo" value="page"/><input type="hidden" name="mode" value="\${m}"/>
            <button type="submit" class="btn" style="background:\${active ? '#16a34a' : '#e2e8f0'};color:\${active ? '#fff' : '#475569'};">\${active ? '✓ ' : ''}\${labels[m]}</button>
          </form>\`;
        }).join('')}
        \${page.sendMode ? \`<form action="/set-page-send-mode?page=\${pid}" method="POST" style="margin:0;"><input type="hidden" name="returnTo" value="page"/><input type="hidden" name="mode" value="global"/>
          <button type="submit" class="btn" style="background:#fbbf24;color:#92400e;">↩ Use Global</button>
        </form>\` : ''}
      </div>
      \${pageSendMode(page) !== 'card' ? \`<div style="font-size:11px;color:#7c3aed;margin-top:8px;">(\${(loadLibrary().textPool || []).length} texts in pool)</div>\` : ''}
    </div>

    <div class="card" id="broadcast-progress-card"`
);

// ─────────────────────────────────────────────
// DONE
// ─────────────────────────────────────────────
fs.writeFileSync(OUTPUT, code);
console.log(`\n✅ Done! ${applied} patches applied.`);
console.log(`📄 Output: ${OUTPUT}`);
console.log(`\n💡 Next steps:`);
console.log(`   1. Review ${OUTPUT}`);
console.log(`   2. Replace your server.js with it`);
console.log(`   3. Deploy to Railway`);
