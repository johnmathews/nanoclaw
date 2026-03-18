---
date: 2026-03-17
tags: [concept]
---

# Scope Container Session Behaviour

Discovered that the NanoClaw container is **not restarted between messages** within a conversation. The host keeps stdin
open and pipes new messages to the same running container. A new container is only spawned when the previous one exits
(i.e. after a gap in activity or a service restart).

This has implications for mount config changes: adding a new volume mount via IPC only takes effect after the current
container exits and a new one starts.
