/** Last path segment for display. Accepts both / and \ so Windows paths show a file name. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}
