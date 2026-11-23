'use strict';

const SCRIPT_TYPES = ['Script', 'LocalScript', 'ModuleScript'];
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
const MAX_SOURCE_CHARS = 150000;
const MAX_TOTAL_SOURCE_CHARS = 600000;
const MAX_FOLDER_DEPTH = 4;

const ROOTS = [
  'StarterPlayer/StarterPlayerScripts',
  'StarterPlayer/StarterCharacterScripts',
  'ServerScriptService',
  'ServerStorage',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'Workspace',
  'StarterGui',
  'StarterPack',
];

const ROOT_ALIASES = {
  StarterPlayerScripts: 'StarterPlayer/StarterPlayerScripts',
  StarterCharacterScripts: 'StarterPlayer/StarterCharacterScripts',
};

const SERVER_RUN_ROOTS = new Set(['ServerScriptService', 'Workspace']);
const CLIENT_RUN_ROOTS = new Set([
  'StarterGui',
  'StarterPack',
  'ReplicatedFirst',
  'StarterPlayer/StarterPlayerScripts',
  'StarterPlayer/StarterCharacterScripts',
]);

const COMPAT_HINT = {
  Script: 'a Script only runs from ServerScriptService or Workspace',
  LocalScript:
    'a LocalScript only runs from StarterGui, StarterPack, ReplicatedFirst or StarterPlayer/StarterPlayerScripts|StarterCharacterScripts',
};

const RUN_CONTEXT = { Script: 'server', LocalScript: 'client', ModuleScript: 'module' };

const ROOT_ORDER = [
  'Workspace',
  'ReplicatedFirst',
  'ReplicatedStorage',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
];

// Problems that make a script unacceptable (trigger a regeneration).
const HARD_RULES = [
  { re: /\bloadstring\s*\(/, message: 'uses loadstring(), which is not allowed' },
  { re: /\brequire\s*\(\s*\d+\s*\)/, message: 'uses require() with a numeric asset ID, which is not allowed' },
];

// Problems worth telling the creator about but not worth a regeneration.
const SOFT_RULES = [
  {
    re: /\b(?:TODO|FIXME)\b|implement (?:this|me)\b|your code here/i,
    message: 'contains a TODO or placeholder comment and may be incomplete',
  },
  {
    re: /(?:^|[^.:\w])(?:wait|spawn|delay)\s*\(/m,
    message: 'uses a deprecated global (wait/spawn/delay) instead of the task library',
  },
  {
    re: /\bRequestAsync\s*\(/,
    message: 'makes outbound HTTP requests (HttpService); this needs HTTP requests enabled and should be reviewed',
  },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a location string such as "ServerScriptService/Forge",
 * "game.ServerScriptService.Forge" or "StarterPlayerScripts/Forge".
 */
function normalizeLocation(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'location must be a non-empty string' };
  }

  const parts = raw
    .replace(/[\\.]/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts[0] && parts[0].toLowerCase() === 'game') parts.shift();
  if (parts.length === 0) return { error: 'location must name a Roblox service' };

  if (ROOT_ALIASES[parts[0]]) parts.splice(0, 1, ...ROOT_ALIASES[parts[0]].split('/'));

  const rootLength = parts[0] === 'StarterPlayer' ? 2 : 1;
  const root = parts.slice(0, rootLength).join('/');
  if (!ROOTS.includes(root)) {
    return { error: `location root "${root}" is not supported (use one of: ${ROOTS.join(', ')})` };
  }

  const folders = parts.slice(rootLength);
  if (folders.length > MAX_FOLDER_DEPTH) {
    return { error: `location is nested more than ${MAX_FOLDER_DEPTH} folders deep` };
  }
  for (const folder of folders) {
    if (!NAME_RE.test(folder)) {
      return { error: `folder name "${folder}" must start with a letter and use only letters, digits and underscores` };
    }
  }

  const parentPath = [...root.split('/'), ...folders];
  return { root, folders, parentPath, location: parentPath.join('/') };
}

function isCompatible(scriptType, root) {
  if (scriptType === 'Script') return SERVER_RUN_ROOTS.has(root);
  if (scriptType === 'LocalScript') return CLIENT_RUN_ROOTS.has(root);
  return true;
}

function cleanSource(source) {
  let text = source.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const fenced = text.match(/^\s*```[A-Za-z]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) text = fenced[1];
  return `${text.replace(/\s+$/, '')}\n`;
}

function cleanStringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxLength));
}

function unique(list) {
  return [...new Set(list)];
}

/** Builds an Explorer-style tree so a GUI can render the project hierarchy. */
function buildExplorerTree(scripts) {
  const tree = [];

  for (const script of scripts) {
    let level = tree;
    script.parentPath.forEach((segment, index) => {
      const className = index === 0 || (script.parentPath[0] === 'StarterPlayer' && index === 1) ? segment : 'Folder';
      let node = level.find((candidate) => candidate.name === segment && !candidate.scriptId);
      if (!node) {
        node = { name: segment, className, children: [] };
        level.push(node);
      }
      level = node.children;
    });
    level.push({ name: script.name, className: script.scriptType, scriptId: script.id, children: [] });
  }

  const rank = (node) => (node.scriptId ? 1 : 0);
  const sortLevel = (nodes, isRoot) => {
    nodes.sort((a, b) => {
      if (isRoot) return ROOT_ORDER.indexOf(a.name) - ROOT_ORDER.indexOf(b.name);
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
    for (const node of nodes) sortLevel(node.children, false);
  };
  sortLevel(tree, true);
  return tree;
}

/**
 * Validates and normalizes the model's raw output.
 * Returns { project, errors, warnings }. `errors` are hard failures (the model
 * is asked to try again); `warnings` are surfaced to the client with the result.
 * No Luau compiler runs here, so syntax errors are not detected by this function.
 */
function validateProject(raw, { maxScripts }) {
  const errors = [];
  const warnings = [];

  if (!isObject(raw)) {
    return { project: null, errors: ['The output must be a JSON object.'], warnings };
  }

  let rawScripts = raw.scripts;
  if (typeof rawScripts === 'string') {
    try {
      rawScripts = JSON.parse(rawScripts);
    } catch {
      // handled below
    }
  }
  if (!Array.isArray(rawScripts) || rawScripts.length === 0) {
    return { project: null, errors: ['"scripts" must be a non-empty array of script objects.'], warnings };
  }
  if (rawScripts.length > maxScripts) {
    errors.push(`Too many scripts (${rawScripts.length}); the maximum is ${maxScripts}. Merge or remove scripts.`);
  }

  const scripts = [];
  const seenPaths = new Set();
  let totalChars = 0;

  rawScripts.forEach((item, index) => {
    if (!isObject(item)) {
      errors.push(`scripts[${index}] must be an object.`);
      return;
    }

    const name = typeof item.name === 'string' ? item.name.trim() : item.name;
    const label = `scripts[${index}]${typeof name === 'string' && name ? ` "${name}"` : ''}`;
    const problems = [];

    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      problems.push('name must start with a letter and use only letters, digits and underscores (max 50 characters)');
    }
    if (!SCRIPT_TYPES.includes(item.scriptType)) {
      problems.push(`scriptType must be one of ${SCRIPT_TYPES.join(', ')}`);
    }

    const location = normalizeLocation(item.location);
    if (location.error) {
      problems.push(location.error);
    } else if (SCRIPT_TYPES.includes(item.scriptType) && !isCompatible(item.scriptType, location.root)) {
      problems.push(`${item.scriptType} cannot run from ${location.location} (${COMPAT_HINT[item.scriptType]})`);
    }

    let source = '';
    if (typeof item.source !== 'string' || item.source.trim().length < 5) {
      problems.push('source must be a non-empty string of Luau code');
    } else {
      source = cleanSource(item.source);
      if (source.length > MAX_SOURCE_CHARS) problems.push(`source is longer than ${MAX_SOURCE_CHARS} characters`);
      totalChars += source.length;
      for (const rule of HARD_RULES) {
        if (rule.re.test(source)) problems.push(rule.message);
      }
    }

    if (problems.length > 0) {
      for (const problem of problems) errors.push(`${label}: ${problem}.`);
      return;
    }

    const fullPath = `${location.location}/${name}`;
    if (seenPaths.has(fullPath)) {
      errors.push(`${label}: duplicate script at ${fullPath}; every script needs a unique name and location.`);
      return;
    }
    seenPaths.add(fullPath);

    for (const rule of SOFT_RULES) {
      if (rule.re.test(source)) warnings.push(`${name} ${rule.message}.`);
    }

    scripts.push({
      id: fullPath,
      name,
      scriptType: item.scriptType,
      location: location.location,
      parentPath: location.parentPath,
      fullPath,
      runContext: RUN_CONTEXT[item.scriptType],
      description: typeof item.description === 'string' ? item.description.trim().slice(0, 500) : '',
      lineCount: source.split('\n').length - 1,
      source,
    });
  });

  if (totalChars > MAX_TOTAL_SOURCE_CHARS) {
    errors.push(`The combined source is longer than ${MAX_TOTAL_SOURCE_CHARS} characters; produce a smaller project.`);
  }

  // A script may not share a path with a folder that another script lives in.
  const folderPaths = new Set();
  for (const script of scripts) {
    for (let i = 1; i <= script.parentPath.length; i += 1) folderPaths.add(script.parentPath.slice(0, i).join('/'));
  }
  for (const script of scripts) {
    if (folderPaths.has(script.fullPath)) {
      errors.push(`"${script.name}" at ${script.location} has the same path as a folder; rename the script.`);
    }
  }

  if (errors.length > 0) return { project: null, errors, warnings };

  if (scripts.some((script) => /\bDataStoreService\b/.test(script.source))) {
    warnings.push(
      'Saving uses DataStoreService: publish the place, and to test saving in Studio enable Game Settings > Security > "Enable Studio Access to API Services".',
    );
  }

  const project = {
    projectName:
      typeof raw.projectName === 'string' && raw.projectName.trim()
        ? raw.projectName.trim().slice(0, 100)
        : 'Forge Project',
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 1000) : '',
    scripts,
    explorerTree: buildExplorerTree(scripts),
    setupInstructions: cleanStringList(raw.setupInstructions, 15, 400),
    warnings: unique([...cleanStringList(raw.warnings, 15, 400), ...warnings]),
  };

  return { project, errors: [], warnings: project.warnings };
}

module.exports = { validateProject, normalizeLocation, isCompatible, buildExplorerTree, SCRIPT_TYPES, ROOTS };
