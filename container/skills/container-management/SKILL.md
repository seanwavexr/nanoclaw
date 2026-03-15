---
name: container-management
description: Build and run Docker containers for the user — dev servers, websites, APIs, databases, or any service. Use whenever the user asks to build, deploy, host, or run something that needs its own server or process.
---

# Container Management

You can build and run Docker containers that persist independently from your session. Use this for dev servers, websites, APIs, databases, or any long-running service the user needs.

## How it works

You write files to `/workspace/containers/`, then use MCP tools to build and manage containers. The host validates all operations for security (port range, no privileged access). Containers survive your session ending.

## Workflow

### 1. Write files

Use the Write tool to create a Dockerfile and any source files in `/workspace/containers/`:

```
/workspace/containers/
├── Dockerfile
├── index.html
├── server.js
└── ...
```

### 2. Build and run

```
container_build(ports: ["8900:80"])
```

This builds the Dockerfile and starts a detached container with the specified port mapping.

### 3. Verify

```
container_exec(container_id: "abc123", command: "curl -s localhost:80")
container_logs(container_id: "abc123")
```

### 4. Tell the user

The service is accessible at `http://localhost:{hostPort}` from their machine.

## Available tools

| Tool | Purpose |
|------|---------|
| `container_build` | Build Dockerfile + start container with port mappings and optional volume mounts |
| `container_list` | List your running containers |
| `container_quota` | Check how many more containers you can create |
| `container_stop` | Stop a container |
| `container_restart` | Restart a stopped container |
| `container_destroy` | Remove a container permanently |
| `container_exec` | Run a command inside a container (30s timeout) |
| `container_logs` | Get recent container logs |

## Constraints

- **Ports:** Host ports must be in range **8900-9000**
- **Quota:** Limited number of containers per worker (check with `container_quota`)
- **No privileged mode:** Containers run unprivileged
- **Build context:** Only files in `/workspace/containers/` can be used
- **Volumes:** Mount subdirectories of `/workspace/containers/` for persistent data

## Persistent data with volumes

To persist data across container rebuilds, mount a subdirectory of `/workspace/containers/`:

```
container_build(
  ports: ["8900:3000"],
  volumes: ["/workspace/containers/myapp-data:/app/data"]
)
```

The data in `/workspace/containers/myapp-data/` survives `container_destroy` + rebuild. Use this for databases, user uploads, config files, etc.

## Example: Static website with nginx

```
# 1. Write the Dockerfile
Write /workspace/containers/Dockerfile:
FROM nginx:alpine
COPY index.html /usr/share/nginx/html/

# 2. Write the content
Write /workspace/containers/index.html:
<html><body><h1>Hello!</h1></body></html>

# 3. Build and run
container_build(ports: ["8900:80"])

# Result: Site available at http://localhost:8900
```

## Example: Node.js dev server

```
# 1. Write app files to /workspace/containers/
# 2. Write Dockerfile:
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["node", "server.js"]

# 3. Build and run
container_build(ports: ["8900:3000"])
```

## Example: Check on a running container

```
container_list()                                    # See all your containers
container_logs(container_id: "abc123", tail: 50)    # Recent logs
container_exec(container_id: "abc123", command: "ls -la /app")  # Run command
```
