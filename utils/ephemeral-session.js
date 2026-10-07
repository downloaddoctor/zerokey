/**
 * Clones a real session into a disposable one for a single request: no
 * id/parentId link to the real thread, and any mutation
 * the stream handler makes (id, parentId, lastUsed) lands
 * on the clone only — it is never written back to user.sessions, so it is
 * naturally discarded once the request completes.
 *
 * @param {object} session - the real session object
 * @returns {object} a shallow clone safe to mutate per-request
 */
function ephemeralSession(session) {
  // Usage totals are nested objects shared by reference with the real row, so
  // deep-copy them: a utility call must not overwrite the real session's
  // last-turn usage through the shared object.
  const copy = (value) => (value ? JSON.parse(JSON.stringify(value)) : value)
  return {
    ...session,
    id: null,
    parentId: null,
    usageTotals: copy(session.usageTotals),
    _usageTotals: copy(session._usageTotals),
    // Loop-guard history is an array; shallow-clone it so pushHistory on the
    // ephemeral clone never mutates the real session's row.
    _toolHistory: Array.isArray(session._toolHistory)
      ? [...session._toolHistory]
      : session._toolHistory,
  }
}

module.exports = { ephemeralSession }
