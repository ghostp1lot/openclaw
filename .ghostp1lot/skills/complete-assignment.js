/**
 * complete-assignment
 * OpenClaw skill: end-to-end assignment completion orchestration.
 *
 * This is the primary skill called by n8n's "Assignment Completer" workflow
 * via the OpenClaw HTTP API.
 *
 * ── Input (from n8n POST /api/task payload) ──────────────────────────────
 *   userId         {string}  Supabase UID of the student
 *   assignmentUrl  {string}  URL of the assignment/submission page
 *   assignmentType {string}  Type hint: "google_docs" | "canvas" | "classresources" | etc.
 *   instructions   {string}  Pre-generated content/answer from upstream n8n AI step
 *
 * ── Steps ────────────────────────────────────────────────────────────────
 *   1. Validate input and API secret (defence-in-depth)
 *   2. Get first idle Chromium instance from OpenClaw
 *   3. Fetch user credentials from Supabase (fetch-credentials skill)
 *   4. Navigate browser to assignmentUrl
 *   5. Inject credentials / autofill login (inject-credentials skill)
 *   6. Wait for post-login page load
 *   7. Take page snapshot for LLM context
 *   8. Run LLM agent with assignment-agent system prompt + page context
 *   9. Take verification snapshot to confirm submission
 *  10. Return structured result to n8n
 *
 * ── Output ───────────────────────────────────────────────────────────────
 *   { success, userId, assignmentUrl, assignmentType, instanceId,
 *     evidence, submissionConfirmed, verificationSnapshot, completedAt }
 */

import path   from 'path';
import fs     from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load the assignment agent system prompt from prompts/assignment-agent.md */
function loadSystemPrompt() {
  const promptPath = path.join(__dirname, '../prompts/assignment-agent.md');
  if (!fs.existsSync(promptPath)) {
    throw new Error('[complete-assignment] prompts/assignment-agent.md not found');
  }
  return fs.readFileSync(promptPath, 'utf8');
}

/**
 * Constant-time string comparison to prevent timing attacks on the API secret.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still run the hmac to avoid length-based timing leaks
    crypto.timingSafeEqual(Buffer.from(a), Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export default {
  name: 'complete-assignment',
  description:
    'End-to-end assignment completion: fetch credentials → navigate → autofill login → ' +
    'LLM agent completes and submits the assignment → return structured result.',

  /**
   * @param {object} input       - Payload from n8n (see header docs)
   * @param {object} context     - OpenClaw runtime context
   * @param {object} context.browser - OpenClaw browser API
   * @param {object} context.llm     - OpenClaw LLM agent API
   * @param {object} context.skills  - Skill runner (to call other skills)
   * @param {object} context.request - Raw HTTP request (for auth header check)
   */
  async execute(
    { userId, assignmentUrl, assignmentType, instructions },
    { browser, llm, skills, request }
  ) {
    // ── Step 1: Input validation + defence-in-depth API secret check ────
    const incomingSecret = (request?.headers?.authorization || '').replace(/^Bearer /i, '').trim();
    const expectedSecret  = process.env.OPENCLAW_API_SECRET || '';

    if (!safeEqual(incomingSecret, expectedSecret)) {
      throw new Error('[complete-assignment] Unauthorized — invalid or missing API secret.');
    }

    if (!userId)        throw new Error('[complete-assignment] userId is required.');
    if (!assignmentUrl) throw new Error('[complete-assignment] assignmentUrl is required.');
    if (!instructions)  throw new Error('[complete-assignment] instructions are required.');

    console.log('\n[complete-assignment] ========== START ==========');
    console.log(`[complete-assignment] User:   ${userId}`);
    console.log(`[complete-assignment] URL:    ${assignmentUrl}`);
    console.log(`[complete-assignment] Type:   ${assignmentType || 'unknown'}`);

    // ── Step 2: Get idle browser instance ───────────────────────────────
    console.log('[complete-assignment] Resolving idle browser instance...');
    const instance = await browser.getIdleInstance();
    if (!instance) {
      throw new Error(
        '[complete-assignment] No idle browser instance available — all 5 are busy.'
      );
    }
    console.log(
      `[complete-assignment] Using instance #${instance.id} (port ${instance.port})`
    );

    // ── Step 3: Fetch credentials ────────────────────────────────────────
    console.log('[complete-assignment] Fetching credentials from Supabase...');
    const credentials = await skills.run('fetch-credentials', { userId });
    if (!credentials) {
      console.log('[complete-assignment] No credentials in Supabase — assuming pre-authenticated session.');
    }

    // ── Step 4: Navigate to assignment URL ──────────────────────────────
    console.log(`[complete-assignment] Navigating to: ${assignmentUrl}`);
    await browser.navigate({ instanceId: instance.id, url: assignmentUrl });
    await new Promise(r => setTimeout(r, 3000)); // initial page load

    // ── Step 5: Inject credentials (autofill login) ──────────────────────
    if (credentials) {
      console.log('[complete-assignment] Running credential autofill...');
      const autofillResult = await skills.run('inject-credentials', {
        port:        instance.port,
        credentials,
      });
      console.log('[complete-assignment] Autofill:', JSON.stringify(autofillResult));

      if (autofillResult.autoSubmitted) {
        // Wait for login redirect / post-login page settlement
        console.log('[complete-assignment] Waiting for post-login page...');
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    // ── Step 6: Page settle ──────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 2000));

    // ── Step 7: Snapshot for LLM context ────────────────────────────────
    console.log('[complete-assignment] Snapshotting page for LLM context...');
    const pageSnapshot = await browser.snapshot({ instanceId: instance.id });

    // ── Step 8: Run LLM agent ────────────────────────────────────────────
    console.log('[complete-assignment] Running LLM agent...');
    const systemPrompt = loadSystemPrompt();

    const agentPrompt = [
      `## Assignment Details`,
      `- **Type:** ${assignmentType || 'unknown'}`,
      `- **URL:** ${assignmentUrl}`,
      ``,
      `## Pre-generated Content / Instructions`,
      instructions,
      ``,
      `## Current Page Snapshot`,
      pageSnapshot,
      ``,
      `Complete and submit the assignment using the browser tools available to you.`,
      `After submitting, take a final snapshot and confirm the submission succeeded.`,
      `Return a JSON result: { "success": boolean, "evidence": string, "submissionConfirmed": boolean }`,
    ].join('\n');

    const agentResult = await llm.runAgent({
      systemPrompt,
      userMessage: agentPrompt,
      tools:      ['browser.navigate', 'browser.snapshot', 'browser.screenshot',
                   'browser.evaluate', 'browser.focus'],
      instanceId: instance.id,
    });

    // ── Step 9: Verification snapshot ───────────────────────────────────
    console.log('[complete-assignment] Taking verification snapshot...');
    const verificationSnapshot = await browser.snapshot({ instanceId: instance.id });

    // ── Step 10: Return result ───────────────────────────────────────────
    const result = {
      success:              agentResult?.success              ?? false,
      userId,
      assignmentUrl,
      assignmentType:       assignmentType || 'unknown',
      instanceId:           instance.id,
      evidence:             agentResult?.evidence             || 'No evidence returned by agent',
      submissionConfirmed:  agentResult?.submissionConfirmed  ?? false,
      verificationSnapshot: (verificationSnapshot || '').substring(0, 500) + '…',
      completedAt:          new Date().toISOString(),
    };

    console.log('[complete-assignment] Result:', JSON.stringify(result, null, 2));
    console.log('[complete-assignment] ========== END ==========\n');

    return result;
  },
};
