/**
 * openclaw.config.js
 *
 * Core OpenClaw configuration for the ghostp1lot automation platform.
 * All sensitive values are read from environment variables — see .env.example.
 *
 * LLM PROVIDER SWITCHING:
 *   Change OPENCLAW_LLM_PROVIDER in .env to switch providers.
 *   Options: anthropic | openai | gemini | openrouter | local
 *   Restart OpenClaw after changing.
 *
 * USAGE:
 *   OPENCLAW_CONFIG=./config/openclaw.config.js pnpm start
 *   (or set in your PM2 ecosystem.config.js — see GitHub Issues for VM setup)
 */

import 'dotenv/config';

const provider = process.env.OPENCLAW_LLM_PROVIDER || 'gemini';

/**
 * Resolve the active LLM provider config.
 * Only the selected provider's key needs to be set in .env.
 */
function resolveLLM(provider) {
  switch (provider) {
    case 'anthropic':
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('[config] ANTHROPIC_API_KEY is required when OPENCLAW_LLM_PROVIDER=anthropic');
      }
      return {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20251001',
        apiKey: process.env.ANTHROPIC_API_KEY,
      };

    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('[config] OPENAI_API_KEY is required when OPENCLAW_LLM_PROVIDER=openai');
      }
      return {
        provider: 'openai',
        // gpt-4o-mini: ~20x cheaper than gpt-4o, strong tool-use + JSON output
        model: process.env.OPENCLAW_OPENAI_MODEL || 'gpt-4o-mini',
        apiKey: process.env.OPENAI_API_KEY,
      };

    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('[config] GEMINI_API_KEY is required when OPENCLAW_LLM_PROVIDER=gemini');
      }
      return {
        provider: 'gemini',
        // gemini-2.0-flash: $0.10/$0.40 per 1M tokens, 1M ctx, strong tool-use
        model: process.env.OPENCLAW_GEMINI_MODEL || 'gemini-2.0-flash',
        apiKey: process.env.GEMINI_API_KEY,
      };

    case 'openrouter':
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error('[config] OPENROUTER_API_KEY is required when OPENCLAW_LLM_PROVIDER=openrouter');
      }
      return {
        provider: 'openrouter',
        // Default: gemini-2.0-flash via OpenRouter. Override with OPENCLAW_OPENROUTER_MODEL.
        // Other cheap options: google/gemini-2.5-flash, openai/gpt-4o-mini, deepseek/deepseek-chat-v3-0324
        model: process.env.OPENCLAW_OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
        apiKey: process.env.OPENROUTER_API_KEY,
      };

    case 'local':
      if (!process.env.OLLAMA_BASE_URL) {
        throw new Error('[config] OLLAMA_BASE_URL is required when OPENCLAW_LLM_PROVIDER=local');
      }
      return {
        provider: 'ollama',
        model: process.env.OLLAMA_MODEL || 'llama3.2',
        baseUrl: process.env.OLLAMA_BASE_URL,
      };

    default:
      throw new Error(`[config] Unknown OPENCLAW_LLM_PROVIDER: "${provider}". Must be anthropic | openai | gemini | openrouter | local`);
  }
}

if (!process.env.OPENCLAW_API_SECRET) {
  throw new Error('[config] OPENCLAW_API_SECRET must be set in .env — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

export default {
  // ── LLM Provider ──────────────────────────────────────────
  llm: resolveLLM(provider),

  // ── Browser Instances ──────────────────────────────────────
  // 5 isolated Chromium profiles on sequential CDP ports.
  // Headful (windowed) — visible on the VM screen for monitoring.
  browser: {
    chromiumPath: process.env.CHROMIUM_PATH || 'chrome',
    headful: true,
    maxInstances: 5,
    profiles: [
      { id: 1, port: 9222, userDataDir: 'C:\\automation\\chromium-profile-1' },
      { id: 2, port: 9223, userDataDir: 'C:\\automation\\chromium-profile-2' },
      { id: 3, port: 9224, userDataDir: 'C:\\automation\\chromium-profile-3' },
      { id: 4, port: 9225, userDataDir: 'C:\\automation\\chromium-profile-4' },
      { id: 5, port: 9226, userDataDir: 'C:\\automation\\chromium-profile-5' },
    ],
    // Extra Chromium launch flags
    launchArgs: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-features=TranslateUI',
    ],
    // Auto-clear cookies on instance close (keep these domains logged in)
    autoClearOnClose: true,
    cookieWhitelist: [
      'classresources.net',
      'stealthwriter.ai',
      'google.com',
      'accounts.google.com',
    ],
  },

  // ── Telegram Adapter ──────────────────────────────────────
  telegram: {
    enabled: true,
    token: process.env.TELEGRAM_BOT_TOKEN,
    // Parse comma-separated user IDs from env
    authorizedUserIds: (process.env.TELEGRAM_AUTHORIZED_USER_IDS || '')
      .split(',')
      .map(id => parseInt(id.trim(), 10))
      .filter(id => !isNaN(id)),
    systemPromptFile: './prompts/instance-management.md',
  },

  // ── HTTP REST API ─────────────────────────────────────────
  // All requests must include:  Authorization: Bearer <OPENCLAW_API_SECRET>
  api: {
    enabled: true,
    port: parseInt(process.env.OPENCLAW_API_PORT || '3099', 10),
    auth: {
      type: 'bearer',
      secret: process.env.OPENCLAW_API_SECRET,
    },
    // Restrict to localhost if n8n access is via tunnel/reverse-proxy
    // host: '127.0.0.1',
  },

  // ── Skills ────────────────────────────────────────────────
  skills: [
    './skills/fetch-credentials.js',
    './skills/inject-credentials.js',
    './skills/complete-assignment.js',
  ],

  // ── Prompts ───────────────────────────────────────────────
  prompts: {
    assignmentAgent:    './prompts/assignment-agent.md',
    instanceManagement: './prompts/instance-management.md',
  },
};
