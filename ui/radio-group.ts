/**
 * A row of choices as one radio group: each choice is a button with role "radio" and `aria-checked`; Tab reaches the
 * checked one (the first when none is checked), the arrow keys move to and pick the next or previous choice, Enter and
 * Space pick the focused one.
 */
export function renderRadioGroup(
  parent: HTMLElement,
  label: string,
  choices: { value: string; label: string }[],
  current: string | undefined,
  pick: (value: string) => void,
  idPrefix = "vam-radio"
): HTMLElement[] {
  const labelEl = parent.createEl("p", { text: label, cls: "vam-style-card-label" });
  const id = `${idPrefix}-${label}`;
  labelEl.setAttr("id", id);
  const group = parent.createDiv({ cls: "vam-style-chips", attr: { role: "radiogroup", "aria-labelledby": id } });
  const stop = choices.findIndex(choice => choice.value === current);
  const buttons: HTMLElement[] = choices.map((choice, index) => {
    const checked = index === stop;
    const chip = group.createEl("button", {
      text: choice.label,
      cls: "vam-style-chip",
      attr: {
        type: "button",
        role: "radio",
        "aria-checked": String(checked),
        tabindex: checked || (stop < 0 && index === 0) ? "0" : "-1"
      }
    });
    chip.addEventListener("click", () => pick(choice.value));
    chip.addEventListener("keydown", (event: KeyboardEvent) => {
      const step =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (!step) return;
      event.preventDefault();
      const next = (index + step + choices.length) % choices.length;
      pick(choices[next].value);
    });
    return chip;
  });
  return buttons;
}
