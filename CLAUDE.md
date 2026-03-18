# NanoClaw (Containerized Fork)

This is a fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) that runs the NanoClaw host process inside a Docker container, configured via `docker-compose.host.yml`.

**IMPORTANT: Never run this project directly in Node.js** (`npm run dev`, `npm start`, `node dist/index.js`, etc.). NanoClaw must only run inside the host Docker container. Use `npm run build` for type-checking only.

See [CLAUDE.host.md](CLAUDE.host.md) for the full NanoClaw development reference (architecture, key files, skills, troubleshooting). That file is mounted as the project's CLAUDE.md inside the host container, so the running instance uses it as its primary instructions.
