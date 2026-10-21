import { translate, type NoteLanguage } from "../../i18n";
import type { CoffeeQuestion, GuestCounts, GuestCategory, CoffeeGuestInvitation } from "./types";

const CATEGORIES: GuestCategory[] = ["experts", "cross-domain", "generalist", "affected"];
const clean = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ");
const key = (value: string): string =>
  clean(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
const countGuests = (counts: GuestCounts): number =>
  CATEGORIES.reduce((total, category) => total + counts[category], 0);

export function validateGuestInvitations(
  candidates: CoffeeGuestInvitation[],
  baseCounts: GuestCounts,
  questions: CoffeeQuestion[],
  retryQuestionId?: string,
  existingNames: string[] = [],
  language: NoteLanguage = "zh-TW"
): string | null {
  const baseTotal = countGuests(baseCounts);
  if (baseTotal < 1 || baseTotal > 12) return translate(language, "coffee.the_existing_guest_count_is_invalid");
  const active = questions
    .filter(question => question.status === "complete" && question.id !== retryQuestionId)
    .flatMap(question => question.invitedGuests ?? []);
  const activeIds = new Set<string>();
  const activeNames = new Set(existingNames.map(key).filter(Boolean));
  const activeCounts: Record<GuestCategory, number> = { ...baseCounts };
  for (const guest of active) {
    if (activeIds.has(guest.id)) continue;
    activeIds.add(guest.id);
    activeNames.add(key(guest.name));
    activeCounts[guest.category]++;
  }
  const candidateIds = new Set<string>();
  const candidateNames = new Set<string>();
  const candidateCounts: Record<GuestCategory, number> = { ...activeCounts };
  for (const guest of candidates) {
    if (!CATEGORIES.includes(guest.category)) return translate(language, "coffee.choose_a_valid_guest_perspective");
    const name = clean(guest.name),
      description = clean(guest.description);
    if (!name || !description) return translate(language, "coffee.enter_a_name_and_background_or_perspective_for_each");
    if (name.length > 60 || description.length > 160)
      return translate(language, "coffee.names_are_limited_to_60_characters_and_backgrounds_to");
    const normalizedName = key(name);
    if (candidateIds.has(guest.id) || candidateNames.has(normalizedName) || activeNames.has(normalizedName))
      return translate(language, "coffee.is_already_at_this_table_do_not_invite_them_again", name);
    candidateIds.add(guest.id);
    candidateNames.add(normalizedName);
    candidateCounts[guest.category]++;
  }
  if (baseTotal + activeIds.size + candidateIds.size > 12)
    return translate(language, "coffee.a_table_can_have_at_most_12_guests_remove_some");
  const overLimit = CATEGORIES.find(category => candidateCounts[category] > 8);
  if (overLimit) return translate(language, "coffee.each_guest_perspective_is_limited_to_8_people_change");
  return null;
}
