export type GitCommitIdentity = {
  name: string;
  email: string;
};

export type AppBotIdentity = {
  appId: string;
  login: string;
  id: number;
};

export function appBotCommitIdentity(bot: AppBotIdentity): GitCommitIdentity {
  if (
    !/^[1-9][0-9]*$/.test(bot.appId) ||
    !/^[a-z0-9-]+\[bot\]$/.test(bot.login) ||
    !Number.isSafeInteger(bot.id) ||
    bot.id <= 0
  )
    throw new Error("Invalid GitHub App bot identity");
  return { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` };
}

export function commitIdentityEnv(identity: GitCommitIdentity): Record<string, string> {
  if (
    !identity.name.trim() ||
    !identity.email.trim() ||
    [...identity.name, ...identity.email].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || "<>".includes(character),
    )
  )
    throw new Error("Invalid Git commit identity");
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
