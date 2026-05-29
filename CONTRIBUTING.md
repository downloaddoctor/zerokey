# Contributing to ZeroKey

Thanks for your interest in contributing! ZeroKey is a personal-use tool — contributions that improve the experience for individual developers are welcome.

## Getting Started

1. Fork the repo and clone locally
2. Run `npm install`
3. Start the server with `npm start` — the interactive wizard will guide you through setup
4. Create a branch for your changes

## What We Welcome

- Bug fixes and error handling improvements
- New provider support (must be free-tier, browser-session based)
- IDE template additions
- Documentation and README improvements
- Performance optimizations (streaming, POW, cookie management)

## What We Don't Accept

- Features that enable commercial use, multi-tenancy, or paid access
- Credential sharing, scraping tools, or anything that abuses provider ToS
- Removing or weakening the browser fingerprint / session auth mechanisms
- Telemetry, analytics, or any user tracking

## Code Style

- Single quotes, LF line endings
- No external API dependencies beyond what's already used
- Keep it self-hosted — no cloud services, no external auth
- Git commits: emoji + conventional commits (`📝 docs:`, `🐛 fix:`, `✨ feat:`)

## Pull Requests

- Keep PRs focused — one feature or fix per PR
- Test your changes locally before submitting
- Update README if behavior changes affect users

## Questions?

Open an issue on GitHub.
