/**
 * NanoClaw Agent Runner — Single-Session Task Delegation Architecture
 * Runs inside a container, receives config via stdin, outputs results to stdout.
 *
 * One persistent query() session runs for the container's lifetime. Every
 * incoming message is pushed into the session as a [NEW MESSAGE], and the
 * system prompt instructs Claude to delegate each to an SDK Task for parallel
 * execution with shared context.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per task result / agent teams result).
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ActivityEvent {
  type: 'tool_use' | 'tool_result' | 'text' | 'thinking' | 'result' | 'error' | 'system';
  summary: string;
  detail?: string;
  timestamp: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  activity?: ActivityEvent;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_POLL_MS = 500;

// --- MessageStream ---

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

// --- Utility functions ---

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function emitActivity(event: ActivityEvent): void {
  writeOutput({ status: 'success', result: null, activity: event });
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// --- Shared SDK configuration ---

function buildSdkOptions(
  containerInput: ContainerInput,
  mcpServerPath: string,
  sdkEnv: Record<string, string | undefined>,
  abortController: AbortController,
  stream: MessageStream,
) {
  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }

  const solvyEnabled = process.env.SOLVY_ENABLED === '1';

  return {
    prompt: stream as AsyncIterable<SDKUserMessage>,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      abortController,
      systemPrompt: (() => {
        const identityPrompt = containerInput.assistantName
          ? `\nIMPORTANT: Your name is ${containerInput.assistantName}. You are NOT Claude. Always refer to yourself as ${containerInput.assistantName}.\n`
          : '';
        const behaviorPrompt = `
IMPORTANT: You are a persistent assistant managing concurrent tasks.

TASK DELEGATION: Every incoming user message (prefixed with [NEW MESSAGE]) MUST be handled in one of two ways, depending on the most appropriate solution for the incoming user message. In each case, it's important to give the user immediate feedback:
1. If it's a simple request that you can immediately respond to in less than 10 seconds, process the message inline and use the send_message tool to deliver results to the user.
2. Otherwise, it's a more complex request and it MUST be handled by creating a Task for it using the Task tool. Before engaging the Task tool, use the send_message tool to tell the user that it will take a moment. Each Task should process the user's request fully, and then use the send_message tool to deliver results from the Task to the user.

LONG-TERM TASKS: If a task requires ongoing work that cannot be completed in a single session (e.g., monitoring, multi-step projects, research over time), use the schedule_task MCP tool to schedule a recurring follow-up. This will wake you up periodically so you can check progress and continue. For example, schedule an interval of 3600000 (1 hour) or a cron expression for regular check-ins. Always prefer scheduling a follow-up over telling the user to remind you later.
`;

// TASK DELEGATION: Every incoming user message (prefixed with [NEW MESSAGE]) MUST be handled by creating a Task for it using the Task tool. Never handle [NEW MESSAGE] content inline — always delegate to a Task. Each Task should:
// 1. Process the user's request fully
// 2. Use the send_message tool to deliver results to the user
//
// ACKNOWLEDGMENT: Remember, if the Task will take more than 10 seconds to process, use send_message to send a brief acknowledgment like "Working on that..." to the user. For quick tasks, skip the acknowledgment.

        const append = (globalClaudeMd || '') + identityPrompt + behaviorPrompt;
        return append.trim()
          ? { type: 'preset' as const, preset: 'claude_code' as const, append }
          : undefined;
      })(),
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        ...(solvyEnabled ? ['mcp__solvy__*'] : []),
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project' as const, 'user' as const],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(solvyEnabled ? {
          solvy: {
            command: 'node',
            args: [path.join(path.dirname(mcpServerPath), 'solvy', 'index.js')],
            env: {
              SOLVY_DB_DIR: '/workspace/plansolver/',
              SOLVY_WORKSPACE_PREFIX: '/workspace/group/',
              SOLVY_GIT_ROOT: '/workspace/group/',
            },
          },
        } : {}),
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    },
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale files from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Create ONE MessageStream and ONE AbortController for the session
  const stream = new MessageStream();
  const abortController = new AbortController();

  // Build SDK options with stream as prompt
  const sdkOptions = buildSdkOptions(containerInput, mcpServerPath, sdkEnv, abortController, stream);

  // Resume session if available
  if (containerInput.sessionId) {
    (sdkOptions.options as Record<string, unknown>).resume = containerInput.sessionId;
  }

  // Push first message
  let lastUserMessage = `[NEW MESSAGE]\n\n${prompt}`;
  let awaitingResult = true;
  stream.push(lastUserMessage);

  let newSessionId: string | undefined;
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL_MS = 30_000; // at most once per 30s

  try {
    // Run query() and IPC dispatcher concurrently
    const queryPromise = (async () => {
      for await (const message of query(sdkOptions)) {
        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
          log(`Session initialized: ${newSessionId}`);
          emitActivity({
            type: 'system',
            summary: 'Session initialized',
            timestamp: new Date().toISOString(),
          });
        }
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          log('Compaction completed');
          emitActivity({
            type: 'system',
            summary: 'Context compacted',
            timestamp: new Date().toISOString(),
          });
          if (awaitingResult && lastUserMessage) {
            log('Re-injecting last user message after compaction');
            stream.push(`[REMINDER — your previous context was compacted before you could respond. Please handle this message now.]\n\n${lastUserMessage}`);
          }
        }
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          // Signal activity to host (resets idle timer)
          writeOutput({ status: 'success', result: null, newSessionId });
          emitActivity({
            type: 'system',
            summary: 'Task notification',
            timestamp: new Date().toISOString(),
          });
        }
        if (message.type === 'assistant') {
          // Emit activity for each content block
          const content = (message as { message?: { content?: Array<{ type: string; name?: string; input?: unknown; text?: string; thinking?: string }> } }).message?.content;
          if (content && Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                const inputStr = typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input || '');
                emitActivity({
                  type: 'tool_use',
                  summary: `${block.name || 'tool'}`,
                  detail: truncate(inputStr, 1000),
                  timestamp: new Date().toISOString(),
                });
              } else if (block.type === 'tool_result') {
                emitActivity({
                  type: 'tool_result',
                  summary: 'Tool result',
                  detail: truncate(block.text || '', 1000),
                  timestamp: new Date().toISOString(),
                });
              } else if (block.type === 'text' && block.text) {
                emitActivity({
                  type: 'text',
                  summary: truncate(block.text, 120),
                  detail: truncate(block.text, 1000),
                  timestamp: new Date().toISOString(),
                });
              } else if (block.type === 'thinking' && block.thinking) {
                emitActivity({
                  type: 'thinking',
                  summary: truncate(block.thinking, 120),
                  detail: truncate(block.thinking, 1000),
                  timestamp: new Date().toISOString(),
                });
              }
            }
          }

          // Throttled heartbeat on assistant messages (tool calls, thinking, etc.)
          // so long-running tasks signal activity to the host
          const now = Date.now();
          if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
            lastHeartbeat = now;
            writeOutput({ status: 'success', result: null, newSessionId });
          }
        }
        if (message.type === 'result') {
          awaitingResult = false;
          const textResult = 'result' in message ? (message as { result?: string }).result : null;
          log(`Result: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
          writeOutput({
            status: 'success',
            result: textResult || null,
            newSessionId,
            activity: {
              type: 'result',
              summary: 'Result received',
              detail: truncate(textResult || '', 1000),
              timestamp: new Date().toISOString(),
            },
          });
        }
      }
    })();

    // IPC dispatcher loop (polls for new messages, pushes into stream)
    const dispatcherLoop = (async () => {
      while (true) {
        if (shouldClose()) {
          log('Close sentinel detected, ending stream');
          stream.end();
          break;
        }
        const messages = drainIpcInput();
        for (const text of messages) {
          log(`New IPC message (${text.length} chars), pushing to stream`);
          lastUserMessage = `[NEW MESSAGE]\n\n${text}`;
          awaitingResult = true;
          stream.push(lastUserMessage);
        }
        await new Promise(r => setTimeout(r, IPC_POLL_MS));
      }
    })();

    await Promise.all([queryPromise, dispatcherLoop]);
    writeOutput({ status: 'success', result: null, newSessionId });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    abortController.abort();
    stream.end();
    writeOutput({
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage,
      activity: {
        type: 'error',
        summary: 'Agent error',
        detail: truncate(errorMessage, 1000),
        timestamp: new Date().toISOString(),
      },
    });
    process.exit(1);
  }
}

main();
