'use strict';

/**
 * Load co-located tool description prompts (OpenCode-style .txt beside schemas).
 * Paths are literal so serverless file tracing includes the .txt files.
 */

const fs = require('fs');
const path = require('path');

function readTxt(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name + '.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

const PROMPTS = {
  execute_command: readTxt('execute_command'),
  read_file: readTxt('read_file'),
  view_file_outline: readTxt('view_file_outline'),
  write_file: readTxt('write_file'),
  find_files: readTxt('find_files'),
  search_code: readTxt('search_code'),
};

function loadPrompt(name) {
  return PROMPTS[String(name || '')] || '';
}

/** Overlay .txt descriptions onto OpenAI-style TOOL_DEFS when a prompt file exists. */
function applyToolPrompts(defs) {
  if (!Array.isArray(defs)) return defs;
  return defs.map((entry) => {
    const fn = entry && entry.function;
    if (!fn || !fn.name) return entry;
    const prompt = loadPrompt(fn.name);
    if (!prompt) return entry;
    return {
      ...entry,
      function: Object.assign({}, fn, { description: prompt }),
    };
  });
}

module.exports = { loadPrompt, applyToolPrompts, PROMPTS };
