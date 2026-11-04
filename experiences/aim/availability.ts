// The one switch that hides AIM from this release. AIM code, prompts and tests stay in the repository; every entry point and
// every AIM-only behavior asks aimEnabled(). To bring AIM back, change AIM_ENABLED to true (see Later L1 in the hide-aim plan).
export const AIM_ENABLED = false;

// Test builds (tests/build.cjs) define __VAM_AIM__ to run the AIM suites with AIM on, or the aim-hidden suite with AIM off.
// The production build defines nothing, so it ships with AIM_ENABLED.
declare const __VAM_AIM__: boolean | undefined;

export function aimEnabled(): boolean {
  return typeof __VAM_AIM__ === "boolean" ? __VAM_AIM__ : AIM_ENABLED;
}
