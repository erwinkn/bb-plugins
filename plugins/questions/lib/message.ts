// Builds the user message that carries submitted answers back to the thread.
// Pure: no SDK access, so it is unit-testable and shared with previews.
import {
  type Answer,
  type Attachment,
  type Question,
  type Round,
  findQuestion,
  questionLabels,
  referenceLabel,
} from "./model";

export interface SubmissionMessage {
  text: string;
  attachments: Attachment[];
}

function renderAnswer(question: Question, answer: Answer): string[] {
  const lines: string[] = [];
  if (answer.selected.length > 0) {
    for (const id of answer.selected) {
      const option = question.options.find((item) => item.id === id);
      const detail = (answer.details[id] ?? "").trim();
      lines.push(`- ${option ? option.label : id}${detail ? ` — ${detail}` : ""}`);
    }
  }
  const text = answer.text.trim();
  if (text !== "") {
    lines.push(answer.selected.length > 0 ? `In their own words: ${text}` : text);
  }
  if (answer.references.length > 0) {
    lines.push("References:");
    for (const reference of answer.references) {
      const label = referenceLabel(reference);
      lines.push(reference.kind === "url" ? `- ${label}` : `- \`${label}\``);
    }
  }
  if (answer.attachments.length > 0) {
    lines.push(
      `Attachments: ${answer.attachments.map((item) => item.name).join(", ")} (attached to this message)`,
    );
  }
  if (answer.confidence !== null) lines.push(`Confidence: ${answer.confidence}`);
  return lines;
}

/**
 * Renders one submission. Questions keep their thread-wide label (Q1, Q2, …)
 * so the agent can match answers to the round it asked.
 */
export function buildSubmissionMessage(
  rounds: Round[],
  snapshot: Record<string, Answer>,
  questionIds: string[],
  submissionId: string,
): SubmissionMessage {
  const labels = questionLabels(rounds);
  const attachments: Attachment[] = [];
  const sections: string[] = [];
  const answered: string[] = [];
  for (const questionId of questionIds) {
    const found = findQuestion(rounds, questionId);
    const answer = snapshot[questionId];
    if (!found || !answer) continue;
    const label = labels.get(questionId) ?? questionId;
    answered.push(label);
    const body = renderAnswer(found.question, answer);
    sections.push(
      [`**${label} (round ${found.round.number}) · ${found.question.title}**`, ...body].join("\n"),
    );
    attachments.push(...answer.attachments);
  }
  const header = `Answers to ${answered.join(", ")} from the Questions notebook (submission ${submissionId}).`;
  const footer =
    "Unanswered questions stay open in the notebook. Call questions_read for every submitted answer.";
  return {
    text: [header, "", sections.join("\n\n"), "", footer].join("\n"),
    attachments,
  };
}
