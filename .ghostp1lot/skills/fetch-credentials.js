/**
 * fetch-credentials
 * OpenClaw skill: fetch a ghostp1lot user's stored credentials from Supabase.
 *
 * Uses the Supabase SERVICE ROLE key — this skill runs server-side on the VM only.
 * The service role key bypasses RLS and must never be exposed to clients.
 *
 * This is a port of supabase-client.mjs from ghostp1lot/controller (archived),
 * adapted as an OpenClaw skill. The credential schema in Supabase is unchanged.
 *
 * Input:  { userId: string }  — Supabase UID (from auth.users)
 * Output: credential map object, or null if no credentials are found
 *
 * Credential map schema (from "Stored Credentials".credentials column):
 * {
 *   "https://example.com/login": {
 *     fields: [
 *       { type: "email",    value: "user@example.com", selectors: ["#email"] },
 *       { type: "password", value: "secret",           selectors: ["#password"] }
 *     ],
 *     triggers: {
 *       autoSubmit: true,
 *       waitBeforeSubmit: 1000,
 *       submitSelectors: ["button[type='submit']"]
 *     },
 *     metadata: { name: "Example Login" }
 *   }
 * }
 */

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default {
  name: 'fetch-credentials',
  description: "Fetch a ghostp1lot user's stored login credentials from Supabase by their UID.",

  async execute({ userId }) {
    if (!userId) {
      throw new Error('[fetch-credentials] userId is required');
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error(
        '[fetch-credentials] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env'
      );
    }

    console.log(`[fetch-credentials] Fetching credentials for user: ${userId}`);

    // Supabase REST API — query "Stored Credentials" table by UID
    // Table name has a space so we encode it. Column name is "UID" (uppercase).
    const url =
      `${SUPABASE_URL}/rest/v1/Stored%20Credentials` +
      `?select=credentials` +
      `&UID=eq.${encodeURIComponent(userId)}` +
      `&limit=1`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `[fetch-credentials] Supabase request failed (HTTP ${response.status}): ${errorBody}`
      );
    }

    const rows = await response.json();

    if (!rows || rows.length === 0 || !rows[0]?.credentials) {
      console.log(`[fetch-credentials] No credentials found for user ${userId}`);
      return null;
    }

    const credentials  = rows[0].credentials;
    const urlPatterns  = Object.keys(credentials);

    console.log(
      `[fetch-credentials] Found credentials for ${urlPatterns.length} URL pattern(s): ` +
      urlPatterns.join(', ')
    );

    return credentials;
  },
};
