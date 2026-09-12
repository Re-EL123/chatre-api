'use strict';

/**
 * Structured run log + audit export (secrets redacted).
 */

const { redactValue } = require('./secrets-redact');

function createRunLog(runId) {
  return {
    runId: runId || '',
    startedAt: new Date().toISOString(),
    events: [],
  };
}

function logEvent(log, type, data) {
  if (!log || !Array.isArray(log.events)) return;
  const safe = redactValue(data && typeof data === 'object' ? data : { data });
  log.events.push({
    t: Date.now(),
    type: String(type || 'event'),
    ...(safe && typeof safe === 'object' ? safe : { data: safe }),
  });
  if (log.events.length > 800) {
    log.events = log.events.slice(-600);
  }
}

function summarizeLog(log) {
  if (!log) return null;
  const tools = log.events.filter((e) => e.type === 'tool' || e.type === 'tool_result').length;
  const errors = log.events.filter((e) => e.type === 'error').length;
  const approvals = log.events.filter(
    (e) => String(e.type || '').indexOf('awaiting') === 0 || e.type === 'approval',
  ).length;
  return {
    runId: log.runId,
    startedAt: log.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: log.events.length,
    tools,
    errors,
    approvals,
    phases: log.events
      .filter((e) => e.type === 'phase' || e.phase)
      .map((e) => e.phase || e.to || e.type)
      .slice(-40),
  };
}

function exportAudit(log, opts) {
  const o = opts || {};
  const summary = summarizeLog(log);
  const events = redactValue((log && log.events) || []);
  return {
    schema: 'chatre.audit.v1',
    exportedAt: new Date().toISOString(),
    threadId: o.threadId || null,
    workspaceId: o.workspaceId || null,
    userId: o.userId || null,
    summary,
    events: o.full === false ? events.slice(-100) : events,
    proof: o.proof || null,
  };
}

module.exports = { createRunLog, logEvent, summarizeLog, exportAudit };
