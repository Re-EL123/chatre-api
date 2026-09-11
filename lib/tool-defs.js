'use strict';

/**
 * OpenAI-style tool definitions for structured function calling.
 * Worker passes these to Workers AI when supported; agent also
 * accepts markdown ```tool fallbacks.
 */

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description: 'Record a concrete multi-step plan before implementing.',
      parameters: {
        type: 'object',
        properties: {
          steps: { type: 'string', description: 'Numbered or bulleted plan' },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description: 'List available agent skills.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Load an extra skill playbook (usually auto-selected already).',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            enum: ['coding', 'documents', 'git', 'debugging', 'research', 'project'],
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Run a shell command in the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with full contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List entries in a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_tree',
      description: 'List all workspace paths.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Write a markdown document under /home/user/documents/.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_project',
      description: 'Sanity-check that project files exist.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_init',
      description: 'Initialize a git repo in the workspace.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_add',
      description: 'Stage paths for commit.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Commit staged changes.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status JSON.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Record a push to a remote in the workspace log.',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string' },
          branch: { type: 'string' },
        },
      },
    },
  },
];

function normalizeToolCall(item) {
  if (!item) return null;
  // Native: { id, type, function: { name, arguments } }
  if (item.function && item.function.name) {
    let params = {};
    const raw = item.function.arguments;
    if (typeof raw === 'string') {
      try {
        params = JSON.parse(raw || '{}');
      } catch {
        params = {};
      }
    } else if (raw && typeof raw === 'object') {
      params = raw;
    }
    return {
      tool: item.function.name,
      params,
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: true,
    };
  }
  // Markdown / legacy: { tool, params, id }
  if (item.tool) {
    return {
      tool: item.tool,
      params: item.params || item.arguments || {},
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: false,
    };
  }
  // Flat: { name, arguments }
  if (item.name) {
    let params = item.arguments || item.params || {};
    if (typeof params === 'string') {
      try {
        params = JSON.parse(params);
      } catch {
        params = {};
      }
    }
    return {
      tool: item.name,
      params,
      id: item.id || 'tc_' + Math.random().toString(36).slice(2, 8),
      structured: true,
    };
  }
  return null;
}

module.exports = { TOOL_DEFS, normalizeToolCall };
