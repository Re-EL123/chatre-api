'use strict';

/**
 * GitHub PR + CI helpers — Cursor-core Phase 3.
 * Uses the user's encrypted GitHub connector (never echoes tokens).
 */

const { connectorRequest } = require('./connectors');

function parseOwnerRepo(remoteOrSlug) {
  const s = String(remoteOrSlug || '').trim();
  if (!s) return null;
  // owner/repo
  let m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo(.git)
  m = s.match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/i,
  );
  if (m) return { owner: m[1], repo: m[2] };
  // git@github.com:owner/repo.git
  m = s.match(
    /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  );
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

function resolveRepo(ctx, params) {
  const p = params || {};
  if (p.owner && p.repo) {
    return { owner: String(p.owner), repo: String(p.repo) };
  }
  if (p.repository || p.repoSlug || p.full_name) {
    const parsed = parseOwnerRepo(p.repository || p.repoSlug || p.full_name);
    if (parsed) return parsed;
  }
  const remote =
    (ctx && ctx.repo && ctx.repo.remoteUrl) ||
    (ctx && ctx.git && ctx.git.remotes && ctx.git.remotes.origin && ctx.git.remotes.origin.url) ||
    '';
  const fromRemote = parseOwnerRepo(remote);
  if (fromRemote) return fromRemote;
  return null;
}

async function gh(uid, method, path, body) {
  return connectorRequest(uid, {
    provider: 'github',
    method: method || 'GET',
    path: path,
    body: body,
  });
}

function prSummary(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    number: data.number,
    title: data.title || '',
    state: data.state || '',
    html_url: data.html_url || null,
    head: data.head && data.head.ref ? data.head.ref : null,
    base: data.base && data.base.ref ? data.base.ref : null,
    draft: !!data.draft,
    merged: !!data.merged,
    user: data.user && data.user.login ? data.user.login : null,
  };
}

async function createPullRequest(ctx, params) {
  const p = params || {};
  if (!ctx || !ctx.userId) {
    return { ok: false, error: 'Signed-in user required for GitHub PRs' };
  }
  const repo = resolveRepo(ctx, p);
  if (!repo) {
    return {
      ok: false,
      error:
        'Could not resolve owner/repo — set ctx.repo.remoteUrl or pass owner+repo',
    };
  }
  const title = String(p.title || '').trim();
  if (!title) return { ok: false, error: 'title required' };
  const head =
    String(p.head || p.branch || (ctx.repo && ctx.repo.branch) || '').trim() ||
    'HEAD';
  const base = String(p.base || p.baseBranch || 'main').trim() || 'main';
  const body = String(p.body || p.description || '').slice(0, 60000);
  const res = await gh(
    ctx.userId,
    'POST',
    '/repos/' + repo.owner + '/' + repo.repo + '/pulls',
    {
      title: title,
      head: head,
      base: base,
      body: body,
      draft: !!p.draft,
    },
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || 'create PR failed',
      status: res.status,
      data: res.data,
      repository: repo.owner + '/' + repo.repo,
    };
  }
  const summary = prSummary(res.data);
  ctx.lastPr = Object.assign({}, summary, {
    repository: repo.owner + '/' + repo.repo,
    at: new Date().toISOString(),
  });
  return {
    ok: true,
    text:
      'Opened PR #' +
      summary.number +
      ': ' +
      summary.title +
      (summary.html_url ? ' — ' + summary.html_url : ''),
    pr: ctx.lastPr,
    html_url: summary.html_url,
    number: summary.number,
    repository: repo.owner + '/' + repo.repo,
  };
}

async function listPullRequests(ctx, params) {
  const p = params || {};
  if (!ctx || !ctx.userId) {
    return { ok: false, error: 'Signed-in user required' };
  }
  const repo = resolveRepo(ctx, p);
  if (!repo) return { ok: false, error: 'owner/repo required' };
  const state = String(p.state || 'open');
  const limit = Math.min(Number(p.limit || p.per_page || 10) || 10, 30);
  const res = await gh(
    ctx.userId,
    'GET',
    '/repos/' +
      repo.owner +
      '/' +
      repo.repo +
      '/pulls?state=' +
      encodeURIComponent(state) +
      '&per_page=' +
      limit,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || 'list PRs failed',
      status: res.status,
      data: res.data,
    };
  }
  const list = Array.isArray(res.data) ? res.data.map(prSummary) : [];
  return {
    ok: true,
    pulls: list,
    repository: repo.owner + '/' + repo.repo,
    text:
      list.length === 0
        ? 'No ' + state + ' pull requests'
        : list
            .map(
              (x) =>
                '#' +
                x.number +
                ' ' +
                x.title +
                (x.html_url ? ' ' + x.html_url : ''),
            )
            .join('\n'),
  };
}

async function getPullRequest(ctx, params) {
  const p = params || {};
  if (!ctx || !ctx.userId) {
    return { ok: false, error: 'Signed-in user required' };
  }
  const repo = resolveRepo(ctx, p);
  if (!repo) return { ok: false, error: 'owner/repo required' };
  const number = Number(p.number || p.pr || p.pull);
  if (!number) return { ok: false, error: 'number required' };
  const res = await gh(
    ctx.userId,
    'GET',
    '/repos/' + repo.owner + '/' + repo.repo + '/pulls/' + number,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || 'get PR failed',
      status: res.status,
      data: res.data,
    };
  }
  const summary = prSummary(res.data);
  return {
    ok: true,
    pr: Object.assign({}, summary, {
      repository: repo.owner + '/' + repo.repo,
    }),
    html_url: summary.html_url,
    number: summary.number,
    text:
      'PR #' +
      summary.number +
      ' [' +
      summary.state +
      '] ' +
      summary.title +
      (summary.html_url ? ' — ' + summary.html_url : ''),
  };
}

async function reviewPullRequest(ctx, params) {
  const p = params || {};
  if (!ctx || !ctx.userId) {
    return { ok: false, error: 'Signed-in user required' };
  }
  const repo = resolveRepo(ctx, p);
  if (!repo) return { ok: false, error: 'owner/repo required' };
  const number = Number(p.number || p.pr || p.pull);
  if (!number) return { ok: false, error: 'number required' };
  let event = String(p.event || p.action || 'COMMENT').toUpperCase();
  if (
    event !== 'APPROVE' &&
    event !== 'REQUEST_CHANGES' &&
    event !== 'COMMENT'
  ) {
    event = 'COMMENT';
  }
  const body = String(p.body || p.comment || '').slice(0, 60000);
  if (event === 'REQUEST_CHANGES' && !body) {
    return { ok: false, error: 'body required for REQUEST_CHANGES' };
  }
  const res = await gh(
    ctx.userId,
    'POST',
    '/repos/' +
      repo.owner +
      '/' +
      repo.repo +
      '/pulls/' +
      number +
      '/reviews',
    { event: event, body: body },
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error || 'review failed',
      status: res.status,
      data: res.data,
    };
  }
  const out = {
    ok: true,
    number: number,
    event: event,
    html_url:
      (res.data && (res.data.html_url || res.data.pull_request_url)) || null,
    text: 'Submitted ' + event + ' on PR #' + number,
    repository: repo.owner + '/' + repo.repo,
  };
  ctx.lastPr = Object.assign({}, ctx.lastPr || {}, {
    number: number,
    repository: repo.owner + '/' + repo.repo,
    lastReview: event,
    html_url: out.html_url || (ctx.lastPr && ctx.lastPr.html_url) || null,
    at: new Date().toISOString(),
  });
  return out;
}

async function getCiStatus(ctx, params) {
  const p = params || {};
  if (!ctx || !ctx.userId) {
    return { ok: false, error: 'Signed-in user required' };
  }
  const repo = resolveRepo(ctx, p);
  if (!repo) return { ok: false, error: 'owner/repo required' };
  const ref =
    String(
      p.ref ||
        p.sha ||
        p.branch ||
        (ctx.repo && ctx.repo.head) ||
        (ctx.repo && ctx.repo.branch) ||
        'HEAD',
    ).trim() || 'HEAD';

  // Prefer check runs for the ref
  const checks = await gh(
    ctx.userId,
    'GET',
    '/repos/' +
      repo.owner +
      '/' +
      repo.repo +
      '/commits/' +
      encodeURIComponent(ref) +
      '/check-runs?per_page=40',
  );

  let items = [];
  let ciOk = true;
  if (checks.ok && checks.data && Array.isArray(checks.data.check_runs)) {
    items = checks.data.check_runs.slice(0, 40).map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      html_url: c.html_url || null,
    }));
    const relevant = items.filter(
      (c) => c.status === 'completed' || c.conclusion,
    );
    if (relevant.length) {
      ciOk = relevant.every(
        (c) =>
          c.conclusion === 'success' ||
          c.conclusion === 'neutral' ||
          c.conclusion === 'skipped',
      );
    } else if (items.some((c) => c.status === 'in_progress' || c.status === 'queued')) {
      ciOk = false;
    }
  } else {
    // Fallback: combined status
    const st = await gh(
      ctx.userId,
      'GET',
      '/repos/' +
        repo.owner +
        '/' +
        repo.repo +
        '/commits/' +
        encodeURIComponent(ref) +
        '/status',
    );
    if (!st.ok) {
      return {
        ok: false,
        error: checks.error || st.error || 'CI status unavailable',
        status: checks.status || st.status,
      };
    }
    const state = (st.data && st.data.state) || 'pending';
    ciOk = state === 'success';
    items = Array.isArray(st.data && st.data.statuses)
      ? st.data.statuses.slice(0, 40).map((s) => ({
          name: s.context,
          status: s.state,
          conclusion: s.state,
          html_url: s.target_url || null,
        }))
      : [];
  }

  ctx.ciOk = !!ciOk;
  ctx.lastCi = {
    ok: !!ciOk,
    ref: ref,
    repository: repo.owner + '/' + repo.repo,
    checks: items,
    at: new Date().toISOString(),
  };
  return {
    ok: true,
    ciOk: !!ciOk,
    ref: ref,
    checks: items,
    lastCi: ctx.lastCi,
    text: ciOk
      ? 'CI green on ' + ref + ' (' + items.length + ' checks)'
      : 'CI not green on ' + ref + ' (' + items.length + ' checks)',
    repository: repo.owner + '/' + repo.repo,
  };
}

module.exports = {
  parseOwnerRepo,
  resolveRepo,
  createPullRequest,
  listPullRequests,
  getPullRequest,
  reviewPullRequest,
  getCiStatus,
  prSummary,
};
