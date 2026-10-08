import type { CoffeeQuestion, GuestCounts, GuestCategory, CoffeeGuestInvitation } from "./types";

const CATEGORIES: GuestCategory[] = ["experts", "cross-domain", "generalist", "affected"];
const clean = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ");
const key = (value: string): string => clean(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const countGuests = (counts: GuestCounts): number => CATEGORIES.reduce((total, category) => total + counts[category], 0);

export function validateGuestInvitations(
  candidates: CoffeeGuestInvitation[],
  baseCounts: GuestCounts,
  questions: CoffeeQuestion[],
  retryQuestionId?: string,
  existingNames: string[] = [],
  language: "zh-TW" | "en" = "zh-TW",
  hostCount = 0,
  canonicalRosterIds: string[] = [],
): string | null {
  const message = (zh: string, en: string): string => language === "zh-TW" ? zh : en;
  const baseTotal = countGuests(baseCounts);
  if (baseTotal < 1 || baseTotal + hostCount > 12) return message("這桌原有人數設定無效（總數含主持人）。", "The existing participant count is invalid; the total includes hosts.");
  const canonicalIds = new Set(canonicalRosterIds);
  const active = questions.filter(question => question.status === "complete" && question.id !== retryQuestionId).flatMap(question => question.invitedGuests ?? []).filter(guest => !canonicalIds.has(guest.id));
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
    if (!CATEGORIES.includes(guest.category)) return message("請選擇有效的來賓類別。", "Choose a valid guest perspective.");
    const name = clean(guest.name), description = clean(guest.description);
    if (!name || !description) return message("請填寫每位新來賓的姓名與背景／視角。", "Enter a name and background or perspective for each guest.");
    if (name.length > 60 || description.length > 160) return message("來賓姓名最多 60 字，背景／視角最多 160 字。", "Names are limited to 60 characters and backgrounds to 160.");
    const normalizedName = key(name);
    if (candidateIds.has(guest.id) || candidateNames.has(normalizedName) || activeNames.has(normalizedName)) return message(`「${name}」已在這桌，請勿重複邀請。`, `“${name}” is already at this table. Do not invite them again.`);
    candidateIds.add(guest.id);
    candidateNames.add(normalizedName);
    candidateCounts[guest.category]++;
  }
  if (baseTotal + hostCount + activeIds.size + candidateIds.size > 12) return message("總人數含主持人最多 12 位；請減少邀請人數。", "The total, including hosts, is capped at 12. Remove some invitations.");
  const overLimit = CATEGORIES.find(category => candidateCounts[category] > 8);
  if (overLimit) return message("每類最多 8 位來賓；請調整邀請類別。", "Each guest perspective is limited to 8 people. Change the category.");
  return null;
}
