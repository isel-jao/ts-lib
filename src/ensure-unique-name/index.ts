export function ensureUniqueName(
  name: string,
  existingNames: Set<string> | string[],
): string {
  const set =
    existingNames instanceof Set ? existingNames : new Set(existingNames);
  if (!set.has(name)) {
    return name;
  }

  const [, base, digits] = name.match(/^(.*?)(\d+)$/) ?? [];
  const baseName = base ?? name;
  let counter = digits ? Number.parseInt(digits, 10) + 1 : 1;

  let candidateName = baseName + counter;
  while (set.has(candidateName)) {
    counter++;
    candidateName = baseName + counter;
  }

  return candidateName;
}
