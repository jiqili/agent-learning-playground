import os
import io
import json
import sys
import unittest
from unittest.mock import patch

from ddg_web_search import _client_options, main, web_search


class FakeDDGS:
    text_rows = []
    news_rows = []
    pages = {}
    calls = []
    clients = []

    def __init__(self, timeout=15, **kwargs):
        self.timeout = timeout
        type(self).clients.append({"timeout": timeout, **kwargs})

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def text(self, query, **kwargs):
        type(self).calls.append(("text", query, kwargs))
        return list(type(self).text_rows)

    def news(self, query, **kwargs):
        type(self).calls.append(("news", query, kwargs))
        return list(type(self).news_rows)

    def extract(self, url, fmt="text_markdown"):
        type(self).calls.append(("extract", url, fmt))
        value = type(self).pages.get(url, "")
        if isinstance(value, Exception):
            raise value
        return {"content": value}


class WebSearchTests(unittest.TestCase):
    def setUp(self):
        FakeDDGS.text_rows = []
        FakeDDGS.news_rows = []
        FakeDDGS.pages = {}
        FakeDDGS.calls = []
        FakeDDGS.clients = []
        self.ddgs_patch = patch("ddg_web_search.DDGS", FakeDDGS)
        self.ddgs_patch.start()
        self.addCleanup(self.ddgs_patch.stop)

    def test_client_options_prioritize_ddgs_proxy_and_forward_ca_file(self):
        with patch.dict(os.environ, {"DDGS_PROXY": "http://dedicated:8080", "SSL_CERT_FILE": "trusted.pem"}, clear=True):
            with patch("ddg_web_search.getproxies", return_value={"https": "http://standard:8080"}):
                self.assertEqual(_client_options(), {"proxy": "http://dedicated:8080", "verify": "trusted.pem"})

    def test_client_options_use_standard_proxy_precedence(self):
        with patch.dict(os.environ, {}, clear=True):
            for proxies, expected in [
                ({"https": "https-proxy", "http": "http-proxy", "all": "all-proxy"}, "https-proxy"),
                ({"http": "http-proxy", "all": "all-proxy"}, "http-proxy"),
                ({"all": "all-proxy"}, "all-proxy"),
            ]:
                with self.subTest(proxies=proxies):
                    with patch("ddg_web_search.getproxies", return_value=proxies):
                        self.assertEqual(_client_options(), {"proxy": expected})
            with patch("ddg_web_search.getproxies", return_value={}):
                self.assertEqual(_client_options(), {})

    def test_search_and_extraction_share_transport_options(self):
        FakeDDGS.text_rows = [{"title": "Page", "href": "https://example.com", "body": "snippet"}]
        with patch("ddg_web_search._client_options", return_value={"proxy": "http://proxy:8080", "verify": "trusted.pem"}):
            web_search("example")
        self.assertEqual(FakeDDGS.clients, [
            {"timeout": 15, "proxy": "http://proxy:8080", "verify": "trusted.pem"},
            {"timeout": 10, "proxy": "http://proxy:8080", "verify": "trusted.pem"},
        ])

    def test_main_outputs_unicode_results_with_legacy_windows_encoding(self):
        results = [{"title": "高德地图 ⌘", "url": "https://example.com", "body": "中文结果"}]
        output = io.BytesIO()
        stdout = io.TextIOWrapper(output, encoding="cp1252")
        with patch("ddg_web_search.web_search", return_value=results):
            with patch.object(sys, "argv", ["ddg_web_search.py", '{"query":"example"}']):
                with patch.object(sys, "stdout", stdout):
                    self.assertEqual(main(), 0)
                stdout.flush()
        self.assertEqual(
            json.loads(output.getvalue().decode("cp1252"))[0]["title"],
            "高德地图 ⌘",
        )

    def test_search_extracts_top_three_pages_and_preserves_snippets_on_failure(self):
        FakeDDGS.text_rows = [
            {"title": f"Title {index}", "href": f"https://example.com/{index}", "body": f"Snippet {index}"}
            for index in range(4)
        ]
        FakeDDGS.pages = {
            "https://example.com/0": "Home | About | Contact\nUseful page content.\nCookie policy",
            "https://example.com/1": RuntimeError("HTTP 503"),
            "https://example.com/2": "page " * 1_100,
        }

        results = web_search("example", max_results=4)

        self.assertEqual(results[0]["body"], "Useful page content.")
        self.assertEqual(results[1]["body"], "Snippet 1")
        self.assertEqual(len(results[2]["body"]), 5_000)
        self.assertEqual(results[3]["body"], "Snippet 3")
        extracts = [call for call in FakeDDGS.calls if call[0] == "extract"]
        self.assertEqual(len(extracts), 3)
        self.assertTrue(all(call[2] == "text_plain" for call in extracts))

    def test_news_defaults_to_week_and_falls_back_to_text(self):
        FakeDDGS.news_rows = []
        FakeDDGS.text_rows = [{"title": "Article", "href": "https://example.com", "body": "snippet"}]
        FakeDDGS.pages = {"https://example.com": RuntimeError("blocked")}

        results = web_search("example", category="news")

        self.assertEqual(results[0]["title"], "Article")
        self.assertEqual(results[0]["body"], "snippet")
        self.assertEqual(FakeDDGS.calls[0][0], "news")
        self.assertEqual(FakeDDGS.calls[0][2]["timelimit"], "w")
        self.assertEqual(FakeDDGS.calls[1][0], "text")

    def test_validates_search_arguments(self):
        with self.assertRaisesRegex(ValueError, "query must not be empty"):
            web_search("  ")
        with self.assertRaisesRegex(ValueError, "category"):
            web_search("example", category="images")
        with self.assertRaisesRegex(ValueError, "max_results"):
            web_search("example", max_results=21)


if __name__ == "__main__":
    unittest.main()
