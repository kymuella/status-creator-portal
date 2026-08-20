// Creator portal API — the only function on this site.
//
// Deliberately narrow. It answers two questions for one creator, identified by
// a token in their link:
//
//   1. what are this week's hooks, and how are they doing
//   2. mark a hook posted or not posted
//
// Security rules this file exists to enforce:
//
//   - The browser NEVER sends a creator id. It sends a token; this function
//     resolves the creator server-side. There is no request shape that lets
//     someone ask for a different creator's data.
//   - It reads creator details from `creator_portal_profile`, a view without
//     payment details, addresses or invoice numbers. A `select *` here still
//     cannot leak billing data.
//   - Archived creators are rejected on every request, not just the first.
//   - The service key lives here and is never sent to the browser.
//
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY

const BASE = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY;

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!BASE || !KEY) {
    return json({ error: 'The portal is not configured yet.' }, 500);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }

  const token = String(body.token || '').trim();
  if (!/^[a-f0-9]{32,64}$/i.test(token)) {
    // Fixed message and shape for every bad token, so nothing can be learned
    // from the difference between "wrong format" and "no such token".
    return json({ error: 'This link is not valid. Ask the team for a new one.' }, 401);
  }

  let creator;
  try {
    const rows = await sb('GET',
      `creator_portal_profile?access_token=eq.${encodeURIComponent(token)}` +
      `&select=id,name,status,timezone,posting_days_per_week,weekly_target`);
    creator = rows[0];
  } catch (err) {
    return json({ error: 'Could not load your page. Try again in a moment.' }, 502);
  }

  if (!creator || String(creator.status || '').toLowerCase() !== 'active') {
    return json({ error: 'This link is not valid. Ask the team for a new one.' }, 401);
  }

  try {
    if (body.action === 'setStatus') return await setStatus(creator, body);
    return await loadDashboard(creator);
  } catch (err) {
    console.log('[portal] error for creator ' + creator.id + ': ' + err.message);
    return json({ error: 'Something went wrong. Try refreshing.' }, 500);
  }
};

/* ---------------------------------------------------------------- */

async function loadDashboard(creator) {
  // The newest published batch is "this week". Drafts are invisible here, so
  // the team can prepare a sheet without creators seeing half of it.
  const batches = await sb('GET',
    'hook_batches?status=eq.published&select=id,week_start,week_end,title' +
    '&order=week_start.desc,published_at.desc&limit=1');

  const batch = batches[0] || null;
  let hooks = [];

  if (batch) {
    hooks = await sb('GET',
      `weekly_hooks?batch_id=eq.${batch.id}&creator_id=eq.${creator.id}` +
      `&withdrawn=eq.false&select=id,hook_text,footage_idea,notes,sort_order` +
      `&order=sort_order.asc`);

    if (hooks.length) {
      const ids = hooks.map(h => h.id).join(',');
      const states = await sb('GET',
        `creator_hook_status?creator_id=eq.${creator.id}&hook_id=in.(${ids})` +
        `&select=hook_id,status,completed_at`);

      const byHook = {};
      states.forEach(s => { byHook[s.hook_id] = s; });
      hooks = hooks.map(h => ({
        ...h,
        status: (byHook[h.id] || {}).status || 'assigned',
        completed_at: (byHook[h.id] || {}).completed_at || null
      }));
    }
  }

  // Posting figures are computed here from the raw daily data, NOT read from
  // the posting_status summary table.
  //
  // That summary is written whenever the sweep last ran, with whatever counting
  // logic was deployed at the time, so reading it means the portal and the
  // tracker can quietly disagree. Computing from the same source both use keeps
  // one answer to "how many videos this week".
  const { weekStart, weekEnd } = currentWeek();
  let posting = null;

  try {
    const days = await sb('GET',
      `posting_days?creator_name=eq.${encodeURIComponent(creator.name)}` +
      `&day=gte.${weekStart}&and=(day.lte.${weekEnd})&select=day,unique_posts`);

    const daysPosted = days.filter(d => (d.unique_posts || 0) > 0).length;

    // Videos are counted on the busiest SINGLE account, matching how base pay
    // is calculated. Adding every account together overstates the work, because
    // most of it is the same creative cross-posted.
    const posts = await sb('GET',
      `posting_posts?creator_name=eq.${encodeURIComponent(creator.name)}` +
      `&deleted_at=is.null` +
      `&day=gte.${weekStart}&and=(day.lte.${weekEnd})` +
      `&select=username,platform,content_key,video_id`);

    // Videos are counted per invoice group: busiest single account within each
    // group, then the groups added together. That mirrors base pay exactly, so
    // this figure and the invoice cannot disagree. A creator on two groups is
    // on two contracts and owes the work twice.
    const accounts = await sb('GET',
      `creator_accounts?select=username,invoice_group_id,active`);
    const groupOf = {};
    accounts.forEach(a => {
      if (a.username) groupOf[String(a.username).toLowerCase()] = a.invoice_group_id;
    });

    // Count unique CREATIVES, not rows. The same video cross-posted to TikTok
    // and Instagram is two rows but one piece of work, and both rows often
    // share a username, so counting rows double-counts it. content_key is
    // caption + duration — the same key base pay uses.
    const creatives = {};   // "username|platform" -> Set of content keys
    posts.forEach(p => {
      const u = String(p.username || '').toLowerCase();
      if (!u) return;
      const k = u + '|' + String(p.platform || '').toLowerCase();
      const creative = p.content_key || p.video_id || '';
      (creatives[k] = creatives[k] || new Set()).add(creative);
    });

    // Within each invoice group take the busiest platform, then add the groups.
    const perGroup = {};
    Object.entries(creatives).forEach(([key, set]) => {
      const username = key.split('|')[0];
      const g = groupOf[username] || '_ungrouped';
      if (set.size > (perGroup[g] || 0)) perGroup[g] = set.size;
    });
    const videos = Object.values(perGroup).reduce((a, b) => a + b, 0);

    // Target is the sum of this creator's group targets.
    let target = creator.weekly_target || 0;
    try {
      const groups = await sb('GET',
        `invoice_groups?creator_id=eq.${creator.id}&select=weekly_video_target,active`);
      const summed = groups
        .filter(g => g.active !== false)
        .reduce((a, g) => a + (g.weekly_video_target || 0), 0);
      if (summed > 0) target = summed;
    } catch { /* fall back to the creator-level number */ }

    posting = {
      days_posted_this_week: daysPosted,
      posting_days_per_week: creator.posting_days_per_week || 0,
      videos_this_week: videos,
      weekly_video_target: target,
      week_start: weekStart,
      week_end: weekEnd
    };
  } catch { /* the dashboard is still useful without it */ }

  let recent = [];
  try {
    recent = await sb('GET',
      `posting_posts?creator_name=eq.${encodeURIComponent(creator.name)}` +
      `&deleted_at=is.null` +
      `&select=day,platform,video_url,views&order=day.desc&limit=8`);
  } catch { /* optional */ }

  return json({
    creator: { name: creator.name, timezone: creator.timezone },
    week: batch ? { start: batch.week_start, end: batch.week_end, title: batch.title } : null,
    hooks,
    posting,
    recent
  }, 200);
}

async function setStatus(creator, body) {
  const hookId = String(body.hook_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(hookId)) return json({ error: 'Bad request.' }, 400);

  const wanted = body.status === 'posted' ? 'posted' : 'assigned';

  // Confirm the hook is actually assigned to THIS creator before writing.
  // Without this, a valid token plus a guessed hook id could tick off someone
  // else's checklist.
  const owned = await sb('GET',
    `weekly_hooks?id=eq.${hookId}&creator_id=eq.${creator.id}&select=id&limit=1`);
  if (!owned.length) return json({ error: 'Bad request.' }, 400);

  await sb('POST', 'creator_hook_status?on_conflict=hook_id,creator_id', [{
    hook_id: hookId,
    creator_id: creator.id,
    status: wanted,
    completed_at: wanted === 'posted' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  }], { Prefer: 'resolution=merge-duplicates,return=representation' });

  return json({ ok: true, hook_id: hookId, status: wanted }, 200);
}

/* ---------------------------------------------------------------- */

// Monday to Sunday, matching the tracker's week.
function currentWeek(){
  const now = new Date();
  const day = (now.getUTCDay() + 6) % 7;          // 0 = Monday
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() - day);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const iso = d => d.toISOString().slice(0, 10);
  return { weekStart: iso(start), weekEnd: iso(end) };
}

async function sb(method, path, payload, extraHeaders) {
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    ...(extraHeaders || {})
  };
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return []; }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}
