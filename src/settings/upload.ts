import { SkillError, skillPath, type SkillFiles } from "../skills";

export type SkillUpload = {
  folder: string;
  files: SkillFiles;
  name?: string;
  agents?: string[];
};

export async function readSkillUpload(request: Request, limit: number): Promise<SkillUpload> {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0)
    throw new SkillError("Upload the folder with a Content-Length.", 411);
  if (length > limit + 4 * 1024 * 1024)
    throw new SkillError(`This skill is over the ${megabytes(limit)} MB bundle limit.`, 413);
  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await request.formData();
  } catch {
    throw new SkillError("The uploaded folder could not be read.");
  }
  const folder = form.get("folder");
  if (typeof folder !== "string" || skillPath(folder) === null || folder.includes("/"))
    throw new SkillError("Name the uploaded folder.");
  const paths = form.getAll("path");
  const uploads = form.getAll("file");
  if (uploads.length === 0 || paths.length !== uploads.length)
    throw new SkillError("Choose a folder to upload.");
  const files: SkillFiles = new Map();
  for (const [index, upload] of uploads.entries()) {
    const path = paths[index];
    const safe = typeof path === "string" ? skillPath(path) : null;
    if (safe === null || typeof upload === "string")
      throw new SkillError("The uploaded folder has a file outside it.");
    files.set(safe, new Uint8Array(await upload.arrayBuffer()));
  }
  const name = form.get("name");
  const agents = form.getAll("agents").filter((value) => typeof value === "string");
  return {
    folder,
    files,
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    ...(agents.length ? { agents } : {}),
  };
}

function megabytes(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}
