const fs = require('fs');
const path = require('path');

function resolveVaultPath(app) {
  const akkiVault = path.join(app.getPath('documents'), 'Akki_Vault');
  const stonicVault = path.join(app.getPath('documents'), 'Stonic_Vault');
  if (fs.existsSync(akkiVault)) return akkiVault;
  return stonicVault;
}

function getKnownFolders(app) {
  return {
    desktop: app.getPath('desktop'),
    documents: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    pictures: app.getPath('pictures'),
    music: app.getPath('music'),
    videos: app.getPath('videos'),
    home: app.getPath('home'),
    appData: app.getPath('appData'),
    userData: app.getPath('userData'),
    temp: app.getPath('temp'),
  };
}

function resolveSystemPath(inputPath, app) {
  if (!inputPath || typeof inputPath !== 'string') return inputPath;
  const cleanPath = inputPath.trim().replace(/^["']|["']$/g, '');
  if (!cleanPath) return cleanPath;

  const docsDir = app.getPath('documents');

  // 1. Preserve Akki Data and legacy notes behavior (highest priority)
  if (cleanPath.includes('${resolvedNotesPath}') || cleanPath.includes('$resolvedNotesPath')) {
    const resolved = cleanPath.replace(/\$\{?resolvedNotesPath\}?[\\/]?/g, '');
    return resolved ? path.join(docsDir, 'Akki Data', resolved) : path.join(docsDir, 'Akki Data');
  }
  if (cleanPath.startsWith('Akki Data\\') || cleanPath.startsWith('Akki Data/') ||
      cleanPath.startsWith('Stonic Data\\') || cleanPath.startsWith('Stonic Data/')) {
    return path.join(docsDir, cleanPath);
  }
  if (cleanPath.toLowerCase() === 'akki data' || cleanPath.toLowerCase() === 'stonic data') {
    return path.join(docsDir, cleanPath);
  }

  // 2. Query Windows/Electron Known Folders dynamically
  const knownFolders = getKnownFolders(app);

  // 3. Handle %USERPROFILE% and ~ aliases
  let normalized = cleanPath;
  if (normalized.startsWith('~\\') || normalized.startsWith('~/')) {
    normalized = normalized.slice(2);
  } else if (normalized.toLowerCase().startsWith('%userprofile%\\') || normalized.toLowerCase().startsWith('%userprofile%/')) {
    normalized = normalized.slice('%userprofile%\\'.length);
  } else if (normalized.toLowerCase() === '%userprofile%' || normalized === '~') {
    return knownFolders.home;
  }

  // 4. Resolve Known Folder aliases (e.g. "Desktop\test", "Downloads\file.pdf", "Documents\test")
  const aliasMatch = normalized.match(/^(desktop|documents|downloads|pictures|music|videos|appdata|userdata|temp)([\\/].*)?$/i);
  if (aliasMatch) {
    const folderKey = aliasMatch[1].toLowerCase();
    const targetFolder = knownFolders[folderKey];
    if (targetFolder) {
      const subPath = aliasMatch[2] ? aliasMatch[2].slice(1) : '';
      return subPath ? path.join(targetFolder, subPath) : targetFolder;
    }
  }

  // 5. Handle legacy guessed absolute paths from user profile (e.g. C:\Users\<username>\Desktop\test)
  // If the path starts with the unredirected user home folder followed by a Known Folder name,
  // remap it to the actual Known Folder location returned by Electron.
  const homeDir = knownFolders.home;
  if (homeDir && typeof homeDir === 'string') {
    const checkFolders = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'];
    const cleanLower = cleanPath.toLowerCase();
    for (const key of checkFolders) {
      const unredirected = path.join(homeDir, key).toLowerCase();
      if (cleanLower === unredirected || cleanLower.startsWith(unredirected + '\\') || cleanLower.startsWith(unredirected + '/')) {
        const actualFolder = knownFolders[key];
        const subPath = cleanPath.slice(unredirected.length).replace(/^[\\/]/, '');
        return subPath ? path.join(actualFolder, subPath) : actualFolder;
      }
    }
  }

  // 6. If relative and not matching any known folder alias, preserve legacy default to Akki Data
  if (!path.isAbsolute(cleanPath)) {
    return path.join(docsDir, 'Akki Data', cleanPath);
  }

  // 7. Arbitrary absolute path (e.g. E:\Projects\test) is preserved untouched
  return cleanPath;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
  return null;
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const userData = (app) => app.getPath('userData');

function createPaths(app) {
  const ud = userData(app);

  return {
    ensureDir,
    readJson,
    writeJson,

    getMemoryPath: () => path.join(ud, 'memories.json'),
    getUserProfilePath: () => path.join(ud, 'user_profile.json'),
    getDashboardSettingsPath: () => path.join(ud, 'dashboard_settings.json'),
    getFolderConfigPath: () => path.join(ud, 'imported_folders.json'),
    getVaultPath: () => resolveVaultPath(app),
    getHistoryPath: () => path.join(ud, 'history.json'),
    getHistorySettingsPath: () => path.join(ud, 'history_settings.json'),
    getContactsPath: () => path.join(ud, 'contacts.json'),
    getNotesPath: () => path.join(ud, 'notes.json'),
    getTasksPath: () => path.join(ud, 'tasks.json'),
    getSecretKeyPath: () => path.join(ud, 'secret_key.json'),
    getGroqKeyPath: () => path.join(ud, 'groq_key.json'),
    getOpenAIKeyPath: () => path.join(ud, 'openai_key.json'),
    getOpenRouterKeyPath: () => path.join(ud, 'openrouter_key.json'),
    getKimiKeyPath: () => path.join(ud, 'kimi_key.json'),
    getThinkingSettingsPath: () => path.join(ud, 'thinking_settings.json'),
    getGeminiPreferencePath: () => path.join(ud, 'gemini_preference.json'),
    getVoiceAssistantModePath: () => path.join(ud, 'voice_assistant_mode.json'),
    getVoiceProviderPath: () => path.join(ud, 'voice_provider_preference.json'),
    getChatsPath: () => path.join(ud, 'chats.json'),
    getCustomModelsPath: () => path.join(ud, 'custom_models.json'),
    getWhatsAppSettingsPath: () => path.join(ud, 'whatsapp_settings.json'),
    getHFKeyPath: () => path.join(ud, 'hf_key.json'),
    getAgentReportsPath: () => path.join(ud, 'agent_reports.json'),
    getSubAgentConfigPath: () => path.join(ud, 'sub_agent_config.json'),
    getAgentTownConfigPath: () => path.join(ud, 'agent_town_config.json'),
    getWakeWordSettingsPath: () => path.join(ud, 'wake_word_settings.json'),
    getAutoUpdateSettingsPath: () => path.join(ud, 'auto_update_settings.json'),
    getKnownFolders: () => getKnownFolders(app),
    resolveSystemPath: (inputPath) => resolveSystemPath(inputPath, app),
  };
}

module.exports = { createPaths, resolveSystemPath, getKnownFolders };
