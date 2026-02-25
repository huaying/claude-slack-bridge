import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { ApprovalGate } from "../approval/ApprovalGate";
import { MessageUpdater } from "../slack/MessageUpdater";
import { buildApprovalBlocks } from "../slack/blocks";
import type { SessionState, AppConfig } from "../types/index";

export class Session {
  public state: SessionState;
  private abortController: AbortController | null = null;
  private approvalGate: ApprovalGate;
  private updater: MessageUpdater;

  constructor(
    channelId: string,
    threadTs: string,
    private readonly config: AppConfig,
    private readonly client: WebClient
  ) {
    this.state = {
      channelId,
      threadTs,
      claudeSessionId: null,
      workingDir: config.claude.defaultWorkingDir,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      status: "idle",
      activeMessageTs: null,
      activeMessageText: "",
    };
    this.approvalGate = new ApprovalGate();
    this.updater = new MessageUpdater(
      client,
      channelId,
      config.streaming.debounceMs,
      config.streaming.maxMessageLength
    );
  }

  /**
   * Handle a user message from Slack.
   * Runs a Claude query and streams results back.
   */
  async handleUserMessage(text: string): Promise<void> {
    if (this.state.status === "awaiting_approval") {
      await this.client.chat.postMessage({
        channel: this.state.channelId,
        thread_ts: this.state.threadTs,
        text: "Please approve or deny the pending tool request first.",
      });
      return;
    }

    if (this.state.status === "thinking") {
      await this.client.chat.postMessage({
        channel: this.state.channelId,
        thread_ts: this.state.threadTs,
        text: "Claude is still working on the previous request.",
      });
      return;
    }

    this.state.lastActivityAt = new Date();
    this.state.status = "thinking";
    this.state.activeMessageText = "";
    this.abortController = new AbortController();

    // Post an initial placeholder message that we'll update as Claude streams
    const initial = await this.client.chat.postMessage({
      channel: this.state.channelId,
      thread_ts: this.state.threadTs,
      text: "_thinking…_",
    });
    this.state.activeMessageTs = initial.ts ?? null;

    try {
      console.log(`[Session] Running query: "${text.slice(0, 80)}"`);
      await this.runQuery(text);
      console.log(`[Session] Query finished`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Session] Query error:`, msg);
      if (this.state.activeMessageTs) {
        await this.updater.finalizeWithError(this.state.activeMessageTs, msg);
      }
      this.state.status = "error";
      return;
    }

    this.state.status = "idle";
  }

  /**
   * Resolve a pending tool approval from a Slack button click.
   */
  resolveApproval(approvalKey: string, approved: boolean): boolean {
    return this.approvalGate.resolve(approvalKey, {
      approved,
      reason: approved ? undefined : "Denied by user in Slack",
    });
  }

  /**
   * Change the working directory for this session.
   */
  setWorkingDir(newDir: string): void {
    this.state.workingDir = newDir;
  }

  async destroy(): Promise<void> {
    this.abortController?.abort();
    this.approvalGate.rejectAll("Session destroyed");
    await this.updater.flush();
    this.state.status = "destroyed";
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async runQuery(prompt: string): Promise<void> {
    const resumeOpts = this.state.claudeSessionId
      ? { resume: this.state.claudeSessionId }
      : {};

    // Remove CLAUDECODE env var so the SDK can launch inside an existing Claude Code session
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "CLAUDECODE" && v !== undefined) env[k] = v;
    }

    for await (const event of query({
      prompt,
      options: {
        abortController: this.abortController!,
        cwd: this.state.workingDir,
        permissionMode: "default",
        env,
        stderr: (data: string) => console.error("[claude stderr]", data),
        canUseTool: (toolName, input, { signal }) =>
          this.requestToolApproval(toolName, input, signal),
        ...resumeOpts,
      },
    })) {
      console.log(`[Session] event: ${event.type}${("subtype" in event ? "/" + event.subtype : "")}`);
      await this.handleEvent(event);
    }
  }

  private async handleEvent(event: SDKMessage): Promise<void> {
    this.state.lastActivityAt = new Date();

    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.state.claudeSessionId = event.session_id;
        }
        break;

      case "assistant": {
        // Collect text blocks from the assistant message
        const text = (event.message.content as Array<{ type: string; text?: string }>)
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");

        if (text && this.state.activeMessageTs) {
          this.state.activeMessageText += text;
          this.updater.update(
            this.state.activeMessageTs,
            this.state.activeMessageText
          );
        }
        break;
      }

      case "result": {
        if (!this.state.activeMessageTs) break;

        if (event.subtype === "success") {
          await this.updater.finalize(
            this.state.activeMessageTs,
            event.result || this.state.activeMessageText
          );
          // Post cost/turn footnote
          const cost = event.total_cost_usd.toFixed(4);
          await this.client.chat.postMessage({
            channel: this.state.channelId,
            thread_ts: this.state.threadTs,
            text: `_Cost: $${cost} | Turns: ${event.num_turns}_`,
          });
        } else {
          const errors = "errors" in event ? event.errors.join("; ") : event.subtype;
          await this.updater.finalizeWithError(
            this.state.activeMessageTs,
            errors
          );
        }
        break;
      }
    }
  }

  /**
   * Intercepts tool calls and asks the user for approval via Slack.
   * Pauses the Claude query loop until Approve/Deny is clicked.
   */
  private async requestToolApproval(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    this.state.status = "awaiting_approval";

    // Unique key for this approval request
    const approvalKey = `${this.state.threadTs}::${Date.now()}`;

    const msg = await this.client.chat.postMessage({
      channel: this.state.channelId,
      thread_ts: this.state.threadTs,
      blocks: buildApprovalBlocks(
        toolName,
        input,
        this.state.channelId,
        this.state.threadTs,
        approvalKey
      ) as any[],
      text: `Claude wants to run: ${toolName}`,
    });
    const approvalMsgTs = msg.ts!;

    try {
      // Block here until the user clicks a button
      const decision = await this.approvalGate.wait(approvalKey, signal);

      // Update the approval message to reflect the decision
      await this.client.chat.update({
        channel: this.state.channelId,
        ts: approvalMsgTs,
        text: decision.approved
          ? `✅ Approved: \`${toolName}\``
          : `🚫 Denied: \`${toolName}\``,
        blocks: [],
      });

      this.state.status = "thinking";

      if (decision.approved) {
        return { behavior: "allow", updatedInput: input };
      } else {
        return {
          behavior: "deny",
          message: decision.reason ?? "Denied by user",
        };
      }
    } catch {
      this.state.status = "thinking";
      return { behavior: "deny", message: "Session aborted" };
    }
  }
}
