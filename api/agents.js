'use strict';

const { handleCors } = require('../lib/cors');
const { readBody, sendJson, requireUser } = require('../lib/http');
const users = require('../lib/users');
const { listNative, mergeUserAgents } = require('../lib/agents');
const { generateCustomAgent } = require('../lib/agent-helpers');
const { preferByokModel } = require('../lib/autonomy');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  const auth = await requireUser(req, res);
  if (!auth) return;

  const url = new URL(req.url, 'http://localhost');
  const action = String(url.searchParams.get('action') || '').toLowerCase();

  try {
    const profile = await users.ensureUser(auth.uid, auth.email || '');
    const custom = users.listCustomAgents(profile);

    if (req.method === 'GET') {
      const includeHidden = url.searchParams.get('hidden') === '1';
      const map = mergeUserAgents(custom);
      const agents = Object.keys(map)
        .map((k) => map[k])
        .filter((a) => includeHidden || !a.hidden)
        .map((a) => ({
          name: a.name,
          description: a.description || a.whenToUse || '',
          whenToUse: a.whenToUse || '',
          mode: a.mode,
          native: !!a.native,
          hidden: !!a.hidden,
          color: a.color || null,
          steps: a.steps || null,
        }))
        .sort((a, b) => {
          if (!!a.native !== !!b.native) return a.native ? -1 : 1;
          return String(a.name).localeCompare(String(b.name));
        });
      return sendJson(res, 200, {
        agents,
        native: listNative({ includeHidden: false }),
        custom,
      });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (action === 'generate' || body.action === 'generate') {
        const byokDoc = await users.getByokDoc(auth.uid);
        const byokFlags = users.byokConfiguredFlags(byokDoc);
        const model = preferByokModel(
          body.model || (profile.defaults && profile.defaults.model),
          byokFlags,
          profile.defaults || {},
        );
        const agent = await generateCustomAgent({
          description: body.description || body.prompt || '',
          model,
          userId: auth.uid,
          existingNames: Object.keys(mergeUserAgents(custom)),
          workspaceHint: body.workspaceHint || '',
        });
        if (body.save !== false) {
          await users.saveCustomAgent(auth.uid, agent);
        }
        return sendJson(res, 200, { agent, saved: body.save !== false });
      }
      if (action === 'save' || body.action === 'save') {
        const agent = await users.saveCustomAgent(auth.uid, body.agent || body);
        return sendJson(res, 200, { agent });
      }
      return sendJson(res, 400, { error: 'Unknown action' });
    }

    if (req.method === 'DELETE') {
      const name =
        url.searchParams.get('name') ||
        (await readBody(req).catch(() => ({}))).name;
      const list = await users.deleteCustomAgent(auth.uid, name);
      return sendJson(res, 200, { agents: list });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return sendJson(res, 500, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
