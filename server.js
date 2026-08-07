// ============================================
// MESSAGEBOT — IMPORT CONTACTS FIX
// ============================================
// 
// YOUR PROBLEM: Facebook's /me/conversations endpoint returns max 500
// results per request. Your code never follows the paging.next cursor,
// so you only get the first page of results (~500 fans).
//
// THE FIX: Follow paging.next in a loop until all conversations are fetched.
//
// HOW TO APPLY:
// 1. Find the comment "// FAN MANAGEMENT" section in your messagebot.js
// 2. Add the importAllConversations() helper function BEFORE the /import-contacts route
// 3. Replace the /import-contacts route
// 4. Replace the /import-contacts-batch route
//
// Below are the three blocks. Search for the markers to find where to paste.
// ============================================


// ──────────────────────────────────────────────
// STEP 1: ADD THIS HELPER — paste ABOVE the line:
//   app.post('/import-contacts', ...
// ──────────────────────────────────────────────

async function importAllConversations(page) {
  let url = `https://graph.facebook.com/v17.0/me/conversations?fields=participants&access_token=${page.accessToken}&limit=500`;
  let count = 0;
  let pageNum = 0;
  const MAX_PAGES = 100; // safety limit to avoid infinite loops

  while (url && pageNum < MAX_PAGES) {
    pageNum++;
    try {
      const r = await fetch(url);
      const data = await r.json();

      if (data.error) {
        console.error(`[${page.label}] Import page ${pageNum} error:`, data.error.message);
        break;
      }

      const convos = data.data || [];
      if (convos.length === 0) break;

      convos.forEach(conv => {
        (conv.participants?.data || []).forEach(p => {
          if (p.id !== page.pageId && !isFanSaved(page.pageId, p.id)) {
            saveFan(page.pageId, p.id);
            count++;
          }
        });
      });

      // Follow the next page cursor
      url = data.paging?.next || null;
      console.log(`[${page.label}] Import page ${pageNum}: +${convos.length} convos, ${count} new fans so far`);

    } catch (e) {
      console.error(`[${page.label}] Import page ${pageNum} fetch error:`, e.message);
      break;
    }
  }

  if (pageNum >= MAX_PAGES) {
    console.warn(`[${page.label}] Import hit safety limit of ${MAX_PAGES} pages — ${count} fans imported`);
  }

  console.log(`[${page.label}] Import complete: ${count} new fans from ${pageNum} API pages`);
  return count;
}


// ──────────────────────────────────────────────
// STEP 2: REPLACE the /import-contacts route.
//
// DELETE this old block:
//
//   app.post('/import-contacts', (req, res) => {
//     const page = getPage(req.body.pageId);
//     if (!page) return res.redirect('/?error=Page+not+found');
//     fetch(`https://graph.facebook.com/v17.0/me/conversations?fields=participants&access_token=${page.accessToken}&limit=500`)
//       .then(r => r.json()).then(data => {
//         ...
//       }).catch(e => {
//         ...
//       });
//   });
//
// PASTE this instead:
// ──────────────────────────────────────────────

app.post('/import-contacts', async (req, res) => {
  const page = getPage(req.body.pageId);
  if (!page) return res.redirect('/?error=Page+not+found');
  try {
    const count = await importAllConversations(page);
    res.redirect(`/?page=${page.pageId}&lib_msg=Imported+${count}+contacts`);
  } catch (e) {
    console.error(`Import error [${page.label}]:`, e.message);
    res.redirect(`/?page=${page.pageId}&error=Import+failed`);
  }
});


// ──────────────────────────────────────────────
// STEP 3: REPLACE the /import-contacts-batch route.
//
// DELETE this old block:
//
//   app.post('/import-contacts-batch', (req, res) => {
//     const pageIds = req.body.pageIds || [];
//     const results = [];
//     Promise.all(pageIds.map(async (pid) => {
//       ...
//     })).then(() => res.json({ ok: true, results }));
//   });
//
// PASTE this instead:
// (Sequential, not Promise.all — avoids rate-limiting 95 pages at once)
// ──────────────────────────────────────────────

app.post('/import-contacts-batch', async (req, res) => {
  const pageIds = req.body.pageIds || [];
  const results = [];
  for (const pid of pageIds) {
    const page = getPage(pid);
    if (!page) {
      results.push({ pageId: pid, ok: false, error: 'not found' });
      continue;
    }
    try {
      const count = await importAllConversations(page);
      results.push({ pageId: pid, ok: true, imported: count });
    } catch (e) {
      results.push({ pageId: pid, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, results });
});
