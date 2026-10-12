# Workspace access

Connect the Paws Linear app with `bun run paws setup --linear-mode agent-session`. In the same OAuth application's settings, register the dashboard's HTTPS origin followed by `/auth/linear/callback` as an additional redirect URI. For example, `https://paws.example.com:8787/auth/linear/callback`. [Linear's OAuth documentation](https://linear.app/developers/oauth-2-0-authentication) describes redirect registration and PKCE.

Give Paws a valid TLS certificate and its matching private key. The private key must be readable by the Paws process and have mode `0400` or `0600`.

```sh
PAWS_PUBLIC_DASHBOARD=1 \
PAWS_PUBLIC_URL=https://paws.example.com:8787 \
PAWS_HOST=0.0.0.0 \
PAWS_PORT=8787 \
PAWS_TLS_KEY_PATH=/etc/paws/tls.key \
PAWS_TLS_CERT_PATH=/etc/paws/tls.crt \
bun run paws --no-tunnel
```

Use the same Paws home and Linear installation when issuing the initial workspace setup code:

```sh
bun run paws workspace bootstrap
```

The command verifies the installed Linear organization and prints a single-use code that expires after ten minutes. Open the dashboard, expand **Set up your first workspace**, enter the code and sign in with Linear. The verified account becomes the workspace owner. Later members sign in with their own Linear accounts.

Owners can assign Paws roles and map repositories to verified Linear teams in the workspace controls. Linear guests receive observer access. Membership refresh updates team visibility and revokes sessions when a member loses access. Sign out ends the current browser session. Sessions expire after twelve idle hours or seven days from sign-in.
