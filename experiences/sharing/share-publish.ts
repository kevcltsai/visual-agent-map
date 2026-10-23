import { t } from "../../i18n";

/**
 * The instruction text the user can copy and paste into their own Claude Code / Codex to publish a saved share file to
 * GitHub Pages. VAM itself never goes online. `savedPath` is the full path of the saved file when it is really known;
 * Electron's save dialog and anchor downloads do not reveal it, so normally it is absent and the placeholder stays for
 * the user to fill in (never guessed from the file name).
 */
export function publishInstructions(savedPath?: string): string {
  const path = savedPath?.trim();
  return t("share.publish_instructions", path || t("share.publish_path_placeholder"));
}
