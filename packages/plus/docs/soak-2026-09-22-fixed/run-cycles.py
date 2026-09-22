#!/usr/bin/env python3
"""Re-soak cycle runner for the 2026-09-22 soak-defect round.

Drives the committed soak driver (driver.ts, copied unchanged from ae2e1f7f2)
against the isolated `resoak` tui-lab. Every cycle is a real model-backed
lifecycle: delegate -> (child: get_context/edit/check/checkpoint/finish on
cliproxyapi/gpt-5.6-luna) -> wait -> integrate.

Full per-cycle driver JSON lands in cycles/; stdout stays one line per cycle.
The lab password is read from the environment and never printed or stored.
"""
import json, os, subprocess, sys, threading, time
from datetime import datetime, timezone

LAB = "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-resoak"
PLUS = "/home/bliss/OpenCodePlus/worktrees/team-development-models/main-dfab24151c77df69/opencode/packages/plus"
EVID = os.path.join(PLUS, "docs/soak-2026-09-22-fixed")
CYCLES = os.path.join(EVID, "cycles")
DRIVER = "docs/soak-2026-09-22-fixed/driver.ts"
PARENT_SESSION = os.environ["RESOAK_PARENT_SESSION"]
PARENT_RUN = os.environ["RESOAK_PARENT_RUN"]
BASE_URL = "http://127.0.0.1:" + open(os.path.join(LAB, "port")).read().strip()

def now(): return datetime.now(timezone.utc).isoformat()

def drive(commands, tag, timeout=900):
    cmd = ["bun", DRIVER, "--lab-home", LAB, "--base-url", BASE_URL,
           "--parent-session", PARENT_SESSION, "--parent-run", PARENT_RUN,
           "--parent-role", "sol-orchestrator",
           "--command", json.dumps({"commands": commands})]
    started = now()
    try:
        p = subprocess.run(cmd, cwd=PLUS, capture_output=True, text=True, timeout=timeout)
        out = p.stdout
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "driver timeout", "tag": tag, "started": started, "ended": now()}
    # The driver prints non-JSON WARN preamble whose braces are not valid JSON,
    # so scan candidate "{" offsets and keep the first that parses.
    j = None
    i = out.find("{")
    while i >= 0:
        try:
            j = json.loads(out[i:])
            break
        except Exception:
            i = out.find("{", i + 1)
    if j is None:
        j = {"ok": False, "error": out[-2000:]}
    j["tag"] = tag; j["started"] = started; j["ended"] = now()
    return j

def save(name, obj):
    os.makedirs(CYCLES, exist_ok=True)
    with open(os.path.join(CYCLES, name), "w") as f: json.dump(obj, f, indent=2)

def brief(n, role, extra=None):
    b = {"requestID": "resoak-c%02d-a" % n, "role": role,
         "objective": ("Write exactly `cycle %02d` and a trailing newline to notes/%02d.md, "
                       "run the scratch-ok check, checkpoint `docs(soak): cycle %02d`, "
                       "then call team_finish with status done." % (n, n, n)),
         "deliverable": {"kind": "commit"}, "scope": {"paths": ["notes/*"]},
         "checks": [{"id": "scratch-ok", "argv": ["bun", "test", "./scratch/ok.test.ts"]}],
         "effort": "small"}
    if extra: b.update(extra)
    return b

def summarize(n, kind, j):
    blob = json.dumps(j)
    realpath = "FileSystem.realPath" in blob
    bounds = "E_BOUNDS" in blob
    child = (j.get("child") or {}).get("run")
    status = None
    for r in j.get("results", []):
        if r.get("tool") == "wait":
            s = (r.get("output") or {}).get("settled") or []
            if s: status = (s[0].get("report") or {}).get("status")
    landed = any(r.get("tool") == "integrate" and r.get("ok") for r in j.get("results", []))
    flags = [x for x, c in (("REALPATH", realpath), ("E_BOUNDS", bounds)) if c]
    print("cycle %02d [%s] ok=%s child=%s report=%s landed=%s %s" %
          (n, kind, j.get("ok"), child, status, landed, " ".join(flags)), flush=True)
    return {"cycle": n, "kind": kind, "ok": j.get("ok"), "child": child, "report": status,
            "landed": landed, "realpath": realpath, "bounds": bounds,
            "started": j.get("started"), "ended": j.get("ended")}

def single(n, role, extra=None):
    j = drive([{"tool": "delegate", "as": "parent", "input": brief(n, role, extra)},
               {"tool": "wait", "as": "parent", "input": {"timeoutMs": 600000}},
               {"tool": "integrate", "as": "parent", "input": {}}], "cycle-%02d" % n)
    save("cycle-%02d.json" % n, j)
    return summarize(n, "single", j)

def pair(a, b, role_a, role_b):
    res = {}
    def go(n, role):
        res[n] = drive([{"tool": "delegate", "as": "parent", "input": brief(n, role)}],
                       "cycle-%02d-delegate" % n)
    ta = threading.Thread(target=go, args=(a, role_a)); tb = threading.Thread(target=go, args=(b, role_b))
    ta.start(); tb.start(); ta.join(); tb.join()
    runs = [r for r in ((res[n].get("child") or {}).get("run") for n in (a, b)) if r]
    tail = drive([{"tool": "wait", "as": "parent", "input": {"runs": runs, "timeoutMs": 600000}}] +
                 [{"tool": "integrate", "as": "parent", "input": {"run": r}} for r in runs],
                 "pair-%02d-%02d-tail" % (a, b))
    out = []
    for n in (a, b):
        save("cycle-%02d.json" % n, {"delegate": res[n], "tail": tail})
        combo = dict(res[n]); combo["results"] = (res[n].get("results") or []) + (tail.get("results") or [])
        out.append(summarize(n, "pair", combo))
    return out

def main():
    plan = json.loads(sys.argv[1]); results = []
    for step in plan:
        if step["kind"] == "single": results.append(single(step["n"], step["role"], step.get("extra")))
        elif step["kind"] == "pair": results.extend(pair(step["a"], step["b"], step["role_a"], step["role_b"]))
        time.sleep(1)
    with open(os.path.join(EVID, "summary-%d.json" % int(time.time())), "w") as f:
        json.dump(results, f, indent=2)
    print("DONE " + json.dumps({"cycles": len(results),
                                "realpath": sum(1 for r in results if r["realpath"]),
                                "bounds": sum(1 for r in results if r["bounds"]),
                                "landed": sum(1 for r in results if r["landed"])}))

if __name__ == "__main__": main()
