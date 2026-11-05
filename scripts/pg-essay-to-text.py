#!/usr/bin/env python3
"""Convert a raw paulgraham.com essay HTML file to clean plain text.

PG essays are a single table layout: an image-only nav column (no text), an
optional YC-ad header block, the essay body, and an optional book-ad footer
block. Nav contributes no text; we strip the two ad blocks and the markup and
keep the body. Usage: pg-essay-to-text.py <in.html> [title]
"""
import sys, re, html as htmllib

def convert(raw: str) -> str:
    s = raw
    # Drop scripts, styles, comments outright.
    s = re.sub(r'<script\b.*?</script>', '', s, flags=re.S | re.I)
    s = re.sub(r'<style\b.*?</style>', '', s, flags=re.S | re.I)
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    # Drop the two known ad <font size=2> noise blocks (YC apply, Hackers&Painters).
    def drop_ad(m):
        block = m.group(0)
        if 'ycombinator.com/apply' in block or "You'll find this essay" in block \
           or 'Want to start a startup' in block:
            return ''
        return block
    s = re.sub(r'<font size=2>.*?</font>', drop_ad, s, flags=re.S | re.I)
    # Image-map nav and images carry no text; turn block/break tags into newlines.
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r'</?p\b[^>]*>', '\n\n', s, flags=re.I)
    s = re.sub(r'</(div|tr|table|h[1-6]|li|ul|ol)>', '\n', s, flags=re.I)
    # Strip all remaining tags.
    s = re.sub(r'<[^>]+>', '', s)
    # Unescape entities.
    s = htmllib.unescape(s)
    # Normalize whitespace: collapse runs of blank lines, trim trailing spaces.
    s = re.sub(r'[ \t]+\n', '\n', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    s = re.sub(r'[ \t]{2,}', ' ', s)
    # Trailing translation/links footer: drop standalone short lines that are
    # "<Lang> Translation", "Buttons", or bare nav words after the essay ends.
    lines = s.strip().split('\n')
    while lines and (re.fullmatch(r'.{0,30}Translation', lines[-1].strip())
                     or lines[-1].strip() in ('Buttons', '')):
        lines.pop()
    return '\n'.join(lines).strip()

def main():
    raw = open(sys.argv[1], encoding='utf-8', errors='replace').read()
    # Title from <title> if not supplied.
    title = sys.argv[2] if len(sys.argv) > 2 else ''
    if not title:
        m = re.search(r'<title>(.*?)</title>', raw, re.S | re.I)
        title = htmllib.unescape(m.group(1).strip()) if m else ''
    body = convert(raw)
    # The title also appears as the first body line (rendered as an image in the
    # original); drop it to avoid duplicating the heading.
    blines = body.split('\n')
    if title and blines and blines[0].strip() == title.strip():
        body = '\n'.join(blines[1:]).lstrip('\n')
    out = (f"# {title}\n\nSource: {sys.argv[3]}\n\n{body}\n") if len(sys.argv) > 3 \
          else (f"# {title}\n\n{body}\n")
    sys.stdout.write(out)

if __name__ == '__main__':
    main()
