'use strict';

/**
 * Parses a JSON object out of model text. Tolerates markdown fences and
 * leading/trailing prose. Throws if no valid JSON object can be found.
 */
function extractJsonObject(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('The model response was empty.');
  }

  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to brace matching
  }

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  throw new Error('The model response did not contain valid JSON.');
}

module.exports = { extractJsonObject };
