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
  return {
    ...session,
    id: null,
    parentId: null,
  }
}

module.exports = { ephemeralSession }
