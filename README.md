# OpenF1 Dashboard (GNOME 50 Extension)

A GNOME Shell extension that displays:

1. **Calendar**
   - Upcoming **non-canceled** race weekend
   - During an active race weekend, the **next upcoming session/event**
   - Time shown in:
     - race local time
     - UTC
     - your system local time

2. **Championship points**
   - Drivers standings (all drivers)
   - Constructors standings (all teams)

Data source: [OpenF1 API](https://api.openf1.org)

---

## Compatibility

- GNOME Shell **50**

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

- Full license text: [`LICENSE`](./LICENSE)
- SPDX identifier: `GPL-3.0-or-later`

---

## AI technologies used in development

This project was built with **AI-assisted development**. For transparency:

- **Agent framework:** Goose (AAIF) coding agent workflow
- **LLM assistance:** Large language model code generation/refactoring during iterative development
- **Human role:** Product direction, review, and acceptance testing by the project author
- **Verification loop:** GNOME Shell runtime checks (`gnome-extensions`, `gdbus`, `journalctl`) and iterative fixes

AI assistance was used for implementation and documentation generation, with human-driven requirements and final decisions.

---

## Install (local dev)

From this directory:

```bash
cd /home/ansilva/dev/openf1-gnome-extension
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r openf1dashboard@ansilva ~/.local/share/gnome-shell/extensions/
```

Enable:

```bash
gnome-extensions enable openf1dashboard@ansilva
```

Disable:

```bash
gnome-extensions disable openf1dashboard@ansilva
```

Reload quickly (Wayland-safe method):

```bash
gnome-extensions disable openf1dashboard@ansilva
gnome-extensions enable openf1dashboard@ansilva
```

---

## Notes on standings

OpenF1 does not provide a single direct championship endpoint. This extension computes standings from OpenF1 `session_result` race/sprint results and enriches names/teams from `drivers` data.

---

## Security review (OWASP Top 10 aligned)

This extension is a local GNOME UI client with outbound HTTPS requests to OpenF1. It does not process credentials, auth tokens, payments, or user-provided arbitrary input. Still, the code applies OWASP-aligned controls:

### A01 Broken Access Control
- No privileged backend actions or user role model in scope.
- Extension only reads public API data and writes a local cache file in user cache dir.

### A02 Cryptographic Failures
- Uses HTTPS OpenF1 endpoint only (`https://api.openf1.org/v1`).
- No secrets stored in code or cache.

### A03 Injection
- API path/query is allowlisted (`meetings`, `sessions`, `session_result`, `drivers`).
- Query string is validated against URL-safe characters.
- UI output is sanitized to strip control characters and normalize whitespace.

### A04 Insecure Design
- Cache-first design reduces API pressure and failure exposure.
- Explicit refresh policy (daily off-weekend, hourly race weekend).
- Defensive handling for API 404/429 and canceled sessions.

### A05 Security Misconfiguration
- HTTP session has timeout configured.
- Error messages shown in UI are generic (no raw payload dump).

### A06 Vulnerable/Outdated Components
- Keep GNOME Shell/GJS/Soup runtime updated via distro updates.
- No bundled third-party JS packages.

### A07 Identification and Authentication Failures
- Not applicable (no auth workflow).

### A08 Software and Data Integrity Failures
- Parsed API payload shape is validated (expects arrays).
- Large responses are bounded to prevent memory abuse.

### A09 Security Logging and Monitoring Failures
- GNOME Shell logs capture extension errors (`journalctl --user`, DBus extension error API).
- Runtime UI avoids leaking full backend payloads while still signaling error state.

### A10 Server-Side Request Forgery (SSRF)
- Endpoint host is fixed constant (`api.openf1.org`).
- Dynamic path/query is validated and endpoint-allowlisted.

## Additional hardening implemented
- Response size cap (1MB)
- On-disk cache size cap (2MB)
- Endpoint cache entry cap
- Sanitized UI text rendering
- Genericized error surface in UI

---

## Reproducible prompt pack (to rebuild the same outcome)

If you want to recreate this extension with an LLM coding agent, use these prompts in order.

### Prompt 1 — Base product requirements

```text
I'd like to build a gnome 50 compatible extension that uses OpenF1 API. The extension has 3 main sections:
- Calendar, where it show the upcoming racing weekend, and during the race weekend what's the next upcoming event. Times should be shown in race local time, UTC, and the systems time.
- Current championship points for drivers and teams.
```

### Prompt 2 — Reliability and API constraints

```text
Also, given we are using a free API, let's make sure we cache results if we can, and just check in for updates once a day during the week, and once an hour during race weekends.
```

### Prompt 3 — Manual control

```text
add a refresh now option
```

### Prompt 4 — Data quality and event status behavior

```text
the standings are still failing.

Also -- are you able to see via the API if a race gets canceled or postponed?
```

### Prompt 5 — Canceled-event UX and standings completeness

```text
Good progress. Here are updates:
- If a race is canceled, skip it and do not show in the extension, show the next non-canceled schedule race instead.
- For the drivers standing, show their name, not number. Show all drivers, not just top 10, maybe split the section in two columns
- The constructors championship still seems to be missing team name, and only showing 1 entry?
```

### Prompt 6 — UI readability

```text
Improvements:
- Let's improve the display so it is more legible
- let's also split the construction into two columns
- let's use abbreviation for the session names
```

### Prompt 7 — Security + open-source documentation

```text
You are now a security analyst, and you are going to review the code, and make sure it passes OWASP top 10 security checklist.
I want to open source this extension for educational reasons, please take the meaningful prompts I used in this chat to build this application and add it to the README.md, make sure that if someone re-uses the prompts that the application will be built with the same outcome.
```

---

## Validation commands

Check extension state:

```bash
gnome-extensions info openf1dashboard@ansilva
gdbus call --session --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.GetExtensionErrors \
  openf1dashboard@ansilva
```

Inspect logs:

```bash
journalctl --user --since "10 min ago" | grep -Ei "gnome-shell|openf1dashboard|extension"
```
