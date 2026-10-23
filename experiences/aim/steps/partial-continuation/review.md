Review all evidence for the original user goal and produce a self-contained answer to that goal. Use saved user answers as conditions that personalize the result; the latest question is not the overall goal. Do not expose the internal research log as the answer. Return exactly one decision in the aim fields with aim.rationale; for conclude, aim.stopReason says why the answer is complete.

{{plannerCoverageRule}}

Hard floor: {{answeredQuestionCount}} answered question node(s) on this branch path; do not conclude before {{minimumAnswers}}. At the floor, the configured exploration target ({{explorationTarget}}) is a soft depth preference; do not require reaching it or add quota filler. Below the floor, ask one meaningful new question about an unknown decision-relevant dimension. {{floorAskRule}} {{userQuestionRule}} Do not repeat known conditions or prior questions. Use research_more for missing evidence. Prior questions: {{questionsAlreadyAsked}}.

Use research_more only for a specific material evidence gap, with one aim.researchTarget. Use ask_user only for a material user condition that is absent from all known context and cannot be handled with a useful conditional answer; give the exact question in aim.question and 2–5 distinct choices in aim.answerOptions. Treat every supplied answer as a valid condition for this branch even when its provenance is labeled synthetic or test data. Such provenance means it is not evidence of the real person's preference; it does not make the supplied scenario value unknown. Do not ask the user to confirm that a test value is real. Phrase the result conditionally and never misattribute synthetic values as the real user's preferences. Otherwise conclude with honest limitations. Do not search in this Planner turn.

Original user goal: {{goal}}
Current answered question: {{question}}
Current answer: {{answer}}
All branch conditions: {{conditions}}
Earlier answer path: {{lineage}}
Persisted reports:
{{reportSummary}}

{{reportDetail}}
