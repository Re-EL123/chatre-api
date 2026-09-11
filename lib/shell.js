'use strict';

/**
 * Chatre shell — re-exports core + async runner for backward compatibility.
 */

const core = require('./shell-core');
const runner = require('./shell-runner');

function runInTempWorkspace(opts) {
  return core.runInTempWorkspaceSync({
    ...opts,
    workspaceId: opts && opts.workspaceId,
  });
}

module.exports = {
  runInTempWorkspace,
  runWorkspaceCommand: runner.runWorkspaceCommand,
  truncateOutput: runner.truncateOutput,
  detectNeedsInput: runner.detectNeedsInput,
  resolveMode: runner.resolveMode,
  materialize: core.materialize,
  collect: core.collect,
  ALLOWED_BINARIES: core.ALLOWED_BINARIES,
  ALLOWED_BY_PACK: core.ALLOWED_BY_PACK,
  parseCommand: core.parseCommand,
};
