export type Route =
  | { view: "overview" }
  | { view: "epics"; id: string | null }
  | { view: "runs"; id: string | null }
  | { view: "questions"; id: string | null }
  | { view: "verdicts"; id: string | null }
  | { view: "queue" };

export function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#/, "")
    .split("/")
    .filter((part) => part.length > 0)
    .map(decodePart);
  const head = parts[0];
  const id = parts[1] ?? null;
  switch (head) {
    case undefined:
    case "overview":
      return { view: "overview" };
    case "epics":
      return { view: "epics", id };
    case "runs":
      return { view: "runs", id };
    case "questions":
      return { view: "questions", id };
    case "verdicts":
      return { view: "verdicts", id };
    case "queue":
      return { view: "queue" };
    default:
      return { view: "overview" };
  }
}

export function routeHref(route: Route): string {
  if (route.view === "overview") return "#/";
  if (route.view === "queue") return "#/queue";
  return route.id ? `#/${route.view}/${encodeURIComponent(route.id)}` : `#/${route.view}`;
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
