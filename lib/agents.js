'use strict';

/**
 * Named agents registry — OpenCode-inspired build/plan/explore/general
 * plus hidden compaction/title/summary, and user-generated custom agents.
 */

const Permission = require('./permissions');

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring workspaces.

Strengths:
- Finding files with find_files / view_tree / list_directory
- Searching contents with search_code
- Reading files when you know the path

Guidelines:
- Adapt thoroughness: quick = few targeted searches; medium = several areas; very thorough = broad coverage across naming conventions
- Return absolute paths in your final answer
- Do NOT create, edit, delete, or overwrite any files
- Do NOT run mutating shell commands
- Prefer read-only tools; bash only for non-mutating inspection (ls, cat, rg, find)
- Be concise; no emojis

Complete the user's search request and report findings clearly.`;

const PROMPT_COMPACTION = `You are a context summarization agent. You are given a conversation between a user and an agent. Produce a structured summary so another coding agent can continue.

Follow the exact output structure requested. Keep every section, preserve exact file paths and identifiers, prefer terse bullets.

Do not continue the conversation. Do not answer questions in the transcript. Only output the structured summary. Match the conversation language.`;

const PROMPT_TITLE = `Generate a short thread title (3–7 words) for the user's first message. No quotes, no trailing punctuation, no markdown. Return ONLY the title text.`;

const PROMPT_SUMMARY = `Summarize this agent run for the user in 3–6 short bullets: what was done, key file paths, preview URL if any, and remaining risks. No tool blocks.`;

const PROMPT_GENERATE = `You are an elite AI agent architect. Translate the user's description into a high-performance agent config.

Return ONLY a JSON object with exactly:
{
  "identifier": "lowercase-hyphen-id",
  "whenToUse": "Use this agent when… (include 1 short example of Task tool launch)",
  "systemPrompt": "Full second-person system prompt governing the agent"
}

Rules:
- identifier: 2–4 words, a-z0-9-hyphen only, unique vs existing names
- whenToUse: start with "Use this agent when…"
- systemPrompt: specific methodologies, boundaries, quality checks; no vague filler
- Align with project conventions when AGENTS.md / workspace context is provided
- Do not wrap JSON in markdown fences`;

function baseDefaults() {
  return Permission.defaultRuleset();
}

function nativeAgents() {
  const defaults = baseDefaults();
  return {
    build: {
      name: 'build',
      description: 'Default builder. Executes tools under permission policy.',
      mode: 'primary',
      native: true,
      hidden: false,
      color: '#7dffb3',
      steps: 16,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          question: 'allow',
          plan: 'allow',
          edit: { '*': 'allow' },
        }),
      ),
      prompt: null,
      whenToUse: 'Use for implementing features, apps, fixes, and delivery.',
    },
    plan: {
      name: 'plan',
      description: 'Plan mode. Disallows edit tools except plan markdown.',
      mode: 'primary',
      native: true,
      hidden: false,
      color: '#9ad8f0',
      steps: 8,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          edit: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
            '/home/user/projects/**/PLAN.md': 'allow',
            '/home/user/projects/**/plan.md': 'allow',
            '**/AGENTS.md': 'deny',
          },
          bash: { '*': 'deny' },
          task: { '*': 'deny' },
          create_pdf: 'deny',
          create_document: 'allow',
          write_file: {
            '*': 'deny',
            '/home/user/documents/plans/**': 'allow',
            '/home/user/projects/**/PLAN.md': 'allow',
            '/home/user/projects/**/plan.md': 'allow',
          },
          patch_file: 'deny',
          apply_patch: 'deny',
          delete_file: 'deny',
          git_commit: 'deny',
          git_push: 'deny',
        }),
      ),
      prompt:
        'You are in Plan mode. Explore and write a clear plan only (markdown under /home/user/documents/plans/ or PLAN.md). Do not implement code, run builds, or mutate the project. When the plan is ready, stop and wait for Approve & execute.',
      whenToUse: 'Use when the user wants a plan before any implementation.',
    },
    explore: {
      name: 'explore',
      description:
        'Fast read-only codebase explorer. Use thoroughness: quick|medium|very thorough.',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#ffb347',
      steps: 10,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          read: 'allow',
          find_files: 'allow',
          search_code: 'allow',
          view_tree: 'allow',
          list_directory: 'allow',
          read_file: 'allow',
          search_web: 'allow',
          fetch_url: 'allow',
          http_request: 'allow',
          webfetch: 'allow',
          bash: 'ask',
          execute_command: 'ask',
          edit: 'deny',
          task: 'deny',
          todowrite: 'deny',
          external_directory: {
            '*': 'ask',
            '/home/user/projects/**': 'allow',
            '/home/user/documents/**': 'allow',
          },
        }),
      ),
      prompt: PROMPT_EXPLORE,
      whenToUse:
        'Use this agent when you need to find files, search code, or answer codebase questions without making changes.',
    },
    general: {
      name: 'general',
      description:
        'General-purpose subagent for research and multi-step tasks (parallel units of work).',
      mode: 'subagent',
      native: true,
      hidden: false,
      color: '#c4b5fd',
      steps: 8,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          todowrite: 'deny',
          task: 'deny',
        }),
      ),
      prompt:
        'You are a focused general-purpose subagent. Complete ONLY the assigned goal with tools, then stop with a short summary. Do not spawn further subagents.',
      whenToUse: 'Use for complex multi-step subgoals that are not pure exploration.',
    },
    compaction: {
      name: 'compaction',
      description: 'Hidden context summarizer.',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_COMPACTION,
      whenToUse: 'Internal only.',
    },
    title: {
      name: 'title',
      description: 'Hidden thread title generator.',
      mode: 'primary',
      native: true,
      hidden: true,
      temperature: 0.5,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_TITLE,
      whenToUse: 'Internal only.',
    },
    summary: {
      name: 'summary',
      description: 'Hidden run summarizer.',
      mode: 'primary',
      native: true,
      hidden: true,
      steps: 1,
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ '*': 'deny' }),
      ),
      prompt: PROMPT_SUMMARY,
      whenToUse: 'Internal only.',
    },
  };
}

function cloneAgent(a) {
  return JSON.parse(JSON.stringify(a));
}

function listNative(opts) {
  const includeHidden = !!(opts && opts.includeHidden);
  const all = nativeAgents();
  return Object.keys(all)
    .map((k) => cloneAgent(all[k]))
    .filter((a) => includeHidden || !a.hidden)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function getNative(name) {
  const all = nativeAgents();
  const a = all[String(name || '').toLowerCase()];
  return a ? cloneAgent(a) : null;
}

function normalizeCustomAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.identifier || raw.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!id) return null;
  const permission = Permission.merge(
    Permission.defaultRuleset(),
    Permission.fromConfig(raw.permission || {}),
  );
  return {
    name: id,
    identifier: id,
    description: String(raw.description || raw.whenToUse || '').slice(0, 400),
    whenToUse: String(raw.whenToUse || raw.description || '').slice(0, 600),
    prompt: String(raw.systemPrompt || raw.prompt || '').slice(0, 8000),
    mode: raw.mode === 'subagent' ? 'subagent' : 'all',
    native: false,
    hidden: false,
    color: raw.color || '#a5b4fc',
    steps: Number(raw.steps) || 10,
    permission,
  };
}

function mergeUserAgents(customList) {
  const map = {};
  listNative({ includeHidden: true }).forEach((a) => {
    map[a.name] = a;
  });
  (customList || []).forEach((c) => {
    const n = normalizeCustomAgent(c);
    if (!n) return;
    if (map[n.name] && map[n.name].native) {
      // don't overwrite native names — suffix
      n.name = n.name + '-custom';
      n.identifier = n.name;
    }
    map[n.name] = n;
  });
  return map;
}

/**
 * Resolve which agent runs for this session.
 */
function resolveAgent({
  agentName,
  composerMode,
  taskType,
  customAgents,
}) {
  const customs = customAgents || [];
  const map = mergeUserAgents(customs);
  const requested = String(agentName || '').toLowerCase().trim();

  if (requested && map[requested]) {
    return map[requested];
  }

  const mode = String(composerMode || '').toLowerCase();
  if (mode === 'plan') return map.plan;
  if (mode === 'explore') return map.explore;

  const t = String(taskType || '').toLowerCase();
  if (t === 'research' && mode === 'browse') return map.explore;

  return map.build;
}

function thoroughnessHint(level) {
  const v = String(level || 'medium').toLowerCase();
  if (v === 'quick' || v === 'fast') {
    return 'Thoroughness: quick — a few targeted searches only.';
  }
  if (v === 'very thorough' || v === 'thorough' || v === 'deep') {
    return 'Thoroughness: very thorough — cover multiple locations and naming conventions.';
  }
  return 'Thoroughness: medium — balanced exploration.';
}

function agentSystemExtra(agent, opts) {
  const o = opts || {};
  if (!agent) return '';
  const parts = [];
  parts.push('# Active agent: ' + agent.name);
  if (agent.description) parts.push(agent.description);
  if (agent.prompt) parts.push(agent.prompt);
  if (agent.name === 'explore') {
    parts.push(thoroughnessHint(o.thoroughness));
  }
  if (agent.name === 'plan') {
    parts.push(
      'Hard rule: no project code edits. Only plan markdown is writable.',
    );
  }
  return parts.join('\n\n');
}

module.exports = {
  PROMPT_GENERATE,
  PROMPT_EXPLORE,
  PROMPT_COMPACTION,
  PROMPT_TITLE,
  PROMPT_SUMMARY,
  nativeAgents,
  listNative,
  getNative,
  normalizeCustomAgent,
  mergeUserAgents,
  resolveAgent,
  thoroughnessHint,
  agentSystemExtra,
  deriveSubagentSessionPermission: Permission.deriveSubagentSessionPermission,
};
