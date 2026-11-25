export function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
