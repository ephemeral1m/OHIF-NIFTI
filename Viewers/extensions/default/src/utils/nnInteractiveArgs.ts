export type NnInteractiveOptions = { mode?: 'append' | 'replace-active' };

/** CommandsManager passes an options object (even for run('nninter') with no args).
 * Direct text-prompt callers historically pass a string/array and separate options.
 * Only explicit non-empty strings are text prompts; never use object truthiness.
 */
export function normalizeNnInteractiveArgs(input?: unknown, legacyOptions?: NnInteractiveOptions) {
  const commandOptions = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
  const rawPrompts = commandOptions ? commandOptions.textPrompts : input;
  const prompts = (Array.isArray(rawPrompts) ? rawPrompts : [rawPrompts])
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim())
    .filter(Boolean);
  const mode = legacyOptions?.mode ?? commandOptions?.mode;
  const options: NnInteractiveOptions = {
    ...(mode === 'append' || mode === 'replace-active' ? { mode } : {}),
  };
  return { textPrompts: prompts.length ? prompts : undefined, options };
}
