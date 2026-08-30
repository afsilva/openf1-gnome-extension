# OpenF1 Dashboard (GNOME 50 Extension)

A GNOME Shell extension that displays:

1. **Calendar**
   - Upcoming **non-canceled** race weekend
   - During an active race weekend, the **next upcoming session/event**
   - Time shown in:
     - race local time
     - UTC
     - your system local time
   - Uses text status labels such as `F1 | FP1`, `F1 | LIVE R`, `NEXT`, and `DONE` instead of emoji in the GNOME-review-ready `main` branch

2. **Championship points**
   - Drivers standings (Top 10, full names)
   - Constructors standings (Top 10 teams)

Data source: [OpenF1 API](https://api.openf1.org)

The previous emoji/flag-based UI is preserved in the [`emoji-ui-preserved`](https://github.com/afsilva/openf1-gnome-extension/tree/emoji-ui-preserved) branch.

---

## Compatibility

- GNOME Shell **50**

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

- Full license text: [`LICENSE`](./LICENSE)
- The extension upload bundle also includes [`openf1dashboard@ansilva/LICENSE`](./openf1dashboard%40ansilva/LICENSE)
- SPDX identifier: `GPL-3.0-or-later`

---

## Development transparency

This project used AI-assisted development tooling during implementation and documentation work. The project author directed the requirements, reviewed the code, performed GNOME Shell runtime validation, and remains responsible for the submitted extension.

Validation included GNOME Shell runtime checks with `gnome-extensions`, `gdbus`, and `journalctl`, plus iterative fixes based on observed behavior.

---

## Install (local dev)

Clone (or download) this repository anywhere, then run:

```bash
cd /path/to/openf1-gnome-extension
UUID="openf1dashboard@ansilva"
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r "$UUID" ~/.local/share/gnome-shell/extensions/
```

Enable:

```bash
gnome-extensions enable "$UUID"
```

Disable:

```bash
gnome-extensions disable "$UUID"
```

Reload quickly (Wayland-safe method):

```bash
gnome-extensions disable "$UUID"
gnome-extensions enable "$UUID"
```

---

## Package for extensions.gnome.org

The `main` branch is the GNOME-review-ready version. It avoids emoji UI elements, aborts pending HTTP requests on disable, and uses asynchronous cache reads in the GNOME Shell process.

Create the upload bundle from the repository root:

```bash
gnome-extensions pack --force --extra-source=LICENSE openf1dashboard@ansilva
```

This creates:

```text
openf1dashboard@ansilva.shell-extension.zip
```

The generated archive should contain only the files needed at runtime:

```text
metadata.json
extension.js
stylesheet.css
LICENSE
```

The generated `.shell-extension.zip` file is intentionally ignored by git.

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
- Pending HTTP requests are aborted when the extension is disabled/destroyed.

### A05 Security Misconfiguration
- HTTP session has timeout configured.
- Cache file reads use asynchronous Gio APIs to avoid blocking the GNOME Shell process.
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
- Asynchronous cache reads in the GNOME Shell process
- HTTP request abort on extension disable/destroy
- Sanitized UI text rendering
- Text-based status labels for the GNOME-review-ready branch
- Genericized error surface in UI

---

## AI-assisted development note

This repository previously included a prompt-history section for educational transparency. For the GNOME-review-ready `main` branch, the documentation focuses on maintainership, runtime behavior, validation, and packaging. The author remains responsible for understanding and maintaining the submitted code.

---

## Validation commands

Check extension state:

```bash
UUID="openf1dashboard@ansilva"
gnome-extensions info "$UUID"
gdbus call --session --dest org.gnome.Shell.Extensions \
  --object-path /org/gnome/Shell/Extensions \
  --method org.gnome.Shell.Extensions.GetExtensionErrors \
  "$UUID"
```

Inspect logs:

```bash
journalctl --user --since "10 min ago" | grep -Ei "gnome-shell|openf1dashboard|extension"
```
