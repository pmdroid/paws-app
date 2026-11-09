import {
  buildClientSchema,
  getIntrospectionQuery,
  parse,
  print,
  printSchema,
  visit,
} from "graphql";
import { gzipSync } from "bun";
import { join } from "node:path";

const token = process.env.LINEAR_API_KEY;
if (!token) {
  console.error("Set LINEAR_API_KEY to a Linear API key to refresh the schema");
  process.exit(1);
}
const response = await fetch("https://api.linear.app/graphql", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: token },
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }),
});
const body = (await response.json()) as { data?: Parameters<typeof buildClientSchema>[0] };
if (!response.ok || !body.data) {
  console.error(`Linear introspection failed with status ${response.status}`);
  process.exit(1);
}
const sdl = print(
  visit(parse(printSchema(buildClientSchema(body.data))), {
    enter: (node) =>
      "description" in node && node.description ? { ...node, description: undefined } : undefined,
  }),
);
const target = join(import.meta.dir, "graphql-schemas", "linear.graphql.gz");
await Bun.write(target, gzipSync(new TextEncoder().encode(`${sdl}\n`)));
console.log(`Wrote ${target}`);
