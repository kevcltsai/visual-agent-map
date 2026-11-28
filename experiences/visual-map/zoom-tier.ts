/** The three zoom tiers of the map view: a view-only state that never touches a card's bounds or the map file. */
export type ZoomTier = "overview" | "normal" | "detail";

// Entering a tier takes the first pair; leaving it takes the second, 5 points further in, so a wheel resting on a line does not flicker.
const OVERVIEW_IN = 0.6;
const OVERVIEW_OUT = 0.65;
const DETAIL_IN = 1.25;
const DETAIL_OUT = 1.2;
const DETAIL_UP = 1.3;
const OVERVIEW_DOWN = 0.55;

/** The tier a zoom (1 = 100%) belongs to, given the tier the view was in. */
export function nextZoomTier(prev: ZoomTier, zoom: number): ZoomTier {
  if (prev === "overview") {
    if (zoom < OVERVIEW_OUT) return "overview";
    return zoom >= DETAIL_UP ? "detail" : "normal";
  }
  if (prev === "detail") {
    if (zoom >= DETAIL_OUT) return "detail";
    return zoom < OVERVIEW_DOWN ? "overview" : "normal";
  }
  if (zoom < OVERVIEW_IN) return "overview";
  return zoom > DETAIL_IN ? "detail" : "normal";
}
