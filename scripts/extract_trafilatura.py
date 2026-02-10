#!/usr/bin/env python3
import json
import sys

try:
    import trafilatura
except Exception:
    # If trafilatura isn't installed, emit null-equivalent
    print(json.dumps({}))
    sys.exit(0)

def main():
    html = sys.stdin.read()
    if not html:
        print(json.dumps({}))
        return
    try:
        downloaded = trafilatura.extract(html, with_metadata=True, include_comments=False, include_tables=False)
        if downloaded is None:
            print(json.dumps({}))
            return
        # trafilatura.extract returns a string; use structured extraction when possible
        # Fallback: place text in 'text' field
        meta = trafilatura.bare_extraction(html) or {}
        out = {
            "title": meta.get('title'),
            "text": downloaded,
            "author": meta.get('author'),
            "date": meta.get('date'),
            "language": meta.get('lang')
        }
        print(json.dumps(out))
    except Exception:
        print(json.dumps({}))

if __name__ == '__main__':
    main()





