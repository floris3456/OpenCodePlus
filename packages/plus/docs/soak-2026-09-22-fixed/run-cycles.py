#!/usr/bin/env python3
"""Re-soak cycle runner for the 2026-09-22 soak-defect round.

Drives the pinned soak driver (driver.ts, byte-identical to ae2e1f7f2 per D5)
against an isolated tui-lab. Every cycle is a real model-backed lifecycle on
cliproxyapi/gpt-5.6-luna: delegate -> (child: get_context/edit/check/checkpoint/
finish) -> wait -> integrate. Supports single, two-in-flight pair, and
stop-and-redelegate cycles.

Full per-cycle driver JSON lands in cycles/; stdout stays one line per cycle.
The lab password is read from the environment and never printed or stored.
"""
import json, os, subprocess, sys, threading, time, urllib.request, base64
from datetime import datetime, timezone

LAB = os.environ["RESOAK_LAB"]
PLUS = "/home/bliss/OpenCodePlus/worktrees/team-development-models/main-dfab24151c77df69/opencode/packages/plus"
EVID = os.path.join(PLUS, "docs/soak-2026-09-22-fixed")
OUT = os.environ.get("RESOAK_OUT", EVID)
CYCLES = os.path.join(OUT, "cycles")
RECEIPTS = os.path.join(OUT, "receipts")
SOURCE_HEAD = os.environ.get("RESOAK_SOURCE_HEAD", "")
TEAMS = os.path.join(LAB, "data/opencode/opencodeplus/teams")
DRIVER = "docs/soak-2026-09-22-fixed/driver.ts"
PARENT_SESSION = os.environ["RESOAK_PARENT_SESSION"]
PARENT_RUN = os.environ["RESOAK_PARENT_RUN"]
PORT = open(os.path.join(LAB, "port")).read().strip()
BASE_URL = "http://127.0.0.1:" + PORT
PW = os.environ["OPENCODEPLUS_LAB_PASSWORD"]

def now(): return datetime.now(timezone.utc).isoformat()

def drive(commands, tag, timeout=900):
    cmd = ["bun", DRIVER, "--lab-home", LAB, "--base-url", BASE_URL,
           "--parent-session", PARENT_SESSION, "--parent-run", PARENT_RUN,
           "--parent-role", "sol-orchestrator",
           "--command", json.dumps({"commands": commands})]
    started = now(); t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=PLUS, capture_output=True, text=True, timeout=timeout)
        out = p.stdout
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "driver timeout", "tag": tag, "started": started, "ended": now()}
    # driver prints a non-JSON WARN preamble; scan candidate offsets
    j = None; i = out.find("{")
    while i >= 0:
        try: j = json.loads(out[i:]); break
        except Exception: i = out.find("{", i + 1)
    if j is None: j = {"ok": False, "error": out[-2000:]}
    j["tag"] = tag; j["started"] = started; j["ended"] = now(); j["driverActiveSec"] = round(time.time()-t0, 1)
    return j

def merge_record(entry):
    if not entry: return None
    p = os.path.join(TEAMS, "runs", PARENT_RUN, "merge", str(entry) + ".json")
    return json.load(open(p)) if os.path.exists(p) else None

def record(run_id):
    p = os.path.join(TEAMS, "runs", run_id, "run.json")
    return json.load(open(p)) if os.path.exists(p) else None

def session_model(session_id):
    req = urllib.request.Request(BASE_URL + "/api/session/" + session_id + "/context",
        headers={"Authorization": "Basic " + base64.b64encode(("opencode:"+PW).encode()).decode(),
                 "x-opencode-directory": os.path.join(LAB, "proj")})
    try:
        b = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
    except Exception as e:
        return {"error": str(e)[:80]}
    found = [None]
    def walk(o):
        if isinstance(o, dict):
            m = o.get("model")
            if isinstance(m, dict) and m.get("id"): found[0] = m
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(b)
    return found[0]

def save(name, obj):
    os.makedirs(CYCLES, exist_ok=True)
    with open(os.path.join(CYCLES, name), "w") as f: json.dump(obj, f, indent=2)

def brief(n, role, rid=None, keep_working=False, extra=None):
    if keep_working:
        obj = ("Write exactly `cycle %02d provisional` and a trailing newline to notes/%02d.md, "
               "run the scratch-ok check, checkpoint `docs(soak): provisional cycle %02d`; after the "
               "checkpoint do NOT call team_finish and do not go idle. In the same turn keep working: "
               "read and privately summarise src/teams/api.ts, worktree.ts, lifecycle.ts, tools.ts and "
               "schema.ts one after another." % (n, n, n))
    else:
        obj = ("Write exactly `cycle %02d` and a trailing newline to notes/%02d.md, run the scratch-ok "
               "check, checkpoint `docs(soak): cycle %02d`, then call team_finish with status done."
               % (n, n, n))
    b = {"requestID": rid or ("resoak-c%02d-a" % n), "role": role, "objective": obj,
         "deliverable": {"kind": "commit"}, "scope": {"paths": ["notes/*"]},
         "checks": [{"id": "scratch-ok", "argv": ["bun", "test", "./scratch/ok.test.ts"]}],
         "effort": "small"}
    if extra: b.update(extra)
    return b

def summarize(n, kind, j, run_id=None, extra=None):
    """Derive this cycle's verdict from THIS run's own receipts only.

    waitHandler returns when ANY requested run settles, and a shared tail can
    carry another child's receipts, so a row is only `done`/`landed` when the
    settled entry and the integrate both name this run.
    """
    blob = json.dumps(j)
    realpath = "FileSystem.realPath" in blob
    bounds = "E_BOUNDS" in blob
    child = run_id or (j.get("child") or {}).get("run")
    status = None
    for r in j.get("results", []):
        if r.get("tool") == "wait":
            for s2 in (r.get("output") or {}).get("settled") or []:
                if s2.get("run") == child:
                    status = (s2.get("report") or {}).get("status")
    # integrate.output is {entry,state,head}; the per-child proof is the merge
    # receipt that entry names. Require it to name THIS child, be landed, and
    # agree with the head integrate reported.
    landed = False
    merge_receipt = None
    for r in j.get("results", []):
        if r.get("tool") != "integrate" or not r.get("ok"):
            continue
        o = r.get("output") or {}
        rec = merge_record(o.get("entry"))
        if (rec and rec.get("childRun") == child and rec.get("state") == "landed"
                and rec.get("landedHead") == o.get("head")):
            landed = True
            merge_receipt = rec
            break
    def _t(v):
        from datetime import datetime
        try: return datetime.fromisoformat(v).timestamp()
        except Exception: return None
    a, b = _t(j.get("started")), _t(j.get("ended"))
    wall = round(b - a, 1) if (a is not None and b is not None) else None
    flags = [x for x, c in (("REALPATH", realpath), ("E_BOUNDS", bounds)) if c]
    row = {"cycle": n, "kind": kind, "ok": bool(j.get("ok")), "child": child, "report": status,
           "landed": landed, "realpath": realpath, "bounds": bounds,
           "started": j.get("started"), "ended": j.get("ended"), "driverActiveSec": j.get("driverActiveSec"), "wallElapsedSec": wall}
    if merge_receipt: row["mergeReceipt"] = merge_receipt
    if extra: row.update(extra)
    sess = (j.get("child") or {}).get("session") or (extra or {}).get("session")
    if sess: row["model"] = session_model(sess)
    row["verified"] = bool(status == "done" and landed)
    # Durable per-cycle export written NOW, not at the end: the merge receipt
    # itself, this child's own settled entry, the source head and the model.
    settled_entry = None
    integrate_out = None
    for r in j.get("results", []):
        if r.get("tool") == "wait":
            for s2 in (r.get("output") or {}).get("settled") or []:
                if s2.get("run") == child: settled_entry = s2
        if r.get("tool") == "integrate" and r.get("ok"): integrate_out = r.get("output")
    os.makedirs(RECEIPTS, exist_ok=True)
    with open(os.path.join(RECEIPTS, "cycle-%02d.json" % n), "w") as f:
        json.dump({"cycle": n, "kind": kind, "childRun": child, "sourceHead": SOURCE_HEAD,
                   "model": row.get("model"), "settled": settled_entry,
                   "integrate": integrate_out, "mergeReceipt": merge_receipt,
                   "started": j.get("started"), "ended": j.get("ended"),
                   "wallElapsedSec": wall, "driverActiveSec": j.get("driverActiveSec"),
                   "verified": row["verified"]}, f, indent=2)
    print("cycle %02d [%s] child=%s report=%s landed=%s verified=%s wall=%ss %s" %
          (n, kind, child, status, landed, row["verified"], wall, " ".join(flags)), flush=True)
    return row

def single(n, role, extra=None):
    j = drive([{"tool": "delegate", "as": "parent", "input": brief(n, role, extra=extra)},
               {"tool": "wait", "as": "parent", "input": {"timeoutMs": 600000}},
               {"tool": "integrate", "as": "parent", "input": {}}], "cycle-%02d" % n)
    save("cycle-%02d.json" % n, j)
    return summarize(n, "single", j, run_id=(j.get("child") or {}).get("run"))

def pair(a, b, role_a, role_b):
    """Dispatch two delegates simultaneously, then settle and integrate each
    child against its own wait and its own integrate."""
    res = {}
    def go(n, role):
        res[n] = drive([{"tool": "delegate", "as": "parent", "input": brief(n, role)}], "cycle-%02d-delegate" % n)
    ta = threading.Thread(target=go, args=(a, role_a)); tb = threading.Thread(target=go, args=(b, role_b))
    ta.start(); tb.start(); ta.join(); tb.join()
    out = []
    for n in (a, b):
        info = res[n].get("child") or {}
        run = info.get("run")
        if not run:
            save("cycle-%02d.json" % n, {"delegate": res[n]})
            out.append(summarize(n, "pair", res[n], run_id=None,
                                 extra={"dispatchedAt": res[n].get("started"), "note": "delegate produced no run"}))
            continue
        tail = drive([{"tool": "wait", "as": "parent", "input": {"runs": [run], "timeoutMs": 600000}},
                      {"tool": "integrate", "as": "parent", "input": {"run": run}}],
                     "cycle-%02d-tail" % n)
        save("cycle-%02d.json" % n, {"delegate": res[n], "tail": tail})
        combo = dict(res[n])
        combo["results"] = (res[n].get("results") or []) + (tail.get("results") or [])
        combo["ok"] = bool(res[n].get("ok")) and bool(tail.get("ok"))
        # wall time spans this child's dispatch to its own integration finishing;
        # the driver-call sum is kept separately and never called wall time.
        combo["started"] = res[n].get("started")
        combo["ended"] = tail.get("ended")
        combo["driverActiveSec"] = round((res[n].get("driverActiveSec") or 0) + (tail.get("driverActiveSec") or 0), 1)
        out.append(summarize(n, "pair", combo, run_id=run,
                             extra={"dispatchedAt": res[n].get("started"), "session": info.get("session")}))
    return out

def stopcycle(n, role):
    """Qualifying stop: child must be `working` with head != base before stop."""
    d = drive([{"tool": "delegate", "as": "parent",
                "input": brief(n, role, rid="resoak-c%02d-orig" % n, keep_working=True)}],
              "cycle-%02d-original" % n)
    orig = (d.get("child") or {}).get("run")
    pre = {"state": None, "head": None, "base": None, "qualifying": False}
    if orig:
        for _ in range(120):
            r = record(orig)
            if r and r.get("state") == "working" and r.get("head") and r.get("head") != r.get("base"):
                pre = {"state": r["state"], "head": r["head"], "base": r["base"], "qualifying": True}
                break
            time.sleep(1)
        else:
            r = record(orig) or {}
            pre = {"state": r.get("state"), "head": r.get("head"), "base": r.get("base"), "qualifying": False}
    st = drive([{"tool": "stop", "as": "parent", "input": {"run": orig}},
                {"tool": "supersede", "as": "parent",
                 "input": {"run": orig, "reason": "stop-and-redelegate soak cycle %02d" % n}}],
               "cycle-%02d-stop" % n)
    rep = drive([{"tool": "delegate", "as": "parent",
                  "input": brief(n, role, rid="resoak-c%02d-repl" % n)},
                 {"tool": "wait", "as": "parent", "input": {"timeoutMs": 600000}},
                 {"tool": "integrate", "as": "parent", "input": {}}], "cycle-%02d-replacement" % n)
    save("cycle-%02d.json" % n, {"original": d, "preStop": pre, "stop": st, "replacement": rep})
    post = record(orig) or {}
    return summarize(n, "stop+redelegate", rep, run_id=(rep.get("child") or {}).get("run"),
                     extra={"originalRun": orig, "preStop": pre, "originalFinalState": post.get("state")})

def main():
    plan = json.loads(sys.argv[1]); results = []
    for step in plan:
        k = step["kind"]
        if k == "single": results.append(single(step["n"], step["role"], step.get("extra")))
        elif k == "pair": results.extend(pair(step["a"], step["b"], step["role_a"], step["role_b"]))
        elif k == "stop": results.append(stopcycle(step["n"], step["role"]))
        time.sleep(1)
    path = os.path.join(OUT, "summary-%d.json" % int(time.time()))
    with open(path, "w") as f: json.dump(results, f, indent=2)
    print("DONE " + json.dumps({"cycles": len(results),
        "realpath": sum(1 for r in results if r["realpath"]),
        "bounds": sum(1 for r in results if r["bounds"]),
        "landed": sum(1 for r in results if r["landed"]),
        "verified": sum(1 for r in results if r.get("verified")),
        "summary": os.path.basename(path)}))

if __name__ == "__main__": main()
