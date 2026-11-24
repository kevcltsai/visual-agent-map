/** Escapes literal text for insertion in a RegExp pattern. */
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
