import type { AskTeamInput, QuestionChannel, TeamAnswer } from "./channel";

export type FakeQuestionChannel = QuestionChannel & {
  asked: AskTeamInput[];
  answers: TeamAnswer[];
};

export function createFakeQuestionChannel(): FakeQuestionChannel {
  const asked: AskTeamInput[] = [];
  const answers: TeamAnswer[] = [];
  let next = 1;
  return {
    asked,
    answers,
    async ask(input) {
      asked.push(input);
      const questionId = `q-${next}`;
      next += 1;
      return { questionId };
    },
    async deliverAnswer(input) {
      answers.push(input);
    },
  };
}
