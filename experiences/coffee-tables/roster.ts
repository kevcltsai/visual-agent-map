import type { GuestCategory, GuestSettings, NamedGuest } from "./types";

export const COFFEE_OBSERVER_COUNT = 1;
export const MAX_COFFEE_PARTICIPANTS = 12;
export const COFFEE_GUEST_CATEGORIES: readonly GuestCategory[] = ["experts", "cross-domain", "generalist", "affected"];

export type CoffeePersonaSource = "builtin" | "custom" | "library" | "recommended" | "legacy";

/** One fixed guest seat. The category is the fixed role tag; persona text is editable. */
export interface CoffeeRoleCard {
  id: string;
  category: GuestCategory;
  /** Persona identity/label shown as the simulated speaker. */
  roleName: string;
  /** Human-defined role held by this persona, distinct from category and identity. */
  personaRole?: string;
  source: CoffeePersonaSource;
  description: string;
  style: string;
  prompt: string;
  suggestions: string[];
  templateId?: string;
  /** Retained only when adapting pre-roster sessions. */
  legacyIdentity?: string;
  legacyRole?: string;
  locked: boolean;
  edited: boolean;
}

/** totalParticipants includes hosts; the system observer is always separate and excluded. */
export interface CoffeeRoster {
  totalParticipants: number;
  hostCount: number;
  cards: CoffeeRoleCard[];
}

export interface RosterValidationOptions {
  maxParticipants?: number;
  maxPerCategory?: number;
  allowLegacyParticipantTotal?: boolean;
}


const SOURCES: readonly CoffeePersonaSource[] = ["builtin", "custom", "library", "recommended", "legacy"];

export function parseCoffeeRoster(value: unknown): CoffeeRoster {
  if (!value || typeof value !== "object") throw new Error("Invalid Coffee Tables roster");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.cards)) throw new Error("Invalid Coffee Tables roster cards");
  const cards: CoffeeRoleCard[] = raw.cards.map(item => {
    if (!item || typeof item !== "object") throw new Error("Invalid Coffee Tables role card");
    const card = item as Record<string, unknown>;
    if (typeof card.id !== "string" || typeof card.category !== "string" || !COFFEE_GUEST_CATEGORIES.includes(card.category as GuestCategory) || typeof card.roleName !== "string" || (card.personaRole !== undefined && typeof card.personaRole !== "string") || !SOURCES.includes(card.source as CoffeePersonaSource) || typeof card.description !== "string" || typeof card.style !== "string" || typeof card.prompt !== "string" || !Array.isArray(card.suggestions) || !card.suggestions.every(value => typeof value === "string")) throw new Error("Invalid Coffee Tables role card");
    return { id: card.id, category: card.category as GuestCategory, roleName: card.roleName, ...(typeof card.personaRole === "string" ? { personaRole: card.personaRole } : {}), source: card.source as CoffeePersonaSource, description: card.description, style: card.style, prompt: card.prompt, suggestions: [...card.suggestions] as string[], ...(typeof card.templateId === "string" ? { templateId: card.templateId } : {}), ...(typeof card.legacyIdentity === "string" ? { legacyIdentity: card.legacyIdentity } : {}), ...(typeof card.legacyRole === "string" ? { legacyRole: card.legacyRole } : {}), locked: card.locked === true, edited: card.edited === true };
  });
  const roster: CoffeeRoster = { totalParticipants: Number(raw.totalParticipants), hostCount: Number(raw.hostCount), cards };
  if (validateRoster(roster).length) throw new Error("Invalid Coffee Tables roster");
  return roster;
}

export function guestSeatCount(totalParticipants: number, hostCount: number): number {
  if (!Number.isInteger(totalParticipants) || !Number.isInteger(hostCount)) return -1;
  return totalParticipants - hostCount;
}

export function categoryCounts(cards: readonly Pick<CoffeeRoleCard, "category">[]): Record<GuestCategory, number> {
  const counts: Record<GuestCategory, number> = { experts: 0, "cross-domain": 0, generalist: 0, affected: 0 };
  for (const card of cards) counts[card.category]++;
  return counts;
}

export function validateRoster(roster: CoffeeRoster, options: RosterValidationOptions = {}): string[] {
  const errors: string[] = [];
  const maxParticipants = options.maxParticipants ?? MAX_COFFEE_PARTICIPANTS;
  const maxPerCategory = options.maxPerCategory ?? 8;
  const targetSeats = guestSeatCount(roster.totalParticipants, roster.hostCount);
  const maxAllowed = options.allowLegacyParticipantTotal ? maxParticipants + 4 : maxParticipants;
  if (!Number.isInteger(roster.hostCount) || roster.hostCount < 1 || roster.hostCount > 4) errors.push("host-count");
  if (!Number.isInteger(roster.totalParticipants) || roster.totalParticipants < roster.hostCount + 1 || roster.totalParticipants > maxAllowed) errors.push("participant-total");
  if (targetSeats < 1 || roster.cards.length !== targetSeats) errors.push("seat-count");
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const card of roster.cards) {
    if (!COFFEE_GUEST_CATEGORIES.includes(card.category) || !card.id || ids.has(card.id)) errors.push("card-identity");
    ids.add(card.id);
    const labelKey = `${card.category}\u0000${normalizePersonaLabel(card.roleName)}`;
    if (labels.has(labelKey)) errors.push("duplicate-persona-label");
    labels.add(labelKey);
    if (!card.roleName.trim()) errors.push("role-name");
    if (typeof card.description !== "string" || typeof card.style !== "string" || typeof card.prompt !== "string" || !Array.isArray(card.suggestions) || card.suggestions.some(item => typeof item !== "string")) errors.push("card-content");
  }
  if (Object.values(categoryCounts(roster.cards)).some(count => count > maxPerCategory)) errors.push("category-limit");
  return [...new Set(errors)];
}

export function normalizePersonaLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Suggestions add to a persona description. They never replace user-authored text. */
export function appendStyleSuggestion(current: string, suggestion: string): string {
  const addition = suggestion.trim();
  if (!addition) return current;
  const lines = current.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(addition)) return current;
  return current.trim() ? `${current.trim()}\n${addition}` : addition;
}

/** Replace one unlocked card in place while preserving the seat's identity and fixed role tag. */
export function replaceRoleCard(roster: CoffeeRoster, cardId: string, replacement: CoffeeRoleCard): CoffeeRoster {
  const index = roster.cards.findIndex(card => card.id === cardId);
  if (index < 0 || roster.cards[index].locked || roster.cards[index].edited) return roster;
  const previous = roster.cards[index];
  const cards = [...roster.cards];
  cards[index] = { ...replacement, id: previous.id, category: previous.category, locked: previous.locked, edited: false };
  return { ...roster, cards };
}

/** Table regeneration only fills existing eligible seats; edited and locked cards survive. */
export function regenerateRoleCards(roster: CoffeeRoster, replacements: ReadonlyMap<string, CoffeeRoleCard>): CoffeeRoster {
  const cards = roster.cards.map(card => {
    if (card.locked || card.edited) return card;
    const replacement = replacements.get(card.id);
    return replacement ? { ...replacement, id: card.id, category: card.category, locked: false, edited: false } : card;
  });
  return { ...roster, cards };
}

const DEFAULT_ROLE_NAMES: Record<GuestCategory, string> = {
  experts: "Topic expert",
  "cross-domain": "Cross-domain perspective",
  generalist: "Curious generalist",
  affected: "Affected perspective",
};

/** Adapt a pre-roster session without changing its saved category counts or named-person data. */
export function rosterFromLegacySettings(settings: Pick<GuestSettings, "counts" | "guests" | "hostCount">): CoffeeRoster {
  const hostCount = settings.hostCount ?? 2;
  const cards: CoffeeRoleCard[] = [];
  for (const category of COFFEE_GUEST_CATEGORIES) {
    const named = settings.guests.filter(guest => guest.category === category);
    for (let index = 0; index < settings.counts[category]; index++) {
      const person: NamedGuest | undefined = named[index];
      cards.push({
        id: person?.id ?? `legacy-${category}-${index + 1}`,
        category,
        roleName: person?.identity?.trim() || person?.role?.trim() || (settings.counts[category] > 1 ? `${DEFAULT_ROLE_NAMES[category]} ${index + 1}` : DEFAULT_ROLE_NAMES[category]),
        ...(person?.role ? { personaRole: person.role } : {}),
        source: "legacy",
        description: person?.description ?? "",
        style: "",
        prompt: person?.prompt ?? "",
        suggestions: [],
        ...(person?.templateId ? { templateId: person.templateId } : {}),
        ...(person?.identity ? { legacyIdentity: person.identity } : {}),
        ...(person?.role ? { legacyRole: person.role } : {}),
        locked: false,
        edited: true,
      });
    }
  }
  return { totalParticipants: hostCount + cards.length, hostCount, cards };
}

/** Keep old consumers/storage fields as a derived compatibility view of the canonical roster. */
export function guestSettingsFromRoster(settings: GuestSettings, roster: CoffeeRoster): GuestSettings {
  const counts = categoryCounts(roster.cards);
  const guests: NamedGuest[] = roster.cards.map(card => ({
    id: card.id,
    category: card.category,
    identity: card.edited ? card.roleName : card.legacyIdentity ?? card.roleName,
    ...(card.edited ? (card.personaRole ? { role: card.personaRole } : {}) : (card.legacyRole ?? card.personaRole ? { role: card.legacyRole ?? card.personaRole } : {})),
    description: [card.description.trim(), card.style.trim()].filter(Boolean).join("\n") || card.roleName,
    ...(card.prompt.trim() ? { prompt: card.prompt.trim() } : {}),
    ...(card.templateId ? { templateId: card.templateId } : {}),
  }));
  return { ...settings, counts, guests, hostCount: roster.hostCount, roster };
}

export function effectiveRoster(settings: GuestSettings): CoffeeRoster {
  return settings.roster ?? rosterFromLegacySettings(settings);
}

/** Whether the current error needs a corrected opening, not draft continuation. */
export function isOpeningRosterFailure(message: string): boolean {
  return /開桌(?:角色|人物身份與設定不符|名單重複列出)|席位與設定不符|開桌回應未列出角色|發言者.{0,60}(?:不在|未列入).{0,12}(?:開桌|設定)(?:名單)?|Opening role|Opening roster lists|Opening persona identity|configured seat|opening response omitted|Speaker.{0,120}not in (?:the )?configured opening roster/i.test(message);
}
