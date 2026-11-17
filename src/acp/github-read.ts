/** The run prompt's line for the agent's read-only `gh`; the runner keeps it only once a token landed. */
export const GITHUB_READ_PROMPT =
  "`gh` is signed in with read-only access to this task's repositories. Use it to read pull requests, issues, Actions runs and logs. It can't write, and it can't read other repositories.";

/** The prompt without the `gh` line, for a turn whose read token did not arrive. */
export function withoutGitHubReadPrompt(prompt: string): string {
  return prompt.replace(`\n\n${GITHUB_READ_PROMPT}`, "").replace(GITHUB_READ_PROMPT, "");
}
