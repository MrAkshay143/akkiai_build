/**
 * tools-config-manager.js
 * Manages tools_config.json in userData directory.
 * Provides read, write, and model discovery with local caching.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

const CONFIG_FILE = 'tools_config.json';
const GEMINI_MODELS_CACHE = 'cached_gemini_models.json';
const OPENROUTER_MODELS_CACHE = 'cached_openrouter_models.json';

const DEFAULT_CONFIG = {
  version: 1,
  enableGlobalFallback: true,
  defaultGlobalFallbackModel: 'gemini-3.5-flash-lite',
  tools: {
    web_search: { model: 'gemini-3.5-flash-lite',
      customModel: '',
      usePrimaryApiKey: true,
      customApiKey: '',
      enableFallback: true,
      fallbackModel: 'gemini-3.5-flash-lite',
      isRetired: false
    },
    whatsapp_transcribe: {
      model: 'gemini-3.8-flash',
      customModel: '',
      usePrimaryApiKey: true,
      customApiKey: '',
      enableFallback: true,
      fallbackModel: 'gemini-3.5-flash-lite',
      isRetired: false
    },
    dashboard_fetch: {
      model: 'gemini-3.8-flash',
      customModel: '',
      usePrimaryApiKey: true,
      customApiKey: '',
      enableFallback: true,
      fallbackModel: 'gemini-3.5-flash-lite',
      isRetired: false
    },
    subagent_runner: {
      model: 'gemini-3.8-flash',
      customModel: '',
      usePrimaryApiKey: true,
      customApiKey: '',
      enableFallback: true,
      fallbackModel: 'gemini-3.5-flash-lite',
      isRetired: false
    },
    voice_live: {
      model: 'gemini-3.8-flash-exp',
      customModel: '',
      usePrimaryApiKey: true,
      customApiKey: '',
      enableFallback: false,
      fallbackModel: 'gemini-3.8-flash',
      isRetired: false
    },
    image_generation: {
      provider: 'huggingface',
      model: 'black-forest-labs/FLUX.1-schnell',
      token: ''
    }
  }
};

// Built-in fallback model lists used when API calls fail or no key is available
const BUILTIN_GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-3.8-flash-exp'
];

const BUILTIN_OPENROUTER_MODELS = [
  'google/gemini-3.8-flash',
  'anthropic/claude-sonnet-4-5',
  'openai/gpt-4o',
  'deepseek/deepseek-r1',
  'moonshotai/kimi-k2',
  'meta-llama/llama-3.3-70b-instruct'
];

function getUserDataPath() {
  return app.getPath('userData');
}

function getConfigFilePath() {
  return path.join(getUserDataPath(), CONFIG_FILE);
}

/**
 * Reads tools_config.json from userData.
 * Returns merged default + stored config so new fields always exist.
 */
function readConfig() {
  const configPath = getConfigFilePath();
  try {
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify({ version: 1, ...DEFAULT_CONFIG }, null, 2), "utf8");
    }
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const stored = JSON.parse(raw);
      // Deep merge: stored overrides defaults but defaults fill missing keys
      const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      if (stored.enableGlobalFallback !== undefined) merged.enableGlobalFallback = stored.enableGlobalFallback;
      if (stored.defaultGlobalFallbackModel) merged.defaultGlobalFallbackModel = stored.defaultGlobalFallbackModel;
      if (stored.tools) {
        for (const toolKey of Object.keys(DEFAULT_CONFIG.tools)) {
          if (stored.tools[toolKey]) {
            merged.tools[toolKey] = Object.assign({}, DEFAULT_CONFIG.tools[toolKey], stored.tools[toolKey]);
          }
        }
      }
      return merged;
    }
  } catch (err) {
    console.error('[ToolsConfig] Failed to read config, using defaults:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/**
 * Writes config to tools_config.json in userData.
 */
function writeConfig(config) {
  const configPath = getConfigFilePath();
  try {
    const toWrite = { version: 1, ...config };
    fs.writeFileSync(configPath, JSON.stringify(toWrite, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[ToolsConfig] Failed to write config:', err.message);
    return false;
  }
}

/**
 * Returns the effective model for a given tool.
 * Uses customModel if set, otherwise falls back to model field.
 */
function getEffectiveModel(toolKey) {
  const config = readConfig();
  const tool = config.tools[toolKey];
  if (!tool) return config.defaultGlobalFallbackModel;
  const model = (tool.customModel && tool.customModel.trim()) ? tool.customModel.trim() : tool.model;
  return model || config.defaultGlobalFallbackModel;
}

/**
 * Marks a tool's model as retired and resets it to the global fallback.
 * Called automatically when a 404 / MODEL_NOT_FOUND error is detected at runtime.
 */
function markModelRetired(toolKey) {
  try {
    const config = readConfig();
    if (config.tools[toolKey]) {
      console.warn(`[ToolsConfig] Marking model as retired for tool: ${toolKey}`);
      config.tools[toolKey].isRetired = true;
      config.tools[toolKey].model = config.defaultGlobalFallbackModel;
      config.tools[toolKey].customModel = '';
      writeConfig(config);
    }
  } catch (err) {
    console.error('[ToolsConfig] Failed to mark model retired:', err.message);
  }
}

/**
 * Performs an HTTPS GET and returns the response body as a string.
 */
function httpsGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Fetches live model list from Google Gemini API.
 * Caches result in userData/cached_gemini_models.json.
 * Falls back to cache, then to built-in list if API fails.
 */
async function fetchGeminiModels(apiKey) {
  const cachePath = path.join(getUserDataPath(), GEMINI_MODELS_CACHE);

  if (apiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const result = await httpsGet(url);
      if (result.status === 200) {
        const parsed = JSON.parse(result.body);
        const models = (parsed.models || [])
          .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map(m => m.name.replace('models/', ''))
          .filter(Boolean);

        if (models.length > 0) {
          fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), models }, null, 2), 'utf8');
          console.log(`[ToolsConfig] Fetched ${models.length} Gemini models from API`);
          return models;
        }
      }
    } catch (err) {
      console.warn('[ToolsConfig] Gemini model fetch failed:', err.message);
    }
  }

  // Try cache
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.models && cached.models.length > 0) {
        console.log('[ToolsConfig] Using cached Gemini models');
        return cached.models;
      }
    } catch (_) {}
  }

  // Fallback to built-in list
  console.log('[ToolsConfig] Using built-in Gemini model list');
  return BUILTIN_GEMINI_MODELS;
}

/**
 * Fetches live model list from OpenRouter public API.
 * Caches result in userData/cached_openrouter_models.json.
 * Falls back to cache, then to built-in list if API fails.
 */
async function fetchOpenRouterModels() {
  const cachePath = path.join(getUserDataPath(), OPENROUTER_MODELS_CACHE);

  try {
    const result = await httpsGet('https://openrouter.ai/api/v1/models', {
      headers: { 'User-Agent': 'AkkiAI/1.0' }
    });
    if (result.status === 200) {
      const parsed = JSON.parse(result.body);
      const models = (parsed.data || []).map(m => m.id).filter(Boolean);
      if (models.length > 0) {
        fs.writeFileSync(cachePath, JSON.stringify({ updatedAt: Date.now(), models }, null, 2), 'utf8');
        console.log(`[ToolsConfig] Fetched ${models.length} OpenRouter models from API`);
        return models;
      }
    }
  } catch (err) {
    console.warn('[ToolsConfig] OpenRouter model fetch failed:', err.message);
  }

  // Try cache
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.models && cached.models.length > 0) {
        console.log('[ToolsConfig] Using cached OpenRouter models');
        return cached.models;
      }
    } catch (_) {}
  }

  console.log('[ToolsConfig] Using built-in OpenRouter model list');
  return BUILTIN_OPENROUTER_MODELS;
}

module.exports = {
  readConfig,
  writeConfig,
  getEffectiveModel,
  markModelRetired,
  fetchGeminiModels,
  fetchOpenRouterModels,
  DEFAULT_CONFIG,
  BUILTIN_GEMINI_MODELS,
  BUILTIN_OPENROUTER_MODELS
};
