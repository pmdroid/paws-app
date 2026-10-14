# Paws landing page

The Astro marketing site for [paws.boo](https://paws.boo).

From this directory:

```sh
bun install
bun run dev
bun run check
bun run build
bun run preview
```

Development listens on `127.0.0.1:4325`. `bun run build` produces the static site in `dist/`. The Get started links open the [Paws setup guide](https://github.com/pmdroid/paws-app#setup).

`/install.sh` serves the remote runner installer from `deploy/linux/install-runner.sh`. Point the `get.paws.boo` hostname at this site. Requests for `/` on that hostname return the installer:

```sh
curl -fsSL https://get.paws.boo | sudo sh
```

## Assets

Bricolage Grotesque and DM Mono are self-hosted Google Fonts under the SIL Open Font License. Their licenses are in `public/fonts/`. The sleeping puppy is generated artwork, with its generation prompt embedded in the PNG metadata.
