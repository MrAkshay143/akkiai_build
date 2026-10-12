const fs = require('fs');
const path = require('path');

function getAkkiBootstrapDir(app) {
  return path.join(app.getPath('documents'), 'Akki Data', '.akki');
}

function getAkkiMemoryDir(app) {
  return path.join(getAkkiBootstrapDir(app), 'memory');
}

function ensureAkkiDirectories(app) {
  try {
    const os = require('os');
    const notesPath = path.join(app.getPath('documents'), 'Akki Data');
    const legacyNotesPath = path.join(app.getPath('documents'), 'Stonic Data');

    // Create Akki Data dir; prefer existing Stonic Data via junction/symlink
    if (!fs.existsSync(notesPath)) {
      if (fs.existsSync(legacyNotesPath)) {
        // Legacy data exists — create Akki Data as link to preserve user data
        try {
          fs.symlinkSync(legacyNotesPath, notesPath, 'junction');
          console.log('Created Akki Data junction pointing to existing Stonic Data:', legacyNotesPath);
        } catch {
          fs.mkdirSync(notesPath, { recursive: true });
          console.log('Created Akki Data directory:', notesPath);
        }
      } else {
        fs.mkdirSync(notesPath, { recursive: true });
        console.log('Created Akki Data directory:', notesPath);
      }
    }

    const akkiDir = getAkkiBootstrapDir(app);
    const memoryDir = getAkkiMemoryDir(app);

    if (!fs.existsSync(akkiDir)) fs.mkdirSync(akkiDir, { recursive: true });
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });

    const memoryMdPath = path.join(akkiDir, 'MEMORY.md');
    if (!fs.existsSync(memoryMdPath)) {
      fs.writeFileSync(
        memoryMdPath,
        '- [System] Akki Memory System Initialized.',
        'utf8'
      );
      console.log('[Bootstrap] Created default MEMORY.md');
    }

    // --- Ensure .hermes Directories and Unified Memory/Soul/User Files ---
    const hermesDir = path.join(os.homedir(), '.hermes');
    const hermesMemoriesDir = path.join(hermesDir, 'memories');

    if (!fs.existsSync(hermesDir)) fs.mkdirSync(hermesDir, { recursive: true });
    if (!fs.existsSync(hermesMemoriesDir)) fs.mkdirSync(hermesMemoriesDir, { recursive: true });

    const hermesSoulPath = path.join(hermesDir, 'SOUL.md');
    if (!fs.existsSync(hermesSoulPath)) {
      fs.writeFileSync(
        hermesSoulPath,
        'You are a Loyal Butler — a composed, distinguished male assistant. Formal, respectful, always at service. Speak with precision, quiet confidence, and a touch of class. Use "Sir" where appropriate. Your tone is deep, steady, and reassuring. You are the ultimate personal aide — calm under pressure, never flustered, always one step ahead.\n\nCULTURAL GREETINGS: Greet naturally with "Namaste" or "Namaskar". Occasionally and organically, vary your greeting with warm traditional expressions like "Hare Krishna", "Radhe Radhe", or "Jai Shiva Shambhu" in a spontaneous, respectful manner.',
        'utf8'
      );
      console.log('[Bootstrap] Created default .hermes/SOUL.md');
    }

    const hermesMemoryPath = path.join(hermesMemoriesDir, 'MEMORY.md');
    if (!fs.existsSync(hermesMemoryPath)) {
      fs.writeFileSync(
        hermesMemoryPath,
        '- [System] Akki Memory System Initialized.',
        'utf8'
      );
      console.log('[Bootstrap] Created default .hermes/memories/MEMORY.md');
    }

    console.log('[Bootstrap] .akki/ and .hermes/ directories ready.');
    return notesPath;
  } catch (error) {
    console.error('Failed to create Akki/Hermes directories:', error);
    return null;
  }
}

module.exports = {
  ensureAkkiDirectories,
  getAkkiBootstrapDir,
  getAkkiMemoryDir,
};