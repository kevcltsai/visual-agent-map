Review the complete evidence for the original user goal. Return one decision with a brief evidence-based interim answer; do not write the final document yet. Use all known conditions and relevant evidence in this branch lineage. Keep the current question and answer as conditions that personalize the result; they are not the overall goal. Do not expose the internal research log as the answer. Return the decision in the aim fields.

{{plannerCoverageRule}}

Hard floor: {{answeredQuestionCount}} answered question node(s) on this branch path; do not conclude before {{minimumAnswers}}. At the floor, the configured exploration target ({{explorationTarget}}) is a soft depth preference; do not require reaching it or add quota filler. Below the floor, ask one meaningful new question about an unknown decision-relevant dimension. {{floorAskRule}} {{userQuestionRule}}

Do not repeat known conditions or prior questions. Ask only for a genuinely missing user condition, never to compensate for missing research. Use research_more for missing evidence. Prior questions: {{questionsAlreadyAsked}}.

Choose research_more only for one specific material evidence gap (material means closing it could change the recommendation, not just make it more precise); provide exactly one aim.researchTarget with title, search task, and expected uncertainty reduction, and set aim.gapKind: searchable when public web sources can close it; user_only when only the user or someone they must contact can supply it (their own offer, quote, device model, account, or company data), so VAM asks the user instead of searching; not_decisive when closing it would not change the recommendation, so VAM delivers the answer and lists the gap for the user to confirm. Choose ask_user for a missing decision-changing user condition or a genuinely conflicting pair of supplied values. Name the conflict and request one clarification as aim.question; never defer a material conflict into the final document. Include 2–5 choices in aim.answerOptions. Do not use ask_user to compensate for missing research. List in aim.unresolvedConditions every user condition that would change the recommendation and is still unknown, checking the intake clarification answers and every earlier answer; a condition the user said they do not know is resolved by stating an assumption, not listed. Choose conclude only when the original goal is adequately supported, aim.unresolvedConditions is empty, and the hard floor is met; cite source names or links from reports when available and state remaining uncertainty and limits. Do not search in this Planner turn.

Return the decision in the aim fields with an evidence-based aim.rationale; for conclude, aim.stopReason says why the evidence is sufficient.

Current question: {{currentQuestion}}
Current answer: {{currentAnswer}}

Research budget: review {{researchTurn}} of {{maxResearchTurns}}. One targeted follow-up search remains when this is review 1; if a material gap remains after review 2, return research_more; VAM then delivers a conditional answer that lists the gap for the user to confirm.
