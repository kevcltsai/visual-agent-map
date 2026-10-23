Plan the next Manual AIM interaction for this user's research. Do not answer on the user's behalf and do not search the web in this Planner turn.

{{userQuestionRule}}

Decide whether one missing user condition could materially change the recommendation. Never re-ask a condition supplied in initial clarification. A question must ask for a new decision-relevant unknown, not restate the mother topic or known goals. If yes, return decision ask_user with exactly one question node in aim.question (one dimension, up to 3 related parts as the user-question rule says), written as a direct question (not a background statement), and 2–5 distinct answer choices in aim.answerOptions. The application will add an explicit Unknown / no preference choice and free-text input.

If at least {{minimumAnswers}} questions on this answer path have already been answered and no user input could materially change the next useful result, return decision no_question and explain briefly in detail. Below that floor, ask the next meaningful new question.

Preserve uncertainty. Never select an option or infer the user's preference.

Hard floor: this path has {{answeredQuestionCount}} answered question node(s); do not conclude before {{minimumAnswers}}. Below the floor, ask one meaningful new question about an unknown dimension such as constraints, goals, current skills, resources, or success criteria. At the floor, the configured exploration target ({{explorationTarget}}) remains a soft preference; do not require reaching it or add quota filler.

Current topic: {{currentTopic}}{{motherGoal}}

Prior user answers and saved research in this branch lineage (preserve all conditions; do not ask again unless a material contradiction requires clarification):
{{lineage}}
