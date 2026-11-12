import { FIX_RECORD_REASONS, listFixRecords, type Db, type FixReason } from "../db";

export const FIX_RECORDS_PATH = "/api/fix-records";

export async function handleFixRecordsRequest(
  request: Request,
  options: { store: Db; sessionIds?: readonly string[] },
): Promise<Response> {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  const params = new URL(request.url).searchParams;
  const since = params.get("since");
  const reason = params.get("reason");
  const repository = params.get("repository");
  if (since !== null && !/^\d+$/.test(since))
    return Response.json({ error: "since is a time in milliseconds." }, { status: 400 });
  if (reason !== null && !FIX_RECORD_REASONS.includes(reason as FixReason))
    return Response.json(
      { error: `reason is one of ${FIX_RECORD_REASONS.join(", ")}.` },
      { status: 400 },
    );
  const records = await listFixRecords(options.store, {
    ...(since === null ? {} : { since: Number(since) }),
    ...(reason === null ? {} : { reason: reason as FixReason }),
    ...(repository === null ? {} : { repository }),
    ...(options.sessionIds === undefined ? {} : { sessionIds: options.sessionIds }),
  });
  return Response.json({ records }, { headers: { "cache-control": "no-store" } });
}
