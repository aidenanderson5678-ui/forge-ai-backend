'use strict';

const { AppError, ClientAbortedError } = require('../utils/errors');

function tooLarge(limit) {
  return new AppError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds the ${limit}-byte limit.`);
}

/**
 * Reads and parses a JSON request body with a hard size limit.
 * Resolves with the parsed value; rejects with an AppError for client mistakes.
 */
function readJsonBody(req, { limit }) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      req.resume();
      reject(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'));
      return;
    }

    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(tooLarge(limit));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('close', onClose);
      fn(value);
    }

    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        settle(reject, tooLarge(limit));
        req.resume(); // discard the rest of the upload
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (size === 0) {
        settle(reject, new AppError(400, 'EMPTY_BODY', 'Request body is empty; send a JSON object.'));
        return;
      }
      try {
        settle(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        settle(reject, new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON.'));
      }
    }

    function onError() {
      settle(reject, new AppError(400, 'BODY_READ_ERROR', 'Could not read the request body.'));
    }

    function onClose() {
      if (!req.complete) settle(reject, new ClientAbortedError());
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

module.exports = { readJsonBody };
