# Workspace access

Configure a Linear OAuth app with these callback URLs for your Paws HTTPS origin:

- `/auth/linear/callback` for personal sign-in.
- `/auth/linear/install/callback` for the workspace app authorization.

Set `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` on the server. Set the GitHub App credentials described in [GitHub App](github-app.md) so workspace owners can connect repositories in Integrations.

Give Paws a valid TLS certificate and its matching private key. The key must be readable by the Paws process and have mode `0400` or `0600`.

```sh
PAWS_PUBLIC_DASHBOARD=1 \
PAWS_PUBLIC_URL=https://paws.example.com:8787 \
PAWS_HOST=0.0.0.0 \
PAWS_PORT=8787 \
PAWS_TLS_KEY_PATH=/etc/paws/tls.key \
PAWS_TLS_CERT_PATH=/etc/paws/tls.crt \
bun run paws --no-tunnel
```

Open the dashboard and select **Sign in with Linear**. A Linear workspace admin completes the personal sign-in and approves installing Paws into that same workspace. Paws rechecks their admin membership through the new app authorization, stores encrypted credentials, creates the owner's workspace, and starts the connected service automatically. The owner continues to **Integrations** to connect GitHub and map repositories to Linear teams.

If Linear revokes the app authorization, the dashboard offers **Reconnect Linear**. A workspace admin signs in and authorizes the same installation again. Paws preserves the workspace and its roles.

Subsequent members use **Sign in with Linear** to open the workspace. A connected instance verifies each user's current membership against its installed Linear workspace.

Owners can assign Paws roles and map repositories to verified Linear teams in the workspace controls. Linear guests receive observer access. Membership refresh updates team visibility and revokes sessions when a member loses access. Sign out ends the current browser session. Each visit extends the session; it expires after thirty days without use. The dashboard shows only the sign-in page until you sign in.
