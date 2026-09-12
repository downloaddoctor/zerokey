const express = require('express')

/**
 * Base router with common Express route scaffolding.
 */
class BaseRouter {
  constructor(provider, parsedFetch, session, userData) {
    this.provider = provider
    this.parsedFetch = parsedFetch
    this.session = session
    this.userData = userData
    this.router = express.Router()
  }

  /**
   * Build and return the Express router.
   * Override in subclass to add provider-specific routes.
   */
  build() {
    return this.router
  }
}

module.exports = { BaseRouter }
