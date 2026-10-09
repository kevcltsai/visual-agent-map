const mindSearchGapAuditSchema = {
  type: "object",
  properties: {
    detail: { type: "string", minLength: 1, description: "A short rationale, written before the decision label." },
    summary: { type: "string", enum: ["user_condition", "external_evidence"], description: "The exact final classification, written after the rationale." },
    suggestions: { type: "array", maxItems: 0, items: { type: "string" } },
    visualReferences: { type: "array", maxItems: 0, items: { type: "string" } }
  },
  required: ["detail", "summary", "suggestions", "visualReferences"],
  additionalProperties: false
} as const;

export default mindSearchGapAuditSchema;
