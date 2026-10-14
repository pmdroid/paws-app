import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://paws.boo",
  output: "static",
  devToolbar: { enabled: false },
  vite: {
    server: {
      allowedHosts: ["agentbox.taile07e4.ts.net"],
      fs: { allow: ["../deploy/linux"] },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4325,
  },
});
