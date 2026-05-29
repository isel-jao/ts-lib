export function ensureUniqueName(
  name: string,
  existingNames: Set<string> | string[],
): string {
  const set =
    existingNames instanceof Set ? existingNames : new Set(existingNames);
  if (!set.has(name)) {
    return name;
  }

  const match = name.match(/^(.*?)(\d+)$/);
  const baseName = match ? match[1] : name;
  let counter = match ? Number.parseInt(match[2], 10) + 1 : 1;

  let candidateName = baseName + counter;
  while (set.has(candidateName)) {
    counter++;
    candidateName = baseName + counter;
  }

  return candidateName;
}
