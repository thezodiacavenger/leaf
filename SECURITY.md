# Security

Leaf opens files people receive from others (emails, PDFs, zips, images), so security reports matter.

**Please don't open a public issue for a vulnerability.** Report it privately with GitHub's [private vulnerability reporting](https://github.com/thezodiacavenger/leaf/security/advisories/new) (Security tab → "Report a vulnerability").

Helpful details: the file type, what Leaf did, and a sample file if you can share one safely.

## How Leaf limits risk
- Email HTML renders in a hidden window with JavaScript disabled and all network requests blocked.
- Zip entries with absolute paths or `..` are rejected (zip-slip).
- Renderer windows are sandboxed with context isolation; only a narrow, channel-checked bridge is exposed.
- The gallery can read only files Leaf itself produced.
- Leaf runs on a security-supported Electron release.
