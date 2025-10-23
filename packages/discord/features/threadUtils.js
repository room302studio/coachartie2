import { Result, ResultAsync, err, ok } from 'neverthrow';
import { createResponseEmbed } from './responses.js';
import logger from '../logger.js';

/**
 * Generates a thread summary using capabilities service
 * @returns {ResultAsync<{summary: string, suggestedTitle: string}, Error>}
 */
export function generateThreadSummary(thread, messageLimit = 100) {
  return ResultAsync.fromPromise(
    thread.messages.fetch({ limit: messageLimit }),
    (error) => new Error(`Failed to fetch messages: ${error.message}`)
  ).andThen((messages) => {
    const threadContent = messages.reverse().map((msg) => ({
      role: msg.author.bot ? 'assistant' : 'user',
      content: msg.content,
    }));

    return ResultAsync.fromPromise(
      fetch(`${process.env.CAPABILITIES_URL}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_type: 'summarize',
          payload: {
            messages: threadContent,
            type: 'thread_summary',
          },
        }),
      }),
      (error) => new Error(`Network error: ${error.message}`)
    )
      .andThen((response) =>
        response.ok
          ? ResultAsync.fromPromise(response.json(), (e) => new Error(`Parse error: ${e.message}`))
          : err(new Error(`Capabilities service error: ${response.status}`))
      )
      .map((data) => ({
        summary: data.result,
        suggestedTitle: data.metadata?.title || 'Thread Summary',
      }));
  });
}

/**
 * Updates thread title with AI-generated summary
 * @returns {ResultAsync<string, Error>}
 */
export function updateThreadTitle(thread) {
  return generateThreadSummary(thread).andThen(({ suggestedTitle }) =>
    ResultAsync.fromPromise(
      thread.setName(suggestedTitle),
      (error) => new Error(`Failed to update thread title: ${error.message}`)
    ).map(() => suggestedTitle)
  );
}

/**
 * Archives thread with summary
 * @returns {ResultAsync<string, Error>}
 */
export function archiveThreadWithSummary(thread) {
  return generateThreadSummary(thread).andThen(({ summary }) => {
    const embed = createResponseEmbed({
      title: '📝 Thread Summary',
      description: summary,
      color: '#00ff00',
    });

    return ResultAsync.combine([
      ResultAsync.fromPromise(
        thread.send({ embeds: [embed] }),
        (error) => new Error(`Failed to send summary: ${error.message}`)
      ),
      ResultAsync.fromPromise(
        thread.setArchived(true),
        (error) => new Error(`Failed to archive thread: ${error.message}`)
      ),
    ]).map(() => summary);
  });
}
