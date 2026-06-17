import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { log } from '../util/logger.js';
import type { Rule } from './types.js';

/**
 * Loads rules from a JSON file (`RULES_PATH`, default ./config/rules.json).
 * Phase 1 of config storage; the schema is identical to the future DB rows so
 * migrating to a DB later is a swap of this loader only.
 */
export function loadRules(path = env.rulesPath): Rule[] {
  const abs = resolve(path);
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err: any) {
    // Boot-safe: a missing file (fresh deploy) or unreadable file should not
    // crash the service — start with no rules; build them in the configurator.
    if (err?.code === 'ENOENT') log.info(`No rules file at ${abs} yet — starting with 0 rules.`);
    else log.error(`Could not read/parse rules file at ${abs}; starting with 0 rules.`, err?.message ?? err);
    return [];
  }

  const rules: unknown = parsed?.rules;
  if (!Array.isArray(rules)) {
    log.error(`Rules file ${abs} has no top-level "rules" array; starting with 0 rules.`);
    return [];
  }

  const valid: Rule[] = [];
  for (const r of rules as Rule[]) {
    const problem = validateRule(r);
    if (problem) {
      log.warn(`Skipping invalid rule "${(r as any)?.id ?? '?'}": ${problem}`);
      continue;
    }
    valid.push(r);
  }

  log.info(`Loaded ${valid.length} rule(s) from ${abs}.`);
  return valid;
}

/**
 * Validate a full ruleset (the configurator calls this before saving).
 * Returns a list of human-readable problems; empty means valid.
 */
export function validateRuleset(rules: unknown): string[] {
  if (!Array.isArray(rules)) return ['"rules" must be an array.'];
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((r: any, i) => {
    const problem = validateRule(r);
    if (problem) problems.push(`rule #${i + 1} (${r?.id ?? '?'}): ${problem}`);
    else if (seen.has(r.id)) problems.push(`rule #${i + 1}: duplicate id "${r.id}"`);
    else seen.add(r.id);
  });
  return problems;
}

/** Persist a ruleset to the rules file (pretty-printed). */
export function saveRules(rules: Rule[], path = env.rulesPath): void {
  const abs = resolve(path);
  writeFileSync(abs, JSON.stringify({ rules }, null, 2) + '\n', 'utf8');
  log.info(`Saved ${rules.length} rule(s) to ${abs}.`);
}

/** Lightweight structural validation. Returns an error string or null. */
export function validateRule(r: Rule): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!r.id) return 'missing id';
  if (typeof r.boardId !== 'number') return 'missing/invalid boardId';
  if (!r.trigger?.type) return 'missing trigger.type';
  if (r.trigger.type === 'all_subitems_checked') {
    const names = (r.trigger as any).subitemNames;
    if (!Array.isArray(names) || names.length === 0) return 'all_subitems_checked needs subitemNames';
  }
  if (!r.scope || (!r.scope.groupId && !r.scope.groupTitleContains)) {
    return 'scope must set groupId or groupTitleContains';
  }
  if (!Array.isArray(r.actions) || r.actions.length === 0) return 'no actions';
  for (const a of r.actions) {
    const problem = validateAction(a);
    if (problem) return problem;
  }
  return null;
}

/** Per-action checks so the configurator never saves blank/unsendable actions. */
function validateAction(a: Rule['actions'][number]): string | null {
  if (a.type === 'slack') {
    if (!a.text?.trim()) return 'slack action has empty text';
  } else if (a.type === 'email') {
    if (!a.subject?.trim()) return 'email action has empty subject';
    if ((!a.to || a.to.length === 0) && !a.toFromColumn) return 'email action has no recipients';
  } else if (a.type === 'clone_template_subitems') {
    if (!a.templateSourceColumnId) return 'clone action missing templateSourceColumnId';
  } else if (a.type === 'set_column') {
    if (!a.columnId) return 'set_column action missing columnId';
    if (!a.value?.trim()) return 'set_column action has empty value';
    if (a.target === 'subitem' && !a.subitemName?.trim()) return 'set_column on a subitem needs subitemName';
  }
  return null;
}
