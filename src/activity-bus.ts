/**
 * Per-group activity event bus with rolling buffer.
 * Streams real-time agent activity (tool calls, thinking, results, errors)
 * to the dashboard via SSE.
 */

export interface ActivityEvent {
  type: 'tool_use' | 'tool_result' | 'text' | 'thinking' | 'result' | 'error' | 'system';
  summary: string;
  detail?: string;
  timestamp: string;
}

const MAX_BUFFER_SIZE = 200;

class ActivityBus {
  private buffers = new Map<string, ActivityEvent[]>();
  private listeners = new Map<string, Set<(event: ActivityEvent) => void>>();

  push(groupJid: string, event: ActivityEvent): void {
    let buffer = this.buffers.get(groupJid);
    if (!buffer) {
      buffer = [];
      this.buffers.set(groupJid, buffer);
    }
    buffer.push(event);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - MAX_BUFFER_SIZE);
    }

    const listeners = this.listeners.get(groupJid);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }

  getRecent(groupJid: string): ActivityEvent[] {
    return this.buffers.get(groupJid) || [];
  }

  on(groupJid: string, listener: (event: ActivityEvent) => void): void {
    let set = this.listeners.get(groupJid);
    if (!set) {
      set = new Set();
      this.listeners.set(groupJid, set);
    }
    set.add(listener);
  }

  off(groupJid: string, listener: (event: ActivityEvent) => void): void {
    const set = this.listeners.get(groupJid);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(groupJid);
    }
  }

  clear(groupJid: string): void {
    this.buffers.delete(groupJid);
  }
}

export const activityBus = new ActivityBus();
