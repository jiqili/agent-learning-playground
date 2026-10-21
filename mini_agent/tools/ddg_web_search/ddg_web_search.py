"""DuckDuckGo web search for mini-agent, implemented with the ddgs package."""

from __future__ import annotations

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.request import getproxies

try:
    from ddgs import DDGS
except ImportError as exc:
    raise RuntimeError(
        "The ddgs package is required for web search. "
        "Install it with: python -m pip install -r mini_agent/requirements.txt"
    ) from exc


CATEGORIES = ("text", "news")
TIMELIMITS = ("d", "w", "m", "y")
MAX_RESULTS = 20
FETCH_TOP_RESULTS = 3
MAX_FETCH_CHARS = 5_000
BOILERPLATE_MARKERS = (
    "sign in",
    "log in",
    "subscribe to our newsletter",
    "cookie policy",
    "we use cookies",
    "accept cookies",
    "privacy policy",
    "terms of service",
    "all rights reserved",
    "follow us on",
    "skip to main content",
    "back to top",
    "share on facebook",
    "share on twitter",
    "share on linkedin",
)
NAVIGATION_LINE = re.compile(r"^[\w\s\-&'.,]+(\s*[|.*>]+\s*[\w\s\-&'.,]+){2,}\s*$")


def _client_options() -> dict[str, Any]:
    proxies = getproxies()
    proxy = os.environ.get("DDGS_PROXY") or proxies.get("https") or proxies.get("http") or proxies.get("all")
    options: dict[str, Any] = {}
    if proxy:
        options["proxy"] = proxy
    cert_file = os.environ.get("SSL_CERT_FILE")
    if cert_file:
        options["verify"] = cert_file
    return options


def web_search(
    query: str,
    category: str = "text",
    timelimit: str | None = None,
    region: str = "wt-wt",
    max_results: int = 5,
) -> list[dict[str, Any]]:
    """Search DDG and replace the top three snippets with extracted page text."""
    query = query.strip()
    if not query:
        raise ValueError("query must not be empty")
    if len(query) > 400:
        query = query[:397] + "..."
    if category not in CATEGORIES:
        raise ValueError(f"category must be one of {CATEGORIES}")
    if timelimit is not None and timelimit not in TIMELIMITS:
        raise ValueError(f"timelimit must be one of {TIMELIMITS}")
    if not isinstance(region, str) or not region.strip():
        raise ValueError("region must be a non-empty string")
    if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= MAX_RESULTS:
        raise ValueError(f"max_results must be an integer between 1 and {MAX_RESULTS}")

    search_kwargs: dict[str, Any] = {
        "region": region,
        "max_results": max_results,
    }
    if category == "news":
        search_kwargs["timelimit"] = timelimit or "w"
    elif timelimit:
        search_kwargs["timelimit"] = timelimit

    result_category = category
    with DDGS(timeout=15, **_client_options()) as ddgs:
        rows = getattr(ddgs, category)(query, **search_kwargs)
        if category == "news" and not rows:
            rows = ddgs.text(query, region=region, max_results=max_results)
            result_category = "text"

    results = [_normalize(row, result_category) for row in rows]
    results = [result for result in results if result["url"]]
    _fetch_top_pages(results)
    return results


def _normalize(row: dict[str, Any], category: str) -> dict[str, Any]:
    result: dict[str, Any] = {
        "title": row.get("title") or "",
        "url": row.get("url") or (row.get("href") if category == "text" else "") or "",
        "body": row.get("body") or "",
    }
    for key in ("date", "source"):
        if row.get(key):
            result[key] = row[key]
    return result


def _fetch_top_pages(results: list[dict[str, Any]]) -> None:
    targets = results[:FETCH_TOP_RESULTS]
    if not targets:
        return
    with ThreadPoolExecutor(max_workers=len(targets), thread_name_prefix="ddgs-extract") as pool:
        pages = list(pool.map(_extract_page, (result["url"] for result in targets)))
    for result, page in zip(targets, pages):
        if page:
            result["body"] = page[:MAX_FETCH_CHARS]


def _extract_page(url: str) -> str | None:
    try:
        with DDGS(timeout=10, **_client_options()) as ddgs:
            content = ddgs.extract(url, fmt="text_plain").get("content", "")
        if isinstance(content, bytes):
            content = content.decode("utf-8", "replace")
        return _strip_boilerplate(str(content))
    except Exception:
        return None


def _strip_boilerplate(raw: str) -> str:
    if not raw:
        return ""
    lines: list[str] = []
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            lines.append("")
            continue
        lower = text.lower()
        if len(text) < 80 and any(marker in lower for marker in BOILERPLATE_MARKERS):
            continue
        if NAVIGATION_LINE.match(text):
            continue
        lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def main() -> int:
    if len(sys.argv) != 2:
        print("Expected one JSON object argument", file=sys.stderr)
        return 2
    try:
        arguments = json.loads(sys.argv[1])
        if not isinstance(arguments, dict):
            raise ValueError("tool arguments must be a JSON object")
        result = web_search(
            query=_argument_string(arguments, "query", required=True),
            category=_argument_string(arguments, "category", default="text"),
            timelimit=_argument_string(arguments, "timelimit", allow_none=True),
            region=_argument_string(arguments, "region", default="wt-wt"),
            max_results=arguments.get("max_results", 5),
        )
    except (ValueError, TypeError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"DuckDuckGo search failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=True))
    return 0


def _argument_string(
    arguments: dict[str, Any],
    name: str,
    *,
    required: bool = False,
    default: str | None = None,
    allow_none: bool = False,
) -> str | None:
    value = arguments.get(name, default)
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{name} must be a non-empty string" if required else f"{name} must be a string")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
