import script from "../../../deploy/linux/install.sh?raw";

export function GET() {
  return new Response(script, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
