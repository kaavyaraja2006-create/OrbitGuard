"""Phase 8: the experiment framework produces reproducible, complete, machine-readable results."""

from orbitguard_engine.experiments import EXPERIMENTS, make_scenario, run_experiment, to_csv


def test_scenarios_are_seeded_and_labelled():
    a, b = make_scenario(3), make_scenario(3)
    assert a["specs"] == b["specs"] and a["label"].startswith("SYNTHETIC")
    assert make_scenario(4)["specs"] != a["specs"]


def test_e4_runs_and_is_reproducible():
    r1 = run_experiment("E4", seeds=1)
    r2 = run_experiment("E4", seeds=1)
    assert {s["method"] for s in r1["summary"]} == {"none", "fixed", "proposed"}
    none = next(r for r in r1["runs"] if r["method"] == "none")
    assert none["dv_ms"] == 0 and none["violations_after"] >= 1  # the scenario really is dangerous
    for a, b in zip(r1["runs"], r2["runs"]):
        assert a["dv_ms"] == b["dv_ms"] and a["min_sep_m"] == b["min_sep_m"] and a["p_violation_independent"] == b["p_violation_independent"]
    csv = to_csv(r1)
    assert csv.splitlines()[0].startswith("group,method,seed") and len(csv.splitlines()) == 1 + len(r1["runs"])
    assert set(EXPERIMENTS) == {f"E{i}" for i in range(1, 9)}
