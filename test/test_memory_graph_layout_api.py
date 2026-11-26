"""The memory graph routes over every memory in a store, and the upkeep behind them."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from member_memory_helpers import env as _member_env
from member_memory_helpers import request

from kiro_crew import memory_graph_files, memory_graph_service
from kiro_crew.dashboard.handlers import memory_edit
from kiro_crew.dashboard.handlers import memory_graph_layout_api as api
from kiro_crew.testing import synthetic_credentials

env = _member_env
pytestmark = pytest.mark.xdist_group("member_memory_api")

EVERYWHERE = "-1e9,-1e9,1e9,1e9"
STORES = ["default", "member-alice"]


def _tier(env, name):
    return env.tiers["" if name == "default" else name]


async def _get(env, handler, store, **query):
    response = await handler(request(env, query={"store": store, **query}, owner=True))
    assert response.status == 200, response.text
    return json.loads(response.text)


async def _ready(env, store):
    """The overview once the first build is in, waiting for the build child."""
    # One build at most, waited on for under half the per-test timeout; the reset
    # fixture kills a child that stalls past it.
    for _ in range(2):
        body = await _get(env, api.api_memory_graph_overview, store)
        if body["status"] == memory_graph_service.STATUS_READY:
            return body
        graph = memory_graph_service.graph_for(Path(_tier(env, store)._db_path))
        await asyncio.to_thread(graph.wait_for_build, 50)
    raise AssertionError("the layout never became ready")


def _seed(tier, n, word="zebra", every=1):
    for i in range(n):
        text = f"note {i} about {word}" if i % every == 0 else f"note {i} about otters"
        assert tier.set_semantic(f"user.n{i}", text, 0.9, "user_explicit") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_overview_counts_every_memory_in_the_store(env, name):
    _seed(_tier(env, name), 30)
    body = await _ready(env, name)
    assert body["totals"].get("fact", 0) == 30
    assert sum(c["count"] for c in body["clusters"]) == 30


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_search_finds_every_match_none_of_them_loaded(env, name):
    _seed(_tier(env, name), 300, every=6)
    await _ready(env, name)

    body = await _get(env, api.api_memory_graph_search, name, q="zebra")

    assert body["total"] == 50
    assert {m["id"] for m in body["matches"]} == {f"user.n{i}" for i in range(0, 300, 6)}
    assert all(isinstance(m["x"], float) and isinstance(m["y"], float) for m in body["matches"])


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_box_select_counts_nodes_never_loaded_and_the_list_shows_them(env, name):
    _seed(_tier(env, name), 120)
    await _ready(env, name)
    page = await _get(env, api.api_memory_graph_nodes, name, bbox=EVERYWHERE, limit="5")
    assert len(page["nodes"]) == 5

    selected = await _get(env, api.api_memory_graph_select, name, bbox=EVERYWHERE)
    assert selected["count"] == 120

    listed = await memory_edit.api_memory_records(
        request(env, query={"store": name, "box": EVERYWHERE, "limit": "100"}, owner=True)
    )
    assert listed.status == 200, listed.text
    assert json.loads(listed.text)["total"] == 120


@pytest.mark.asyncio
async def test_a_box_lists_only_the_records_inside_it(env):
    name = "member-alice"
    _seed(_tier(env, name), 40)
    await _ready(env, name)
    page = await _get(env, api.api_memory_graph_nodes, name, bbox=EVERYWHERE)
    one = page["nodes"][0]
    box = f"{one['x'] - 1e-6},{one['y'] - 1e-6},{one['x'] + 1e-6},{one['y'] + 1e-6}"

    listed = await memory_edit.api_memory_records(
        request(env, query={"store": name, "box": box}, owner=True)
    )
    body = json.loads(listed.text)
    assert [e["id"] for e in body["entries"]] == [one["id"]]


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_box_pages_cover_every_node(env, name):
    _seed(_tier(env, name), 75)
    await _ready(env, name)
    seen, cursor = [], None
    for _ in range(75):
        query = {"bbox": EVERYWHERE, "limit": "20", **({"cursor": cursor} if cursor else {})}
        page = await _get(env, api.api_memory_graph_nodes, name, **query)
        seen += [n["id"] for n in page["nodes"]]
        cursor = page["cursor"]
        if cursor is None:
            break
    assert cursor is None
    assert sorted(seen) == sorted(f"user.n{i}" for i in range(75))


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_new_and_forgotten_memories_reach_the_graph_without_a_rebuild(env, name):
    tier = _tier(env, name)
    _seed(tier, 30)
    await _ready(env, name)
    graph = memory_graph_service.graph_for(Path(tier._db_path))
    built_at = graph.sidecar.meta()["built_at"]

    assert tier.set_semantic("user.late", "arrived after the build", 0.9, "user_explicit") is None
    tier.delete_semantic("user.n3", "user_explicit")
    await _get(env, api.api_memory_graph_overview, name)

    ids = set(graph.sidecar.ids_in_box((-1e9, -1e9, 1e9, 1e9)))
    assert "user.late" in ids and "user.n3" not in ids
    assert graph.sidecar.meta()["built_at"] == built_at


@pytest.mark.asyncio
async def test_a_secret_across_the_label_cut_is_redacted_whole(env):
    name = "member-alice"
    token = synthetic_credentials.github_classic()
    # The label is "user.secret = <text>": the token starts at character 87 of
    # it, so a cut at 120 before redaction would leave 33 of its characters.
    text = "x" * 72 + " " + token + " tail"
    assert tier_write(_tier(env, name), "user.secret", text)
    await _ready(env, name)

    page = await _get(env, api.api_memory_graph_nodes, name, bbox=EVERYWHERE)
    label = next(n["label"] for n in page["nodes"] if n["id"] == "user.secret")
    assert token[4:30] not in label
    assert len(label) <= memory_graph_files.LABEL_CHARS


def tier_write(tier, key: str, value: str) -> bool:
    return tier.set_semantic(key, value, 0.9, "user_explicit") is None


@pytest.mark.asyncio
async def test_a_write_during_the_reconcile_after_a_rebuild_reaches_the_graph(env, monkeypatch):
    name = "member-alice"
    tier = _tier(env, name)
    _seed(tier, 30)
    await _ready(env, name)
    graph = memory_graph_service.graph_for(Path(tier._db_path))
    monkeypatch.setattr(memory_graph_service.gl, "REBUILD_DRIFT", -1.0)
    await _get(env, api.api_memory_graph_overview, name)  # starts a full rebuild
    await asyncio.to_thread(graph.wait_for_build, 50)

    real = graph._reconcile
    calls = []

    def reconcile_then_write(*args):
        real(*args)
        if not calls:
            calls.append(1)
            assert (
                tier.set_semantic("user.mid", "written mid-reconcile", 0.9, "user_explicit") is None
            )

    monkeypatch.setattr(graph, "_reconcile", reconcile_then_write)
    await _get(env, api.api_memory_graph_overview, name)  # adopts the build
    assert calls
    await _get(env, api.api_memory_graph_overview, name)

    assert "user.mid" in set(graph.sidecar.ids_in_box((-1e9, -1e9, 1e9, 1e9)))


class _HeldBuild:
    """A rebuild child that has not exited yet, until it is killed."""

    def __init__(self):
        self.killed = False

    def poll(self):
        return -9 if self.killed else None

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return None


@pytest.mark.asyncio
async def test_the_old_layout_serves_during_a_rebuild_and_forgetting_it_ends_the_build(
    env, monkeypatch
):
    name = "member-alice"
    tier = _tier(env, name)
    _seed(tier, 30)
    await _ready(env, name)
    monkeypatch.setattr(memory_graph_service.gl, "REBUILD_DRIFT", -1.0)
    monkeypatch.setattr(memory_graph_service.gl, "spawn_rebuild", lambda *_a: _HeldBuild())

    assert (
        tier.set_semantic("user.late", "arrived during the rebuild", 0.9, "user_explicit") is None
    )
    for _ in range(2):
        body = await _get(env, api.api_memory_graph_overview, name)
        assert body["status"] == memory_graph_service.STATUS_READY
        assert body["totals"]["fact"] == 31
    graph = memory_graph_service.graph_for(Path(tier._db_path))
    held, out = graph._build.proc, graph._build.out
    assert isinstance(held, _HeldBuild)
    out.write_bytes(b"half a build")

    memory_graph_service.forget_graphs()

    assert held.killed
    assert not out.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", STORES)
async def test_a_node_opens_its_own_record_in_the_list(env, name):
    tier = _tier(env, name)
    _seed(tier, 5)
    assert tier.write_episodic("a lesson-free experience", tags=["t"], defer_embedding=True)
    await _ready(env, name)
    page = await _get(env, api.api_memory_graph_nodes, name, bbox=EVERYWHERE)
    for node in page["nodes"]:
        listed = await memory_edit.api_memory_records(
            request(env, query={"store": name, "ref": node["ref"]}, owner=True)
        )
        entries = json.loads(listed.text)["entries"]
        assert [(e["kind"], e["id"]) for e in entries] == [
            (node["record"]["kind"], node["record"]["id"])
        ]


@pytest.mark.asyncio
async def test_node_labels_are_the_memory_text(env):
    name = "member-alice"
    assert (
        _tier(env, name).set_semantic("user.pet", "alice has a cat", 0.9, "user_explicit") is None
    )
    await _ready(env, name)
    page = await _get(env, api.api_memory_graph_nodes, name, bbox=EVERYWHERE)
    assert [n["label"] for n in page["nodes"]] == ["user.pet = alice has a cat"]


def _age(tier, text: str, days: int) -> None:
    """Backdate the experience *text* by *days* in the table its store keeps it in."""
    row = next(r for r in tier.get_episodic_list(limit=10) if r["text"] == text)
    table = "memory_items" if tier.algorithm_version == "v2" else "episodic_memories"
    when = (datetime.now(tz=timezone.utc) - timedelta(days=days)).isoformat()
    with tier._db_lock:
        tier.db.execute(f"UPDATE {table} SET created_at = ? WHERE id = ?", (when, row["id"]))
        tier.db.commit()


@pytest.mark.asyncio
async def test_experiences_fade_by_their_recall_weight(env):
    tier = _tier(env, "default")
    assert tier.algorithm_version == "v1"
    assert tier.write_episodic("fresh memory", tags=["t"], defer_embedding=True)
    assert tier.write_episodic("old memory", tags=["t"], defer_embedding=True)
    _age(tier, "old memory", 90)
    await _ready(env, "default")

    page = await _get(env, api.api_memory_graph_nodes, "default", bbox=EVERYWHERE, kind="episode")
    weight = {n["label"]: n["weight"] for n in page["nodes"]}
    assert weight["old memory"] < weight["fresh memory"] <= 1.0


@pytest.mark.asyncio
async def test_a_v2_store_draws_no_experience_faded(env):
    tier = _tier(env, "member-alice")
    assert tier.algorithm_version == "v2"
    assert tier.write_episodic("fresh memory", tags=["t"], defer_embedding=True)
    assert tier.write_episodic("old memory", tags=["t"], defer_embedding=True)
    _age(tier, "old memory", 90)
    await _ready(env, "member-alice")

    page = await _get(
        env, api.api_memory_graph_nodes, "member-alice", bbox=EVERYWHERE, kind="episode"
    )
    assert {n["label"]: n["weight"] for n in page["nodes"]} == {
        "old memory": 1.0,
        "fresh memory": 1.0,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query",
    [{"bbox": "1,2,3"}, {"bbox": "a,b,c,d"}, {"bbox": EVERYWHERE, "kind": "people"}],
)
async def test_malformed_queries_are_refused(env, query):
    response = await api.api_memory_graph_nodes(
        request(env, query={"store": "member-alice", **query}, owner=True)
    )
    assert response.status == 400


@pytest.mark.asyncio
async def test_a_non_owner_cannot_read_the_graph(env):
    for handler in (
        api.api_memory_graph_overview,
        api.api_memory_graph_nodes,
        api.api_memory_graph_search,
        api.api_memory_graph_select,
    ):
        response = await handler(request(env, query={"store": "member-alice", "bbox": EVERYWHERE}))
        assert response.status == 403
