# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ZeroKey, please **do not** open a public issue.

Send details to the project maintainer via a private channel. Include:

- A clear description of the vulnerability
- Steps to reproduce
- Affected versions (commit hash or release tag)
- Any potential impact or exploit scenario

You can expect a response within 72 hours. Once resolved, a security advisory will be published and credited to the reporter (unless you prefer to remain anonymous).

## Supported Versions

Only the latest commit on `main` is supported. No backports for prior releases.

## Security Design

ZeroKey stores browser session credentials (cookies, headers, tokens) in `temp/users.json`. This file is gitignored and should never be committed. Treat it as sensitive — anyone with access to this file can impersonate your browser sessions.

### Best Practices

- Run ZeroKey on `localhost` only — do not expose it to public networks
- Keep `temp/users.json` private and never commit it
- Use a firewall to block external access to the ZeroKey port
- Regularly refresh your browser sessions by re-capturing a fresh `fetch()` call
- If you suspect a session is compromised, delete the session from the startup wizard

### Dependencies

ZeroKey uses minimal dependencies (express, inquirer). Keep them updated:

```bash
npm audit
npm update
```

Report any dependency vulnerabilities as described above.
