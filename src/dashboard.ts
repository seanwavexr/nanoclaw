/**
 * Live Agent Activity Dashboard
 * HTTP server serving an inline HTML dashboard + SSE streaming of agent activity.
 */
import http from 'http';
import { GroupQueue } from './group-queue.js';
import { activityBus, ActivityEvent } from './activity-bus.js';
import { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NanoClaw Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    background: #1a1a2e;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    overflow: hidden;
  }
  #sidebar {
    width: 280px;
    min-width: 280px;
    background: #16213e;
    border-right: 1px solid #0f3460;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #sidebar h2 {
    padding: 16px;
    color: #e94560;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid #0f3460;
  }
  #group-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .group-item {
    padding: 10px 12px;
    margin: 4px 0;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.2s;
    border: 1px solid transparent;
  }
  .group-item:hover { background: #1a1a3e; }
  .group-item.active {
    background: #0f3460;
    border-color: #e94560;
  }
  .group-name {
    font-size: 13px;
    font-weight: bold;
    color: #fff;
    margin-bottom: 2px;
  }
  .group-meta {
    font-size: 11px;
    color: #888;
  }
  .group-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    margin-left: 4px;
  }
  .badge-task { background: #533483; color: #c89bff; }
  .badge-idle { background: #2d4059; color: #8ab4f8; }
  .badge-active { background: #1b4332; color: #52b788; }
  #no-groups {
    padding: 16px;
    color: #666;
    font-size: 12px;
    text-align: center;
  }
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #header {
    padding: 12px 16px;
    background: #16213e;
    border-bottom: 1px solid #0f3460;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  #header h3 {
    font-size: 14px;
    color: #e94560;
  }
  #connection-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
  }
  .status-connected { background: #1b4332; color: #52b788; }
  .status-disconnected { background: #442222; color: #e94560; }
  .status-idle { background: #2d4059; color: #8ab4f8; }
  #activity-log {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px;
  }
  #placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #444;
    font-size: 14px;
  }
  .event {
    padding: 4px 0;
    border-bottom: 1px solid #1a1a2e;
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 12px;
    line-height: 1.5;
  }
  .event-time {
    color: #555;
    white-space: nowrap;
    min-width: 80px;
  }
  .event-badge {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    font-size: 10px;
    min-width: 64px;
    text-align: center;
    white-space: nowrap;
  }
  .event-content {
    flex: 1;
    word-break: break-word;
  }
  .type-tool_use .event-badge { background: #1a365d; color: #63b3ed; }
  .type-tool_use .event-content { color: #90cdf4; }
  .type-tool_result .event-badge { background: #1a365d; color: #9ae6b4; }
  .type-tool_result .event-content { color: #9ae6b4; }
  .type-text .event-badge { background: #2d3748; color: #e2e8f0; }
  .type-text .event-content { color: #e2e8f0; }
  .type-thinking .event-badge { background: #2d3748; color: #a0aec0; }
  .type-thinking .event-content { color: #a0aec0; font-style: italic; }
  .type-result .event-badge { background: #1b4332; color: #52b788; }
  .type-result .event-content { color: #52b788; }
  .type-error .event-badge { background: #442222; color: #fc8181; }
  .type-error .event-content { color: #fc8181; }
  .type-system .event-badge { background: #433e0e; color: #ecc94b; }
  .type-system .event-content { color: #ecc94b; }
  .detail-toggle {
    color: #555;
    cursor: pointer;
    font-size: 11px;
    margin-left: 8px;
  }
  .detail-toggle:hover { color: #888; }
  .detail-block {
    display: none;
    margin-top: 4px;
    padding: 6px 8px;
    background: #0d1117;
    border-radius: 4px;
    font-size: 11px;
    color: #8b949e;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
  }
  .detail-block.open { display: block; }
  #toolbar {
    padding: 8px 16px;
    background: #16213e;
    border-top: 1px solid #0f3460;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  #toolbar button {
    padding: 4px 12px;
    border: 1px solid #0f3460;
    border-radius: 4px;
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  #toolbar button:hover { background: #0f3460; }
  #auto-scroll-label {
    font-size: 11px;
    color: #666;
    display: flex;
    align-items: center;
    gap: 4px;
  }
</style>
</head>
<body>
<div id="sidebar">
  <h2>Active Containers</h2>
  <div id="group-list"></div>
</div>
<div id="main">
  <div id="header">
    <h3 id="selected-name">Select a container</h3>
    <span id="connection-status" class="status-idle">idle</span>
  </div>
  <div id="activity-log">
    <div id="placeholder">Select a container from the sidebar to view activity</div>
  </div>
  <div id="toolbar">
    <button id="clear-btn">Clear</button>
    <label id="auto-scroll-label">
      <input type="checkbox" id="auto-scroll" checked> Auto-scroll
    </label>
  </div>
</div>
<script>
(function() {
  let selectedJid = null;
  let eventSource = null;
  let autoScroll = true;

  const groupList = document.getElementById('group-list');
  const activityLog = document.getElementById('activity-log');
  const selectedName = document.getElementById('selected-name');
  const connectionStatus = document.getElementById('connection-status');
  const clearBtn = document.getElementById('clear-btn');
  const autoScrollCb = document.getElementById('auto-scroll');

  autoScrollCb.addEventListener('change', () => { autoScroll = autoScrollCb.checked; });

  // Detect manual scroll
  activityLog.addEventListener('scroll', () => {
    const atBottom = activityLog.scrollHeight - activityLog.scrollTop - activityLog.clientHeight < 40;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      autoScrollCb.checked = false;
    }
  });

  clearBtn.addEventListener('click', () => {
    activityLog.innerHTML = '';
  });

  function formatTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ''; }
  }

  function addEvent(ev) {
    const div = document.createElement('div');
    div.className = 'event type-' + ev.type;

    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = formatTime(ev.timestamp);
    div.appendChild(time);

    const badge = document.createElement('span');
    badge.className = 'event-badge';
    badge.textContent = ev.type;
    div.appendChild(badge);

    const content = document.createElement('span');
    content.className = 'event-content';
    content.textContent = ev.summary;
    div.appendChild(content);

    if (ev.detail && ev.detail !== ev.summary) {
      const toggle = document.createElement('span');
      toggle.className = 'detail-toggle';
      toggle.textContent = '[detail]';
      const detail = document.createElement('div');
      detail.className = 'detail-block';
      detail.textContent = ev.detail;
      toggle.addEventListener('click', () => {
        detail.classList.toggle('open');
        toggle.textContent = detail.classList.contains('open') ? '[hide]' : '[detail]';
      });
      div.appendChild(toggle);
      div.appendChild(detail);
    }

    activityLog.appendChild(div);
    if (autoScroll) {
      activityLog.scrollTop = activityLog.scrollHeight;
    }
  }

  function selectGroup(jid, name) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    selectedJid = jid;
    selectedName.textContent = name || jid;
    activityLog.innerHTML = '';
    connectionStatus.textContent = 'connecting';
    connectionStatus.className = 'status-idle';

    // Update active class
    document.querySelectorAll('.group-item').forEach(el => {
      el.classList.toggle('active', el.dataset.jid === jid);
    });

    eventSource = new EventSource('/api/stream/' + encodeURIComponent(jid));
    eventSource.onopen = () => {
      connectionStatus.textContent = 'connected';
      connectionStatus.className = 'status-connected';
    };
    eventSource.addEventListener('activity', (e) => {
      try { addEvent(JSON.parse(e.data)); } catch {}
    });
    eventSource.onerror = () => {
      connectionStatus.textContent = 'disconnected';
      connectionStatus.className = 'status-disconnected';
    };
  }

  function refreshGroups() {
    fetch('/api/groups')
      .then(r => r.json())
      .then(groups => {
        groupList.innerHTML = '';
        if (groups.length === 0) {
          groupList.innerHTML = '<div id="no-groups">No active containers</div>';
          return;
        }
        for (const g of groups) {
          const div = document.createElement('div');
          div.className = 'group-item' + (g.groupJid === selectedJid ? ' active' : '');
          div.dataset.jid = g.groupJid;

          const nameDiv = document.createElement('div');
          nameDiv.className = 'group-name';
          nameDiv.textContent = g.groupName || g.groupFolder;
          div.appendChild(nameDiv);

          const metaDiv = document.createElement('div');
          metaDiv.className = 'group-meta';
          metaDiv.textContent = g.containerName;
          if (g.isTask) {
            const b = document.createElement('span');
            b.className = 'group-badge badge-task';
            b.textContent = 'task';
            metaDiv.appendChild(b);
          }
          const statusBadge = document.createElement('span');
          statusBadge.className = 'group-badge ' + (g.idle ? 'badge-idle' : 'badge-active');
          statusBadge.textContent = g.idle ? 'idle' : 'active';
          metaDiv.appendChild(statusBadge);
          div.appendChild(metaDiv);

          div.addEventListener('click', () => selectGroup(g.groupJid, g.groupName || g.groupFolder));
          groupList.appendChild(div);
        }
      })
      .catch(() => {});
  }

  refreshGroups();
  setInterval(refreshGroups, 5000);
})();
</script>
</body>
</html>`;

export function startDashboard(
  port: number,
  queue: GroupQueue,
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (pathname === '/api/groups') {
      const containers = queue.getActiveContainers();
      const groups = getRegisteredGroups();
      const result = containers.map((c) => ({
        ...c,
        groupName: groups[c.groupJid]?.name || null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // SSE stream: /api/stream/:groupJid
    const streamMatch = pathname.match(/^\/api\/stream\/(.+)$/);
    if (streamMatch) {
      const groupJid = decodeURIComponent(streamMatch[1]);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send buffered history
      const recent = activityBus.getRecent(groupJid);
      for (const event of recent) {
        res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
      }

      // Live events
      const listener = (event: ActivityEvent) => {
        res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
      };
      activityBus.on(groupJid, listener);

      // Keep-alive ping every 15s
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 15000);

      req.on('close', () => {
        activityBus.off(groupJid, listener);
        clearInterval(keepAlive);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Dashboard server started');
  });

  return server;
}
