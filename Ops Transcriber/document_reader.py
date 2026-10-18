"""Extract local PDF text for the offline knowledge-base upload endpoint."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "A PDF path is required."}))
        return 2

    try:
        import fitz

        document = fitz.open(Path(sys.argv[1]))
        try:
            content = "\n\n".join(page.get_text("text") for page in document)
        finally:
            document.close()
        print(json.dumps({"ok": True, "content": content}))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": f"Could not extract PDF text: {error}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
