---
date: 2026-03-16
tags: [decision]
---

# Dev Journal Created

## What

Created `journal/` directory as a persistent knowledge base for project decisions, changes, and learnings.

## Why

NanoClaw has a lot of moving parts — channels, containers, skills, agent SDK, IPC, scheduling — and many concepts are
new. Code and git history show _what_ changed but not _why_. This journal fills that gap so that:

1. Future-me can recall the reasoning behind past decisions
2. Claude (in future conversations) can read entries to understand context without re-deriving it
3. Trade-offs and alternatives considered are preserved, not lost

## Format

One markdown file per entry, `yymmdd-verb-description.md`, with frontmatter tags for categorization.
