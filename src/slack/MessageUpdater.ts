import type { WebClient } from "@slack/web-api";
import { mdToSlack } from "./formatter";

/**
 * Manages Slack message updates with debouncing to respect rate limits.
 *
 * Slack allows ~1 update/second per channel. Claude streams tokens much faster.
 * This class batches updates and only flushes after a quiet period.
 */
export class MessageUpdater {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingText: string | null = null;
  private pendingTs: string | null = null;

  constructor(
    private readonly client: WebClient,
    private readonly channelId: string,
    private readonly debounceMs: number,
    private readonly maxLength: number
  ) {}

  /**
   * Called frequently as Claude streams text.
   * Updates are debounced to avoid Slack rate limits.
   */
  update(messageTs: string, fullText: string): void {
    this.pendingText = this.truncate(mdToSlack(fullText));
    this.pendingTs = messageTs;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * Called when Claude finishes. Cancels the debounce and posts immediately.
   */
  async finalize(messageTs: string, finalText: string): Promise<void> {
    this.cancelDebounce();
    const text = this.truncate(mdToSlack(finalText)) || "_done_";
    await this.safeUpdate(messageTs, text);
  }

  async finalizeWithError(messageTs: string, error: string): Promise<void> {
    this.cancelDebounce();
    await this.safeUpdate(messageTs, `Error: ${error}`);
  }

  async flush(): Promise<void> {
    this.debounceTimer = null;
    if (this.pendingTs && this.pendingText !== null) {
      const ts = this.pendingTs;
      const text = this.pendingText + " _…_";
      this.pendingText = null;
      this.pendingTs = null;
      await this.safeUpdate(ts, text);
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingText = null;
    this.pendingTs = null;
  }

  private async safeUpdate(ts: string, text: string): Promise<void> {
    try {
      await this.client.chat.update({
        channel: this.channelId,
        ts,
        text,
        // Use a section block so Slack always renders the content visibly.
        // Passing blocks:[] after an initial block message can leave the message blank.
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    } catch (err) {
      console.error("[MessageUpdater] Failed to update message:", (err as Error).message);
    }
  }

  private truncate(text: string): string {
    if (text.length <= this.maxLength) return text;
    return text.slice(0, this.maxLength - 3) + "…";
  }
}
