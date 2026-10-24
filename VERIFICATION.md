# Prototype verification

Status on 22 October 2026:

- **Passed:** all 13 offline tests for supported video URLs, exact currency arithmetic, ambiguous and malformed amounts, CSV escaping, formula protection, replacement of hydrated purchases, and separation of membership/gift records from monetary totals.
- **Passed:** JavaScript syntax checks for the collector, service worker, storage, shared helpers, and dashboard.
- **Prepared, not executed:** `tests/browser_smoke.py` loads the real unpacked extension against locally fulfilled synthetic YouTube pages. It checks capture, duplicate prevention, provisional IDs, late-loaded amounts, pause draining, persistence, replay exclusion, video isolation, exports, and demo separation.
- **Blocked:** Chromium could not launch inside the workspace sandbox because of a local socket restriction. The scoped permission request was canceled, so there is no successful browser-test result.
- **Outstanding:** installation in desktop Chrome/Edge and validation on a real, currently live YouTube chat. The supplied sample video's live status and current markup have not been verified.

Do not treat the offline tests as evidence of complete capture on a production stream. Follow `START-HERE.txt` to perform the first live check.
