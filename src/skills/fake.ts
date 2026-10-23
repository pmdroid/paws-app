import type { SkillFiles } from "./bundle";
import type { ResolvedSkill, SkillRequest, SkillResolver } from "./resolve";

/**
 * Resolves without the network. Each source pins 1.0.0 first and a newer minor on every later
 * resolve, unless the request names an npm version. Calls are recorded in `calls`.
 */
export function fakeSkillResolver(
  files: (request: SkillRequest) => SkillFiles = () =>
    new Map([["SKILL.md", new TextEncoder().encode("---\nname: fake\n---\nA fake skill.\n")]]),
): SkillResolver & { calls: SkillRequest[] } {
  const calls: SkillRequest[] = [];
  const seen = new Map<string, number>();
  return {
    calls,
    async resolve(request): Promise<ResolvedSkill> {
      calls.push(request);
      const key = request.kind === "npm" ? request.package : request.url;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      const version =
        request.kind === "npm" && request.version
          ? request.version
          : request.kind === "npm"
            ? `1.${count}.0`
            : String(count + 1).repeat(40);
      const {
        version: _pinned,
        path,
        ...source
      } = request as SkillRequest & {
        version?: string;
        path?: string;
      };
      const [ref, ...folder] = path?.split("/") ?? [];
      return {
        source: ref
          ? ({
              ...(folder.length ? { subfolder: folder.join("/") } : {}),
              ...source,
              ref,
            } as ResolvedSkill["source"])
          : source,
        version,
        files: files(request),
        suggestedName: (folder.at(-1) || key)
          .split("/")
          .at(-1)!
          .replace(/\.git$/, ""),
      };
    },
  };
}
