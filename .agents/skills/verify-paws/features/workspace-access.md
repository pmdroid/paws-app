# Workspace sign-in and access

Users sign in with Linear to open their workspace. Owners configure repository access in Settings, members see the work they can access, and either identity can sign out.

## Sub-features

- `workspace-bootstrap` connects the first workspace with an operator setup code.
- `workspace-login` signs in a separate member through Linear.
- `workspace-settings` persists an owner's repository mapping.
- `workspace-roles` shows controls appropriate to the signed-in identity.
- `workspace-logout` ends the browser session.

## How to get to it (user POV)

- Open `/status/`, expand `Set up your first workspace`, enter the operator's code and choose `Connect workspace`.
- On subsequent visits, choose `Sign in with Linear`.
- Choose Settings from the desktop sidebar or mobile tab bar. Owners can open workspace administration and choose `Save repositories`.
- Choose `Sign out` in the workspace header.

## Driving it with Playwright and verify-local

Preconditions:

- Start a fresh `serve` fixture for the browser driver's dashboard argument, wait for readiness and pass Doctor.
- Then launch `bun --no-env-file scripts/verify-local.ts workspace-serve` in a second tracked task. Set `PAWS_WORKSPACE_EVIDENCE` to its printed directory.
- Run `python3 .agents/skills/verify-paws/scripts/doctor.py "$PAWS_WORKSPACE_EVIDENCE" > "$PAWS_WORKSPACE_EVIDENCE/doctor.json"`. Require exit 0. Keep both task handles.

- **Drive both identities.** Run `bun --no-env-file test/local/dashboard-browser.cjs "$PAWS_VERIFY_ORIGIN" "$PAWS_VERIFY_EVIDENCE" "$PAWS_WORKSPACE_EVIDENCE"`. Require exit 0. The driver reads the synthetic origin and setup code from `workspace-ui.json`.
- **Connect as owner.** The driver opens `Set up your first workspace`, fills `input[name=bootstrap]` and clicks `Connect workspace`. The `Sign out` button must appear.
- **Save repository access.** The driver chooses `#side a[href="#/settings"]`, opens `#workspace-members > summary`, fills `textarea[name="repositories"]` with `fixture/repo fixture-team`, and clicks `Save repositories`. Require `Repository access saved.`. Capture `owner-settings-desktop.png` and `owner-settings-mobile.png`.
- **Sign in as member.** The driver signs out, waits for `Sign in to Paws`, then chooses `Sign in with Linear` with the scripted member identity. It uses `#tabbar a[href="#/settings"]`. Require zero `#workspace-members` and `.workspace-identities` elements.
- **Confirm stored access.** After stopping the workspace fixture, inspect `workspace-ui-audit.json` and `workspace-ui.sqlite` alongside the saved UI feedback. For session persistence, access denials, revocation and identity mappings, run `bun --no-env-file scripts/verify-local.ts workspace` and inspect its observations and retained databases.
- **Retain proof.** Browser JSON and all screenshots are written to `PAWS_VERIFY_EVIDENCE`; workspace SQLite and access audit remain in `PAWS_WORKSPACE_EVIDENCE`. Check both directories after Cleanup.

## Gotchas

- The browser driver intercepts the OAuth redirect, preserves the state and cookies, and returns a synthetic owner or member code to the production callback. Requests outside the fixture origins are blocked.
- Bootstrap is single-use. Launch a fresh workspace fixture before repeating the complete browser recipe.
- The driver saves through the production API. Confirm the audit and database result before crediting persistence.
- Browser fixture HTTP is loopback. The `workspace` runtime probe separately drives certificate-verified HTTPS and persistent sessions.
- Stop both owned launchers and confirm both ports close.
