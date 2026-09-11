'use strict';

/**
 * Structured run log events for agent observability.
 */

function createRunLog(runId) {
  return {
    runId: runId || '',
    startedAt: new Date().toISOString(),
    events: [],
  };
}

function logEvent(log, type, data) {
  if (!log || !Array.isArray(log.events)) return;
  log.events.push({
    t: Date.now(),
    type: String(type || 'event'),
    ...(data && typeof data === 'object' ? data : { data }),
  });
  // Cap memory
  if (log.events.length > 500) {
    log.events = log.events.slice(-400);
  }
}

function summarizeLog(log) {
  if (!log) return null;
  const tools = log.events.filter((e) => e.type === 'tool').length;
  const errors = log.events.filter((e) => e.type === 'error').length;
  return {
    runId: log.runId,
    startedAt: log.startedAt,
    endedAt: new Date().toISOString(),
    eventCount: log.events.length,
    tools,
    errors,
    phases: log.events.filter((e) => e.type === 'phase').map((e) => e.phase),
  };
}

module.exports = { createRunLog, logEvent, summarizeLog };
