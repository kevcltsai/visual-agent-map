import { COFFEE_GUEST_CATEGORIES, type CoffeeRoleCard, type CoffeeRoster } from "./roster";

export interface RecommendedRole {
  category: CoffeeRoleCard["category"];
  roleName: string;
  personaRole: string;
  description: string;
  style: string;
  prompt: string;
  suggestions: string[];
}

const limits = { roleName: 80, description: 500, style: 500, prompt: 3000, suggestions: 8 };

export function roleRecommendationPrompt(topic: string, roster: CoffeeRoster, language: "en" | "zh-TW", replaceIds?: readonly string[]): string {
  const eligible = roster.cards.filter(card => !card.locked && (replaceIds ? replaceIds.includes(card.id) : !card.edited));
  const categories = eligible.map(card => card.category);
  return [
    "Create role cards for an AI-simulated discussion. This is a thinking exercise, not testimony or verified advice. Every persona must be fictional. Do not imitate, name, or claim participation by a real person.",
    `Topic: ${topic}`,
    `Language: ${language === "zh-TW" ? "Traditional Chinese" : "English"}`,
    `Return exactly ${eligible.length} role cards, in this exact category order: ${categories.join(", ")}. Never add or remove seats. Categories available: ${COFFEE_GUEST_CATEGORIES.join(", ")}.`,
    "Return only JSON: {\"cards\":[{\"category\":\"experts|cross-domain|generalist|affected\",\"roleName\":string,\"personaRole\":string,\"description\":string,\"style\":string,\"prompt\":string,\"suggestions\":string[]}]}",
    "Make perspectives distinct, relevant, and diverse. roleName is a concise fictional persona identity/label; personaRole is that person's role, distinct from the fixed category; description gives fictional background, style gives speaking character, prompt gives optional perspective instructions, suggestions are short editable style additions. Keep every field concise.",
  ].join("\n\n");
}

function asString(value: unknown, max: number, field: string): string {
  const hasControlCharacter = typeof value === "string" && [...value].some(character => { const code = character.charCodeAt(0); return code <= 0x08 || code === 0x0b || code === 0x0c || code >= 0x0e && code <= 0x1f; });
  if (typeof value !== "string" || value.length > max || hasControlCharacter) throw new Error(`Invalid recommendation ${field}`);
  return value.trim();
}

export function parseRoleRecommendations(raw: string, roster: CoffeeRoster, replaceIds?: readonly string[]): Map<string, CoffeeRoleCard> {
  const eligible = roster.cards.filter(card => !card.locked && (replaceIds ? replaceIds.includes(card.id) : !card.edited));
  let parsed: unknown;
  try {
    const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(clean);
  } catch { throw new Error("Recommendation response was not valid JSON; your current role cards are unchanged."); }
  const cards = parsed && typeof parsed === "object" ? (parsed as { cards?: unknown }).cards : undefined;
  if (!Array.isArray(cards) || cards.length !== eligible.length) throw new Error(`Recommendation must return exactly ${eligible.length} role cards; your current role cards are unchanged.`);
  const result = new Map<string, CoffeeRoleCard>();
  cards.forEach((item, index) => {
    if (!item || typeof item !== "object") throw new Error("Invalid recommendation card; your current role cards are unchanged.");
    const row = item as Record<string, unknown>, seat = eligible[index];
    if (row.category !== seat.category) throw new Error("Recommendation changed a fixed role category; your current role cards are unchanged.");
    if (!Array.isArray(row.suggestions) || row.suggestions.length > limits.suggestions) throw new Error("Invalid recommendation suggestions; your current role cards are unchanged.");
    const roleName = asString(row.roleName, limits.roleName, "role name");
    if (!roleName) throw new Error("Recommendation role labels cannot be empty; your current role cards are unchanged.");
    result.set(seat.id, {
      id: seat.id,
      category: seat.category,
      source: "recommended",
      roleName,
      personaRole: asString(row.personaRole ?? "", limits.roleName, "persona role"),
      description: asString(row.description, limits.description, "description"),
      style: asString(row.style, limits.style, "style"),
      prompt: asString(row.prompt, limits.prompt, "prompt"),
      suggestions: row.suggestions.map(item => asString(item, 120, "suggestion")).filter(Boolean),
      locked: false,
      edited: false,
    });
  });
  return result;
}
