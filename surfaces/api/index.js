// The 'api' surface — the fallback for requests with no recognizable IDE
// system prompt (ephemeral/utility calls: title-gen, tool-optimizer, …).
// It exposes no tools and owns no system-prompt fingerprint, so it can never be
// matched as a "real" surface — it is only ever reached via DEFAULT_SURFACE in
// utils/session-classifier.js. Requests landing here run in rawMode.
module.exports = (t) => {
  t.ideName = 'api'
  t.newSessionStartLength = 0
  t.realSessionPrefix = null

  t.system = (content) => content
}
