Correct the candidate decision before it can be saved. This is the single bounded corrective pass; do not search and do not conclude.

{{userQuestionRule}}

The current answer path has {{answeredQuestionCount}} answered question node(s), minimum for conclusion is {{minimumAnswers}}. The candidate either violates that floor, proposes more research although its reports already answer the goal, or repeats a known question. Return ask_user with one meaningful, decision-relevant question on a genuinely unknown dimension (constraints, goals, current skills, resources, or success criteria). No repeated known condition, no quota filler, exactly one question node (one dimension, up to 3 related parts) and 2–5 distinct answer choices.

Include the useful conditional answer as the response body, and return the decision in the aim fields. If no meaningful new dimension can be asked, still do not conclude: this correction must be rejected by the caller.

Original user goal: {{goal}}
Goal background: {{goalDetail}}

Known branch conditions (including free text): {{conditions}}
Current question: {{currentQuestion}}
Current answer: {{currentAnswer}}

Earlier user questions in this path: {{questionHistory}}
Earlier answers: {{earlierAnswers}}

Persisted research summary:
{{reportSummary}}

Persisted research reports:
{{reportDetail}}

Candidate to correct: {{candidate}}

Return decision ask_user: why this new dimension matters as aim.rationale, one meaningful new question as aim.question (written as a question), and 2–5 distinct choices in aim.answerOptions.
