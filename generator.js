'use strict';

const { AppError } = require('../utils/errors');
const { detectCategories } = require('../prompts/categories');
const { buildSystemPrompt } = require('../prompts/systemPrompt');
const { buildUserMessage } = require('../prompts/userMessage');
const { validateProject } = require('./projectValidator');

/**
 * Orchestrates one generation: builds the prompts, calls the AI provider, validates
 * the result and, if the model's output is rejected, asks it to fix the problems.
 */
function createGenerator({ provider, config, logger }) {
  return {
    /**
     * @param {{ request: object, requestId: string, signal?: AbortSignal }} params
     */
    async generate({ request, requestId, signal }) {
      const startedAt = Date.now();
      const categories =
        request.categories && request.categories.length > 0 ? request.categories : detectCategories(request.prompt);
      const system = buildSystemPrompt({ categories, options: request.options });
      const usage = { inputTokens: 0, outputTokens: 0 };

      let feedback = [];
      let model = config.ai.model;

      for (let attempt = 1; attempt <= config.ai.maxAttempts; attempt += 1) {
        const user = buildUserMessage(request, categories, feedback);
        const result = await provider.generate({ system, user, signal });

        usage.inputTokens += (result.usage && result.usage.inputTokens) || 0;
        usage.outputTokens += (result.usage && result.usage.outputTokens) || 0;
        model = result.model || model;

        let issues;
        if (result.outputError || !result.output) {
          issues = [result.outputError || 'The model returned no output.'];
        } else {
          const checked = validateProject(result.output, { maxScripts: request.options.maxScripts });
          if (checked.errors.length === 0) {
            return {
              data: { ...checked.project, categories },
              meta: {
                provider: provider.name,
                model,
                attempts: attempt,
                durationMs: Date.now() - startedAt,
                usage,
                generatedAt: new Date().toISOString(),
              },
            };
          }
          issues = checked.errors;
        }

        feedback = issues;
        logger.warn('model output rejected', { requestId, attempt, issues: issues.slice(0, 10) });
      }

      throw new AppError(
        502,
        'INVALID_MODEL_OUTPUT',
        'The AI returned scripts that failed validation. Please try again or rephrase your prompt.',
        { details: feedback.slice(0, 10).map((message) => ({ message })) },
      );
    },
  };
}

module.exports = { createGenerator };
