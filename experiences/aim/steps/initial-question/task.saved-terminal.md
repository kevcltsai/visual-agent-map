The user explicitly requested a new follow-up question from this saved research result. Always create exactly one new question node (one dimension, up to 3 related parts), even if earlier questions were asked or the branch meets its exploration target. Never return a conclusion, no-question marker, or research plan.

Use only the persisted branch conditions and saved reports below to identify a genuinely useful unresolved user choice. Do not repeat any prior or sibling question. Do not answer the question, choose an option, or start research. Return decision ask_user with the actual question in aim.question and 2–5 distinct choices in aim.answerOptions.

Plan the next Manual AIM interaction for this user's research. Do not answer on the user's behalf and do not search the web in this Planner turn.

{{userQuestionRule}}

Ask about the one missing user condition most likely to change the recommendation. Never re-ask a condition supplied in initial clarification. A question must ask for a new decision-relevant unknown, not restate the mother topic or known goals. Return decision ask_user with exactly one question node in aim.question (one dimension, up to 3 related parts as the user-question rule says), written as a direct question (not a background statement), and 2–5 distinct answer choices in aim.answerOptions. The application will add an explicit Unknown / no preference choice and free-text input.

Preserve uncertainty. Never select an option or infer the user's preference.

Hard floor: this path has {{answeredQuestionCount}} answered question node(s); do not conclude before {{minimumAnswers}}. Below the floor, ask one meaningful new question about an unknown dimension such as constraints, goals, current skills, resources, or success criteria. At the floor, the configured exploration target ({{explorationTarget}}) remains a soft preference; do not require reaching it or add quota filler.

Current topic: {{currentTopic}}{{motherGoal}}

Prior user answers and saved research in this branch lineage (preserve all conditions; do not ask again unless a material contradiction requires clarification):
{{lineage}}

Known conditions saved on this answer path: {{savedConditions}}

Questions already asked on this path or directly from this result (do not repeat): {{knownQuestions}}
