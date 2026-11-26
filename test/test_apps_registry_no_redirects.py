"""Registry git fetches reach only the host the clone-host check approved.

A real ``git`` child talks to a loopback server that answers 302 to a second
loopback server. A gateway registry fetch must not follow it, so the second server
gets no request, and the install error tells the owner to list the repository's
current URL. The operator's own ``kirocrew app install <url>`` keeps git's default
and still follows the redirect.
"""

from __future__ import annotations

import http.server
import shutil
import subprocess
import threading

import pytest
from apps_registry_helpers import _catalog_absent  # noqa: F401 - fixture
from apps_registry_helpers import _explicit_registry_execution_admission  # noqa: F401 - fixture
from apps_registry_helpers import unsandboxed_spawn  # noqa: F401 - fixture

from kiro_crew.apps import git_install, registry
from kiro_crew.apps.registry_pipeline import checkout, manifests
from kiro_crew.apps.registry_pipeline.checkout import (
    _HOOKS_NEUTRALIZER_ARGV,
    _reused_checkout_redirect_config,
)
from kiro_crew.apps.registry_pipeline.git_targets import _redirect_refusal_argv
from kiro_crew.apps.registry_pipeline.subprocess_env import anonymous_git_env
from kiro_crew.testing.wait import FALLBACK_TIMEOUT_SECS

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="needs git")


class _Recorder(http.server.BaseHTTPRequestHandler):
    status = 404
    location = ""
    paths: list[str]

    def do_GET(self):  # noqa: N802 - http.server API
        self.paths.append(self.path)
        self.send_response(self.status)
        if self.location:
            self.send_header("Location", self.location + self.path)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture
def redirecting(monkeypatch):
    """``(first_url, first_paths, second_url, second_paths)``; the first 302s to the second."""
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    servers = []

    def serve(status, location=""):
        handler = type("_H", (_Recorder,), {"status": status, "location": location, "paths": []})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}", handler.paths

    second, second_paths = serve(404)
    first, first_paths = serve(302, second)
    yield f"{first}/owner/demo.git", first_paths, second, second_paths
    for server in servers:
        server.shutdown()


def _ls_remote(config_argv, url: str, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *config_argv, "ls-remote", url],
        capture_output=True,
        env=anonymous_git_env(),
        cwd=cwd,
        timeout=FALLBACK_TIMEOUT_SECS,
    )


def test_the_registry_git_argv_does_not_follow_a_redirect(redirecting, tmp_path):
    first_url, first_paths, _second, second_paths = redirecting

    result = _ls_remote(_HOOKS_NEUTRALIZER_ARGV, first_url, tmp_path)

    assert result.returncode != 0
    assert first_paths
    assert second_paths == []


def test_a_repo_config_allowing_redirects_is_overridden(redirecting, tmp_path):
    # An existing checkout whose own .git/config turns redirects back on: git lets
    # a URL-specific http.<url>.followRedirects=true beat the generic refusal, so
    # the per-URL override must win on the reused-checkout pull.
    first_url, first_paths, _second, second_paths = redirecting
    checkout_dir = tmp_path / "checkout"
    env = anonymous_git_env()
    subprocess.run(["git", "init", "-q", str(checkout_dir)], env=env, timeout=FALLBACK_TIMEOUT_SECS)
    subprocess.run(
        ["git", "-C", str(checkout_dir), "config", f"http.{first_url}.followRedirects", "true"],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    subprocess.run(
        ["git", "-C", str(checkout_dir), "remote", "add", "origin", first_url],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )

    # Generic refusal alone: the repo config wins and git follows the redirect.
    subprocess.run(
        ["git", "-c", "http.followRedirects=false", "-C", str(checkout_dir), "fetch", "origin"],
        capture_output=True,
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    assert second_paths, "the repo config should defeat the generic refusal (the bug)"
    second_paths.clear()

    # The gateway's full registry argv, which adds the per-URL override.
    argv = ["git", *_HOOKS_NEUTRALIZER_ARGV, *_redirect_refusal_argv(first_url)]
    subprocess.run(
        [*argv, "-C", str(checkout_dir), "fetch", "origin"],
        capture_output=True,
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    assert second_paths == []


def test_a_username_bearing_repo_config_is_overridden(redirecting, tmp_path):
    # Git ranks a username-bearing http.<user@url>.followRedirects=true above a
    # username-free -c key, and the credentialed fetch URL carries the username.
    # The per-URL override must also pin the username-bearing form.
    first_url, first_paths, _second, second_paths = redirecting
    scheme, _, rest = first_url.partition("://")
    cred_url = f"{scheme}://tokuser@{rest}"  # username only, no password
    checkout_dir = tmp_path / "checkout"
    env = anonymous_git_env()
    subprocess.run(["git", "init", "-q", str(checkout_dir)], env=env, timeout=FALLBACK_TIMEOUT_SECS)
    subprocess.run(
        ["git", "-C", str(checkout_dir), "config", f"http.{cred_url}.followRedirects", "true"],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    subprocess.run(
        ["git", "-C", str(checkout_dir), "remote", "add", "origin", cred_url],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    # Username-free refusal alone: the username key wins and git follows the 302.
    subprocess.run(
        [
            "git",
            "-c",
            "http.followRedirects=false",
            *_redirect_refusal_argv(first_url),
            "-C",
            str(checkout_dir),
            "fetch",
            "origin",
        ],
        capture_output=True,
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    assert second_paths, "the username key should defeat the username-free refusal (the bug)"
    second_paths.clear()
    # The full override, which pins the username-bearing form too.
    argv = ["git", *_HOOKS_NEUTRALIZER_ARGV, *_redirect_refusal_argv(first_url, cred_url)]
    subprocess.run(
        [*argv, "-C", str(checkout_dir), "fetch", "origin"],
        capture_output=True,
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    assert second_paths == []


def test_a_reused_checkout_redirect_config_is_detected(tmp_path):
    import asyncio

    env = anonymous_git_env()
    checkout_dir = tmp_path / "c"
    subprocess.run(["git", "init", "-q", str(checkout_dir)], env=env, timeout=FALLBACK_TIMEOUT_SECS)

    def scan():
        return asyncio.run(_reused_checkout_redirect_config(checkout_dir))

    # No entry: nothing to refuse.
    assert scan() is None
    # followRedirects=false is the safe value and must not refuse.
    subprocess.run(
        ["git", "-C", str(checkout_dir), "config", "http.followRedirects", "false"],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    assert scan() is None
    # Any non-false entry, under any key spelling, is flagged.
    subprocess.run(
        [
            "git",
            "-C",
            str(checkout_dir),
            "config",
            "http.https://h.example/o/r.followRedirects",
            "true",
        ],
        env=env,
        timeout=FALLBACK_TIMEOUT_SECS,
    )
    flagged = scan()
    assert flagged is not None and flagged.endswith("=true")


def test_the_cli_install_argv_still_follows_a_redirect(redirecting, tmp_path):
    first_url, first_paths, _second, second_paths = redirecting
    # The CLI allows only https and ssh; open http for this loopback server alone,
    # keeping every other pair the CLI passes.
    config_argv = [*git_install._git_config_argv(), "-c", "protocol.http.allow=always"]

    _ls_remote(config_argv, first_url, tmp_path)

    assert first_paths
    assert second_paths  # git followed the redirect, as a plain ``git clone`` does


@pytest.mark.asyncio
async def test_the_listing_manifest_fetch_does_not_follow_a_redirect(redirecting, monkeypatch):
    first_url, first_paths, _second, second_paths = redirecting
    # The first host passes the clone-host check; the one it redirects to would not.
    monkeypatch.setattr(manifests, "is_clone_host_trusted", lambda url: True)

    async def _passthrough(argv, **_kw):
        return argv, None

    monkeypatch.setattr(manifests, "wrap_argv_async", _passthrough)
    monkeypatch.setattr(manifests, "cgroup_scope_argv", lambda argv: argv)

    result = await manifests._fetch_app_manifest("owner/demo", "main", git_url=first_url)

    assert result is None
    assert first_paths
    assert second_paths == []


@pytest.mark.asyncio
async def test_the_install_clone_says_to_list_the_current_url(redirecting, monkeypatch, tmp_path):
    first_url, first_paths, _second, second_paths = redirecting
    monkeypatch.setattr(checkout, "is_clone_host_trusted", lambda url: True, raising=False)
    log: list[str] = []

    result = await registry._git_clone_or_pull(
        first_url, "main", tmp_path / "demo", log, index_originated=True
    )

    assert result is not None and result["ok"] is False
    assert "the server redirects" in result["error"]
    assert "list the repository's current URL in the registry" in result["error"]
    assert second_paths == []
