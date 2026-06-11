import { env } from '../config/env.js';
import { log } from '../util/logger.js';

/**
 * Thin monday.com GraphQL client — the TS port of the PHP helper
 * `monday_template_cloner_graphql()`. Uses Node's global `fetch`.
 */

export class MondayApiError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MondayApiError';
  }
}

export interface GraphqlOptions {
  /** monday API version (e.g. "2024-10"). Optional; omit to use the default. */
  apiVersion?: string;
}

export async function mondayGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  options: GraphqlOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: env.mondayApiToken,
    'Content-Type': 'application/json',
  };
  if (options.apiVersion) headers['API-Version'] = options.apiVersion;

  let res: Response;
  try {
    res = await fetch(env.mondayApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new MondayApiError('Network error calling monday API', err);
  }

  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new MondayApiError(`monday API returned non-JSON (HTTP ${res.status})`, text);
  }

  if (!res.ok) {
    throw new MondayApiError(`monday API HTTP ${res.status}`, json ?? text);
  }
  if (json.errors) {
    throw new MondayApiError('monday GraphQL error', json.errors);
  }

  // monday includes complexity info under `extensions` / `account_id` etc.; log at debug.
  if (json.extensions?.complexity) {
    log.debug('monday complexity', json.extensions.complexity);
  }

  return json.data as T;
}
