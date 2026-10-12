const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

function registerSkillsHandlers() {
  const getCustomSkillsDir = () => {
    const akkiDir = path.join(app.getPath('documents'), 'Akki Data', 'skills', 'custom');
    const stonicDir = path.join(app.getPath('documents'), 'Stonic Data', 'skills', 'custom');
    if (fs.existsSync(akkiDir)) return akkiDir;
    if (fs.existsSync(stonicDir)) return stonicDir;
    if (!fs.existsSync(akkiDir)) fs.mkdirSync(akkiDir, { recursive: true });
    return akkiDir;
  };

  const getCoreSkillsDir = () => {
    const coreDir = app.isPackaged
      ? path.join(process.resourcesPath, 'skills', 'core')
      : path.join(__dirname, '..', '..', 'skills', 'core');

    if (!app.isPackaged && !fs.existsSync(coreDir)) fs.mkdirSync(coreDir, { recursive: true });
    return coreDir;
  };

  const parseSkillMd = (content, filePath) => {
    const cleaned = content.replace(/^\uFEFF/, '');
    const normalized = cleaned.replace(/\r\n/g, '\n');
    const frontmatterMatch = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!frontmatterMatch) return null;

    const yamlBlock = frontmatterMatch[1];
    const body = normalized.slice(frontmatterMatch[0].length).trim();
    const meta = {};

    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/['"]/g, ''));
      }
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (
        typeof value === 'string'
        && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      meta[key] = value;
    }

    return { ...meta, body, filePath };
  };

  const loadSkillsFromDir = (dir, isCore) => {
    const skills = [];
    if (!fs.existsSync(dir)) return skills;

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return skills;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const skillPath = path.join(dir, entry.name);
          try {
            const content = fs.readFileSync(skillPath, 'utf8');
            const parsed = parseSkillMd(content, skillPath);
            if (parsed && parsed.name) {
              const stateFolderName = `core-${entry.name.replace('.md', '')}`;
              const statePath = path.join(getCustomSkillsDir(), '..', '.states', `${stateFolderName}.json`);
              let enabled = true;
              if (fs.existsSync(statePath)) {
                try {
                  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                  enabled = state.enabled !== false;
                } catch (_stateError) {
                  enabled = true;
                }
              }

              skills.push({
                name: parsed.name,
                description: parsed.description || '',
                author: parsed.author || 'Akki Ai',
                version: parsed.version || '1.0.0',
                tags: Array.isArray(parsed.tags) ? parsed.tags : [],
                enabled,
                folderName: entry.name,
                filePath: skillPath,
                isCore: true,
              });
            }
          } catch (error) {
            console.error(`[Skills] Error reading flat skill ${entry.name}:`, error.message);
          }
        }
        continue;
      }

      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      try {
        const content = fs.readFileSync(skillPath, 'utf8');
        const parsed = parseSkillMd(content, skillPath);
        if (parsed && parsed.name) {
          let statePath = path.join(dir, entry.name, '.state.json');
          if (isCore) {
            const stateDir = path.join(getCustomSkillsDir(), '..', '.states');
            if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
            statePath = path.join(stateDir, `core-${entry.name}.json`);
          }

          let enabled = true;
          if (fs.existsSync(statePath)) {
            try {
              const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
              enabled = state.enabled !== false;
            } catch (_stateError) {
              enabled = true;
            }
          }

          skills.push({
            name: parsed.name,
            description: parsed.description || '',
            author: parsed.author || 'Unknown',
            version: parsed.version || '1.0.0',
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            enabled,
            folderName: entry.name,
            filePath: skillPath,
            isCore,
          });
        }
      } catch (error) {
        console.error(`[Skills] Error reading skill ${entry.name}:`, error.message);
      }
    }

    return skills;
  };

  ipcMain.handle('skills-get-all', async () => {
    try {
      const coreSkills = loadSkillsFromDir(getCoreSkillsDir(), true);
      const customSkills = loadSkillsFromDir(getCustomSkillsDir(), false);
      const mergedSkills = [...customSkills];

      for (const coreSkill of coreSkills) {
        if (!mergedSkills.find((skill) => skill.name === coreSkill.name)) {
          mergedSkills.push(coreSkill);
        }
      }

      return { success: true, skills: mergedSkills };
    } catch (error) {
      return { error: `Failed to load skills: ${error.message}` };
    }
  });

  ipcMain.handle('skills-load-content', async (_event, { skillName }) => {
    try {
      const coreSkills = loadSkillsFromDir(getCoreSkillsDir(), true);
      const customSkills = loadSkillsFromDir(getCustomSkillsDir(), false);
      const allSkills = [...customSkills, ...coreSkills];
      const skillMeta = allSkills.find((skill) => skill.name === skillName || skill.folderName === skillName);

      if (!skillMeta) {
        return { error: `Skill "${skillName}" not found` };
      }

      const content = fs.readFileSync(skillMeta.filePath, 'utf8');
      const parsed = parseSkillMd(content, skillMeta.filePath);
      if (parsed) {
        return { success: true, content: parsed.body, metadata: parsed, isCore: skillMeta.isCore };
      }

      return { error: `Failed to parse skill "${skillName}"` };
    } catch (error) {
      return { error: `Failed to load skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-save', async (_event, { name, description, author, version, tags, content, folderName }) => {
    try {
      const customSkillsDir = getCustomSkillsDir();
      let safeFolderName = folderName || name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      safeFolderName = safeFolderName.replace('.md', '');

      const skillDir = path.join(customSkillsDir, safeFolderName);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

      const tagsStr = Array.isArray(tags) ? `[${tags.join(', ')}]` : (tags || '[]');
      const frontmatter = [
        '---',
        `name: ${name}`,
        `description: ${description || ''}`,
        `author: ${author || 'User'}`,
        `version: ${version || '1.0.0'}`,
        `tags: ${tagsStr}`,
        '---',
      ].join('\n');

      const fullContent = `${frontmatter}\n\n${content || `# ${name}\n\nAdd your skill instructions here.`}`;
      const skillPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(skillPath, fullContent, 'utf8');

      return { success: true, filePath: skillPath, folderName: safeFolderName };
    } catch (error) {
      return { error: `Failed to save skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-delete', async (_event, { folderName, isCore }) => {
    try {
      if (isCore) {
        return { error: 'Core skills cannot be deleted.' };
      }

      const skillDir = path.join(getCustomSkillsDir(), folderName);
      if (!fs.existsSync(skillDir)) return { error: 'Skill folder not found' };

      fs.rmSync(skillDir, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      return { error: `Failed to delete skill: ${error.message}` };
    }
  });

  ipcMain.handle('skills-toggle', async (_event, { folderName, enabled, isCore }) => {
    try {
      let statePath;
      if (isCore) {
        const stateDir = path.join(getCustomSkillsDir(), '..', '.states');
        if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
        statePath = path.join(stateDir, `core-${folderName.replace('.md', '')}.json`);
      } else {
        const skillDir = path.join(getCustomSkillsDir(), folderName);
        if (!fs.existsSync(skillDir)) return { error: 'Skill not found' };
        statePath = path.join(skillDir, '.state.json');
      }

      fs.writeFileSync(statePath, JSON.stringify({ enabled }), 'utf8');
      return { success: true };
    } catch (error) {
      return { error: `Failed to toggle skill: ${error.message}` };
    }
  });
}

module.exports = { registerSkillsHandlers };
