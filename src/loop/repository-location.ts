import { join, relative } from "node:path";
import { getWorkItem, getWorkItemRepository, listWorkItems, type Db } from "../db";
import { githubHttpsUrl } from "../github";
import { itemPathId } from "./sources";

/** Resolve reader paths from Paws's own layout and stored repository bindings. */
export async function repositoryAtPath(store: Db, home: string, path: string) {
  const name = relative(join(home, "worktrees"), path);
  if (name && !name.includes("/") && name !== "." && name !== "..") {
    const suffix = /-([0-9A-HJKMNP-TV-Z]{26})$/.exec(name)?.[1];
    const matches = suffix
      ? [await getWorkItem(store, suffix)].filter((item) => item !== null)
      : (await listWorkItems(store)).filter((item) => itemPathId(item) === name);
    const item = matches.length === 1 ? matches[0] : null;
    return item && itemPathId(item) === name ? getWorkItemRepository(store, item.id) : null;
  }
  const mirror = relative(join(home, "repos"), path);
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git$/.exec(mirror);
  if (!match) return null;
  const owner = match[1]!;
  const repo = match[2]!;
  return { owner, repo, remoteUrl: githubHttpsUrl(owner, repo) };
}
