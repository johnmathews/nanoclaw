---
name: pdf-reader
description: Read and extract text from PDF files — documents, reports, contracts, spreadsheets. Use whenever you need to read PDF content, not just when explicitly asked. Handles local files, URLs, and WhatsApp attachments.
allowed-tools: Bash(pdf-reader:*)
---

# PDF Reader

## Quick start

```bash
pdf-reader extract report.pdf              # Extract all text
pdf-reader extract report.pdf --layout     # Preserve tables/columns
pdf-reader fetch https://example.com/doc.pdf  # Download and extract
pdf-reader info report.pdf                 # Show metadata + size
pdf-reader list                            # List all PDFs in directory tree
```

## Commands

### extract — Extract text from PDF

```bash
pdf-reader extract <file>                        # Full text to stdout
pdf-reader extract <file> --layout               # Preserve layout (tables, columns)
pdf-reader extract <file> --pages 1-5            # Pages 1 through 5
pdf-reader extract <file> --pages 3-3            # Single page (page 3)
pdf-reader extract <file> --layout --pages 2-10  # Layout + page range
```

Options:
- `--layout` — Maintains spatial positioning. Essential for tables, spreadsheets, multi-column docs.
- `--pages N-M` — Extract only pages N through M (1-based, inclusive).

### fetch — Download and extract PDF from URL

```bash
pdf-reader fetch <url>                    # Download, verify, extract with layout
pdf-reader fetch <url> report.pdf         # Also save a local copy
```

Downloads the PDF, verifies it has a valid `%PDF` header, then extracts text with layout preservation. Temporary files are cleaned up automatically.

### info — PDF metadata and file size

```bash
pdf-reader info <file>
```

Shows title, author, page count, page size, PDF version, and file size on disk.

### list — Find all PDFs in directory tree

```bash
pdf-reader list
```

Recursively lists all `.pdf` files with page count and file size.

## PDF attachments from chat

When a user sends a PDF (WhatsApp, Slack, or any other channel that delivers binary attachments), it is automatically spilled to the session inbox at `/workspace/inbox/<message-id>/<filename>`. The message will include a path hint like:

> [pdf: document.pdf — saved to /workspace/inbox/msg-123/document.pdf]

Use the path from the hint verbatim:

```bash
pdf-reader extract /workspace/inbox/msg-123/document.pdf --layout
```

Inbox files persist for the lifetime of the session — they are not auto-pruned, but they are not promoted to durable storage either. If the user wants a PDF kept long-term, copy it into `/workspace/agent/attachments/` (the group folder) and note it in `CLAUDE.local.md`.

## Example workflows

### Read a contract and summarize key terms

```bash
pdf-reader info /workspace/inbox/msg-123/contract.pdf
pdf-reader extract /workspace/inbox/msg-123/contract.pdf --layout
```

### Extract specific pages from a long report

```bash
pdf-reader info report.pdf                    # Check total pages
pdf-reader extract report.pdf --pages 1-3     # Executive summary
pdf-reader extract report.pdf --pages 15-20   # Financial tables
```

### Fetch and analyze a public document

```bash
pdf-reader fetch https://example.com/annual-report.pdf report.pdf
pdf-reader info report.pdf
```
