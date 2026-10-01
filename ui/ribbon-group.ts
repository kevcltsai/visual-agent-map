/** Keep our native ribbon buttons together without wrapping Obsidian's drag targets. */
export function groupRibbonIcons(map: HTMLElement, coffee: HTMLElement): () => void {
  const parent = map.parentElement;
  if (!parent || coffee.parentElement !== parent) return () => {};
  const classes = ["vam-ribbon-group", "vam-ribbon-group-start", "vam-ribbon-group-end"];
  parent.classList.add("vam-ribbon-container");
  const update = (): void => {
    observer.disconnect();
    for (const icon of [map, coffee]) icon.classList.remove(...classes);
    const present = [map, coffee].filter(icon => icon.parentElement === parent);
    // Pin only our buttons to the end; preserve all other buttons' relative order.
    for (const icon of present) {
      if (icon !== parent.lastElementChild) parent.appendChild(icon);
    }
    for (const icon of present) icon.classList.add("vam-ribbon-group");
    present[0]?.classList.add("vam-ribbon-group-start");
    present.at(-1)?.classList.add("vam-ribbon-group-end");
    observer.observe(parent, { childList: true });
  };
  const observer = new window.MutationObserver(() => update());
  update();
  return () => {
    observer.disconnect();
    parent.classList.remove("vam-ribbon-container");
    for (const icon of [map, coffee]) icon.classList.remove(...classes);
  };
}
