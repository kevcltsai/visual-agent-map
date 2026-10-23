Audit only the gap described by this Planner research_more decision. Classify the primary missing input as user_condition or external_evidence.

Use user_condition when the gap is a value, preference, constraint, or fact about this specific user's scenario that cannot be established by web sources (for example, this item's actual weight or the user's exact serving time). Do not replace such values with averages, defaults, or sibling-branch answers.

Use external_evidence only when the gap is an external factual or technical claim that a targeted source search could establish. A search task that asks the web to guess a user-specific condition is user_condition.

Classify the assigned search target, not every uncertainty mentioned in the Planner rationale. A supplied range is a known condition. Finding published guidance for that range is external_evidence; obtaining this user's exact value is user_condition. Do not silently replace one task with the other.

Put a concise rationale in detail and set summary to exactly user_condition or external_evidence as the decision. Return no suggestions or visual references. Do not use an HTML comment or replace the exact enum with prose.

Original user goal: {{goal}}
Current question: {{currentQuestion}}
Current answer: {{currentAnswer}}

Known conditions on this branch only: {{conditions}}

{{scope}}
