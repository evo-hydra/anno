# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in Anno, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email **security@evointel.com** with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Security Measures

Anno includes the following security protections:

- **SSRF protection** — URL validation blocks requests to internal/private networks
- **Helmet** — Security headers (CSP, X-Frame-Options, etc.)
- **Input validation** — Zod schemas on all API inputs
- **Rate limiting** — Per-tenant and global rate limits
- **Error sanitization** — 5xx error details hidden in production
- **Robots.txt compliance** — Respects crawl-delay and disallow rules
