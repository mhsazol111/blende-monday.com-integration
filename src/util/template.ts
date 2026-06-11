/**
 * Tiny {{placeholder}} renderer used for email/Slack subject & body.
 * Supports dotted paths: {{item.name}}, {{group.title}}, {{status}},
 * {{column.text_abc123}}. Unknown placeholders render as empty string.
 */
export function renderTemplate(tpl: string, context: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, context);
    return value === undefined || value === null ? '' : String(value);
  });
}
