'use strict';

/**
 * Persisted settings.
 *
 * Deliberately a plain JSON file read and written synchronously. Settings are
 * tiny and read once at startup, and a synchronous write cannot be interrupted
 * halfway through by the app quitting, which is the failure mode that leaves a
 * user with unreadable preferences and an app that will not start.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let settingsDir = null;

function configure(dir) {
  settingsDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}

function filePath() {
  if (!settingsDir) throw new Error('Settings storage has not been configured.');
  return path.join(settingsDir, 'settings.json');
}

/** Default working folder: inside the user's home, never inside the app bundle. */
function defaultWorkDir() {
  return path.join(os.homedir(), 'Burnhouse');
}

const DEFAULTS = {
  version: 1,
  workDir: null,
  // Last used disc settings, so opening the app again feels like continuing.
  videoFormat: null, // null means "decide from the videos"
  titleAspect: '16:9',
  audioMode: 'stereo',
  discType: 'dvd5',
  chaptersEnabled: true,
  chapterMinutes: 5,
  buildIso: true,
  verifyBurn: true,
  themeId: 'charcoal',
  fontId: 'sans',
  buttonStyle: 'bar',
  showNumbers: true,
  discTitle: '',
  // The slide deck the user designed, saved whole so reopening the app lands
  // where they left off.
  deck: null,
  activeSlideId: null,
  showSafeArea: true,
  // Recent projects metadata list
  recentProjects: [],
  currentProjectId: null,
  // Explicit tool paths, used when auto-detection picks the wrong one.
  toolPaths: {},
  // Remembered burn drive, by device node.
  lastDevice: null,
  // The local sharing server.
  server: {
    enabled: false,
    port: 8137,
  },
  // Only ever set by the launch smoke test, which needs a way to drive the
  // interface without a native file chooser. Never set during normal use.
  testHooks: false,
};

function read() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return merge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch {
    // A missing or corrupt settings file must never stop the app starting.
    return structuredClone(DEFAULTS);
  }
}

function write(patch) {
  const next = merge(read(), patch || {});
  const target = filePath();
  const temp = `${target}.tmp`;
  // Write to a temporary file and rename, so an interrupted write cannot leave
  // a half-written settings file behind.
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return next;
}

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** The working folder actually in use, creating it if needed. */
function resolveWorkDir(settings) {
  const dir = (settings && settings.workDir) || defaultWorkDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectsDir() {
  if (!settingsDir) throw new Error('Settings storage has not been configured.');
  const dir = path.join(settingsDir, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveProject(project) {
  if (!project || !project.id) throw new Error('Invalid project data');
  const dir = projectsDir();
  const filePath = project.filePath || path.join(dir, `${project.id}.burnhouse`);
  project.filePath = filePath;
  project.modified = new Date().toISOString();

  // Write atomically to temporary file first
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(project, null, 2), 'utf8');
  fs.renameSync(temp, filePath);

  // Update recent projects in settings
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects.slice() : [];
  const meta = {
    id: project.id,
    name: project.name || project.discTitle || 'Untitled Project',
    filePath,
    modified: project.modified,
    videoCount: Array.isArray(project.videos) ? project.videos.length : 0,
    slideCount: project.deck && Array.isArray(project.deck.slides) ? project.deck.slides.length : 0,
    themeId: (project.deck && project.deck.themeId) || project.themeId || 'charcoal',
  };
  const existingIndex = recent.findIndex((r) => r.id === project.id || r.filePath === filePath);
  if (existingIndex !== -1) {
    recent.splice(existingIndex, 1);
  }
  recent.unshift(meta);
  write({ recentProjects: recent.slice(0, 25), currentProjectId: project.id });
  return { ok: true, project, meta };
}

function loadProject(idOrPath) {
  let filePath = String(idOrPath || '');
  if (!filePath.endsWith('.burnhouse') && !filePath.endsWith('.json') && !filePath.includes(path.sep) && !filePath.includes('/')) {
    filePath = path.join(projectsDir(), `${idOrPath}.burnhouse`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Project file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const project = JSON.parse(raw);
  project.filePath = filePath;
  return project;
}

function listRecentProjects() {
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects : [];
  return recent.filter((r) => {
    try {
      return fs.existsSync(r.filePath);
    } catch {
      return false;
    }
  });
}

function deleteProject(id) {
  const settings = read();
  const recent = Array.isArray(settings.recentProjects) ? settings.recentProjects.slice() : [];
  const item = recent.find((r) => r.id === id);
  if (item && item.filePath) {
    try {
      if (item.filePath.startsWith(projectsDir())) {
        fs.rmSync(item.filePath, { force: true });
      }
    } catch {
      /* ignore deletion errors */
    }
  }
  const updated = recent.filter((r) => r.id !== id);
  write({ recentProjects: updated });
  return updated;
}

module.exports = {
  DEFAULTS,
  configure,
  read,
  write,
  resolveWorkDir,
  defaultWorkDir,
  filePath,
  projectsDir,
  saveProject,
  loadProject,
  listRecentProjects,
  deleteProject,
};
