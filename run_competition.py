#!/usr/bin/env python3
"""
One-command run of the Peak Hour Energy Agent on any list of scenarios (practice or hidden).

  python run_competition.py --setup                                   # one-time: pip deps + import the 3 n8n workflows
  python run_competition.py                                           # 6 practice days through the n8n Test Runner
  python run_competition.py --days hidden_01,hidden_02,hidden_03 --key <answer_key.xlsx>
  python run_competition.py --days hidden_01 --key KEY.xlsx --bridge-only   # start the bridge; click Execute in the n8n editor
  python run_competition.py --days practice_05 --headless              # same core logic without n8n (fallback, no AI)
  python run_competition.py --platform                                 # open the control platform with LIVE simulator runs

It starts the simulator bridge (wrapper/server.py) with the answer key and the day list, runs the agent,
then prints the simulator's own score for every day (run_summary: cost, saving %, violations, late orders)
and writes results/competition_results.csv. The action logs are in wrapper/runs/P3/<day>/actions.jsonl.
"""
import argparse, csv, json, os, shutil, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PRACTICE = ",".join(f"practice_0{i}" for i in range(1, 7))
WORKFLOWS = ["PHEA_Day_Agent.json", "PHEA_Test_Runner.json", "PHEA_DR_Webhook.json"]


def n8n_cmd():
    if shutil.which("n8n"):
        return ["n8n"]
    if shutil.which("npx"):
        return ["npx", "--yes", "n8n"]
    return None


def get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def setup():
    print("Installing Python packages ...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")])
    n = n8n_cmd()
    if not n:
        print("n8n not found on PATH – install it (npm i -g n8n) or import the files in n8n/ through the editor.")
        return
    import tempfile
    for f in WORKFLOWS:                      # the n8n CLI imports a list; the editor imports these files as they are
        print("Importing", f)
        tmp = Path(tempfile.gettempdir()) / f"phea_import_{f}"
        tmp.write_text(json.dumps([json.loads((ROOT / "n8n" / f).read_text())]))
        subprocess.check_call(n + ["import:workflow", f"--input={tmp}"], shell=(os.name == "nt"))
    print("Setup done. In the n8n editor, attach your OpenAI / Google credentials if you use them (optional).")


def platform(port):
    """Demo mode: the bridge serves platform/index.html and runs scenarios live. The fault injector is on
    so judges can try the disruption scenarios; never use this mode for a scored run."""
    import webbrowser
    cmd = [sys.executable, "server.py", "--port", str(port), "--faults"]
    bridge = subprocess.Popen(cmd, cwd=ROOT / "wrapper")
    url = f"http://localhost:{port}/"
    try:
        for _ in range(60):
            try:
                get(url + "health"); break
            except Exception:
                time.sleep(0.5)
        print(f"Control platform: {url}  (live simulator connected; Ctrl+C to stop)")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        bridge.wait()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.terminate()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", default=PRACTICE, help="comma-separated scenario ids (default: the six practice days)")
    ap.add_argument("--key", help="organiser answer-key workbook (needed for hidden scenarios)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--setup", action="store_true", help="install Python deps and import the n8n workflows, then exit")
    ap.add_argument("--bridge-only", action="store_true", help="start the bridge and wait; run the Test Runner from the n8n editor")
    ap.add_argument("--headless", action="store_true", help="run the same core logic with Node.js instead of n8n (no AI)")
    ap.add_argument("--platform", action="store_true", help="serve the control platform at http://localhost:PORT/ with live simulator runs (demo only)")
    a = ap.parse_args()
    if a.setup:
        return setup()
    if a.platform:
        return platform(a.port)

    days = [d.strip() for d in a.days.split(",") if d.strip()]
    cmd = [sys.executable, "server.py", "--port", str(a.port), "--days", ",".join(days)]
    if a.key:
        cmd += ["--key", str(Path(a.key).resolve())]
    print("Starting bridge:", " ".join(cmd))
    bridge = subprocess.Popen(cmd, cwd=ROOT / "wrapper")
    base = f"http://localhost:{a.port}"
    try:
        for _ in range(60):
            try:
                get(base + "/health"); break
            except Exception:
                time.sleep(0.5)
        else:
            sys.exit("bridge did not start – check Python packages (python run_competition.py --setup)")
        print(f"Bridge ready at {base} – days: {', '.join(days)}")
        t0 = time.time()
        if a.bridge_only:
            print("Open n8n, open 'Peak Hour Energy Agent - Test Runner' and click Execute Workflow (it reads the day list from the bridge).")
            print("Press Ctrl+C here when the run has finished.")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
        elif a.headless:
            subprocess.check_call(["node", "planner/harness.js", ",".join(days)], cwd=ROOT, env={**os.environ, "API": base})
        else:
            n = n8n_cmd()
            if not n:
                sys.exit("n8n CLI not found – use --bridge-only (click Execute in the editor) or --headless")
            env = {**os.environ, "NODE_OPTIONS": os.environ.get("NODE_OPTIONS", "--max-old-space-size=4096")}
            for d in days:                       # one n8n execution per day keeps memory flat
                req = urllib.request.Request(base + "/days", data=json.dumps({"days": [d]}).encode(), method="POST")
                urllib.request.urlopen(req, timeout=10).read()
                print(f"--- running {d} in n8n ---", flush=True)
                subprocess.call(n + ["execute", "--id=PHEATestRunner01"], env=env, shell=(os.name == "nt"), stdout=subprocess.DEVNULL)
        print(f"\nRun time: {time.time() - t0:.0f} s\n")
        rows = []
        for d in days:
            try:
                s = get(f"{base}/summary?day={d}")
            except Exception as e:
                s = {"error": str(e)}
            rows.append({"day": d, "cost_aed": s.get("cost_aed"), "baseline_cost_aed": s.get("baseline_cost_aed"), "saving_pct": s.get("saving_pct"),
                         "peak_kw": s.get("peak_kw"), "baseline_peak_kw": s.get("baseline_peak_kw"), "comfort_violation_minutes": s.get("comfort_violation_minutes"),
                         "late_orders": len(s.get("late_orders") or []), "violations": len(s.get("violations") or []), "error": s.get("error", "")})
        print(f"{'day':14}{'cost AED':>10}{'base AED':>10}{'saved %':>9}{'peak kW':>9}{'comfort':>9}{'late':>6}{'viol':>6}")
        for r in rows:
            print(f"{r['day']:14}{str(r['cost_aed']):>10}{str(r['baseline_cost_aed']):>10}{str(r['saving_pct']):>9}{str(r['peak_kw']):>9}{str(r['comfort_violation_minutes']):>9}{r['late_orders']:>6}{r['violations']:>6}  {r['error']}")
        (ROOT / "results").mkdir(exist_ok=True)
        with open(ROOT / "results" / "competition_results.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
        print("\nSaved results/competition_results.csv · action logs: wrapper/runs/P3/<day>/actions.jsonl")
    finally:
        bridge.terminate()


if __name__ == "__main__":
    main()
