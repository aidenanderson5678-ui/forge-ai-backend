'use strict';

const { AppError } = require('../utils/errors');
const { CATEGORY_IDS } = require('../prompts/categories');

const SCRIPT_TYPES = ['Script', 'LocalScript', 'ModuleScript'];
const MIN_PROMPT_CHARS = 10;
const DEFAULT_MAX_SCRIPTS = 12;
const MAX_EXISTING_SCRIPTS = 10;
const MAX_EXISTING_SOURCE_CHARS = 30000;
const MAX_EXISTING_TOTAL_CHARS = 120000;
const CURRENCY_NAME_RE = /^[A-Za-z][A-Za-z0-9 ]{0,29}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strips control characters (keeps tab/newline) and normalizes line endings. */
function sanitizeText(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function validationError(details) {
  return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed.', { details });
}

/**
 * Validates and normalizes the body of POST /api/generate.
 * Unknown fields are ignored. Throws AppError(400) listing every problem found.
 *
 * Accepted body:
 * {
 *   "prompt": string (required),
 *   "categories": string[] (optional, see GET /api/categories),
 *   "options": { "currencyName"?: string, "includeGui"?: boolean, "maxScripts"?: integer },
 *   "existingScripts": [{ "name", "scriptType", "location", "source" }] (optional)
 * }
 */
function validateGenerateRequest(body, limits) {
  if (!isPlainObject(body)) {
    throw validationError([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const errors = [];

  // prompt
  let prompt = '';
  if (typeof body.prompt !== 'string') {
    errors.push({ field: 'prompt', message: 'prompt is required and must be a string.' });
  } else {
    prompt = sanitizeText(body.prompt);
    if (prompt.length < MIN_PROMPT_CHARS) {
      errors.push({ field: 'prompt', message: `prompt must be at least ${MIN_PROMPT_CHARS} characters.` });
    } else if (prompt.length > limits.maxPromptChars) {
      errors.push({ field: 'prompt', message: `prompt must be at most ${limits.maxPromptChars} characters.` });
    }
  }

  // categories
  let categories = null;
  if (body.categories !== undefined && body.categories !== null) {
    if (!Array.isArray(body.categories) || body.categories.length > CATEGORY_IDS.length) {
      errors.push({ field: 'categories', message: 'categories must be an array of category ids.' });
    } else {
      const normalized = [];
      body.categories.forEach((item, index) => {
        const id = typeof item === 'string' ? item.trim().toLowerCase() : '';
        if (!CATEGORY_IDS.includes(id)) {
          errors.push({
            field: `categories[${index}]`,
            message: `Unknown category. Use one of: ${CATEGORY_IDS.join(', ')}.`,
          });
        } else if (!normalized.includes(id)) {
          normalized.push(id);
        }
      });
      categories = normalized;
    }
  }

  // options
  const options = { currencyName: null, includeGui: true, maxScripts: Math.min(DEFAULT_MAX_SCRIPTS, limits.maxScripts) };
  if (body.options !== undefined && body.options !== null) {
    if (!isPlainObject(body.options)) {
      errors.push({ field: 'options', message: 'options must be an object.' });
    } else {
      const { currencyName, includeGui, maxScripts } = body.options;

      if (currencyName !== undefined && currencyName !== null) {
        if (typeof currencyName !== 'string' || !CURRENCY_NAME_RE.test(currencyName.trim())) {
          errors.push({
            field: 'options.currencyName',
            message: 'currencyName must be 1-30 characters: letters, digits and spaces, starting with a letter.',
          });
        } else {
          options.currencyName = currencyName.trim();
        }
      }

      if (includeGui !== undefined && includeGui !== null) {
        if (typeof includeGui !== 'boolean') {
          errors.push({ field: 'options.includeGui', message: 'includeGui must be a boolean.' });
        } else {
          options.includeGui = includeGui;
        }
      }

      if (maxScripts !== undefined && maxScripts !== null) {
        if (!Number.isInteger(maxScripts) || maxScripts < 1 || maxScripts > limits.maxScripts) {
          errors.push({
            field: 'options.maxScripts',
            message: `maxScripts must be an integer between 1 and ${limits.maxScripts}.`,
          });
        } else {
          options.maxScripts = maxScripts;
        }
      }
    }
  }

  // existingScripts
  const existingScripts = [];
  if (body.existingScripts !== undefined && body.existingScripts !== null) {
    if (!Array.isArray(body.existingScripts) || body.existingScripts.length > MAX_EXISTING_SCRIPTS) {
      errors.push({
        field: 'existingScripts',
        message: `existingScripts must be an array of at most ${MAX_EXISTING_SCRIPTS} scripts.`,
      });
    } else {
      let totalChars = 0;
      body.existingScripts.forEach((item, index) => {
        const field = `existingScripts[${index}]`;
        if (!isPlainObject(item)) {
          errors.push({ field, message: 'Each existing script must be an object.' });
          return;
        }
        const problems = [];
        if (typeof item.name !== 'string' || item.name.trim() === '' || item.name.length > 100) {
          problems.push({ field: `${field}.name`, message: 'name must be a string of 1-100 characters.' });
        }
        if (!SCRIPT_TYPES.includes(item.scriptType)) {
          problems.push({
            field: `${field}.scriptType`,
            message: `scriptType must be one of ${SCRIPT_TYPES.join(', ')}.`,
          });
        }
        if (typeof item.location !== 'string' || item.location.trim() === '' || item.location.length > 200) {
          problems.push({ field: `${field}.location`, message: 'location must be a string of 1-200 characters.' });
        }
        if (typeof item.source !== 'string' || item.source.length > MAX_EXISTING_SOURCE_CHARS) {
          problems.push({
            field: `${field}.source`,
            message: `source must be a string of at most ${MAX_EXISTING_SOURCE_CHARS} characters.`,
          });
        }
        if (problems.length > 0) {
          errors.push(...problems);
          return;
        }
        totalChars += item.source.length;
        existingScripts.push({
          name: item.name.trim(),
          scriptType: item.scriptType,
          location: item.location.trim(),
          source: item.source,
        });
      });
      if (totalChars > MAX_EXISTING_TOTAL_CHARS) {
        errors.push({
          field: 'existingScripts',
          message: `existingScripts may contain at most ${MAX_EXISTING_TOTAL_CHARS} characters of source in total.`,
        });
      }
    }
  }

  if (errors.length > 0) throw validationError(errors);

  return { prompt, categories, options, existingScripts };
}

module.exports = { validateGenerateRequest, sanitizeText };
