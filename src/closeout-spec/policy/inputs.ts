import { PUBLIC_POLICY_PATH } from "./resolve";

export function changesPolicyInput(
  policy: { files: readonly { path: string }[]; items: readonly { kind: string }[] },
  paths: readonly string[],
): boolean {
  const read = new Set([PUBLIC_POLICY_PATH, ...policy.files.map((file) => file.path)]);
  const skillDirs = policy.items.flatMap((item) =>
    item.kind === "review" && "skill" in item && typeof item.skill === "string"
      ? [item.skill.slice(0, item.skill.lastIndexOf("/") + 1)]
      : [],
  );
  return paths.some(
    (path) => read.has(path) || skillDirs.some((dir) => dir.length > 1 && path.startsWith(dir)),
  );
}
