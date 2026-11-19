# Peak Hour Energy Agent

**AgentX@CCI 2026 · Problem 3 – The Peak-Hour Energy Agent**
Senior Design Group: Amina Aldarwish, Hanane ElTannir, Lilian Karrum · Supervisor: Dr. Ahcene Bounceur
Department of Computer Science, College of Computing and Informatics, University of Sharjah

An n8n agent that plans and runs an aluminium-extrusion plant's cooling (4 chillers + ice tank) and press batches so it buys less electricity in the 12:00–18:00 peak, while **never** breaking the three hard rules:

- production floor 20–27 °C;
- every order finishes by its due time;
- at least one available chiller stays off on standby.

| Result on the 6 practice days | |
|---|---|
| Energy cost saved vs do-nothing | 4.3 – 8.6 % (AI decision agent off) · 4.3 – 8.1 % (AI on) |
| Peak demand | below baseline every day, up to −324 kW |
| Late orders · comfort-band minutes · simulator violations | **0 · 0 · 0** |
| Stress suite (20 injected disruptions) | **20 / 20 passed, 0 crashes** |

## What the agent does

1. **Perceive.** It reads the forecast, tariff, solar, orders and plant status through the provided tools. Every reading is validated: implausible or jumping values are rejected, and instruction-like text in data is flagged and never obeyed.
2. **Plan.** A deterministic optimiser builds a 24-hour plan: press batch start times (branch-and-bound plus local search), ice charge/discharge valued by the grid power it really avoids after solar, and chiller staging that always keeps a backup.
3. **What-if.** The operator sees four options before anything is committed: A recommended, B max savings, C extra safe, and D a do-nothing reference. Each has cost, demand charge, peak, stress-tested floor temperature and late orders. The operator can approve one in an n8n form, or the default is used.
4. **Check.** Every plan is re-simulated in 15-minute steps with +1 °C stress and rejected unless all hard rules hold.
5. **Act.** It sends `schedule_batch`, `set_chiller_state` and `set_storage_mode` commands. The 15-minute monitor re-plans every hour and immediately on events: chiller trip or recovery, new, cancelled or invalid order, forecast error, sensor fault, demand-response request.
6. **Demand response (stretch goal).** A utility request ("keep grid ≤ X kW from HH to HH") is accepted at any time. The agent re-plans to meet it and warns when a request is physically impossible. Compliance appears in the daily report.
7. **AI only where judgement helps.** An OpenAI agent is asked "how cautious should we be?" only on unusual events, with at most 6 calls a day. It sees sanitised structured data only, its answer is whitelisted (`accept`, `conservative` or `escalate`), it can only make the plan safer, and the result must pass the same rule check.
8. **Explain.** A decision diary records every decision as **SAW / DID / WHY**, together with the what-if table, alerts and escalations. These go into the daily report and the Google Sheets `Decision_Log`.
9. **Never crash.** Every HTTP node continues on error and every Code node catches its own errors. Missing data leads to the last good value, and anything worse leads to safe mode: the maximum allowed chillers with a backup kept.

## Control platform

`platform/index.html` is a single web page with five views that share one 24-hour time bar:

| View | What it shows |
|---|---|
| **Energy Control** | Live KPIs (cost so far vs no agent, saving, grid power, peak, floor temperature, ice, solar, AI decisions), grid-power chart with the peak window and peak limit, plant status, press schedule (agent vs no agent) and the agent's SAW / DID / WHY log |
| **Digital Twin** | Animated plant: 3 presses, 4 chillers, ice tank, solar roof and grid. Equipment is green when running, grey when idle or on standby, red when broken; click any item for details |
| **What-If Simulator** | Nine scenarios (normal, heatwave, cloudy, rush order, chiller failure, forecast miss, demand response, broken sensor, malicious order data). Run one to see how the agent responds, the outcome and the A/B/C/D options the operator saw. In live mode you can also build your own scenario |
| **Before vs After** | The same day in the same simulator without and with the agent, as side-by-side synchronised charts: grid power with peak marked, cost so far and floor temperature |
| **Decision Timeline** | Every decision as a chain: detected → AI recommended → safety check approved → action executed, on four swim lanes, plus the full decision log |

The page runs in two modes:

- **Replay:** open `platform/index.html` directly, or with VS Code Live Server (Go Live). It replays real recorded runs of the organisers' simulator (`platform/data/scenarios.json`).
- **Live:** run `python run_competition.py --platform` and open `http://localhost:8765/`. The agent core (`planner/core.js`) runs in the browser and drives the simulator through the bridge, so every run is a real run.

Rebuild the recorded data with `API=http://localhost:8766 node platform/build_data.js && node platform/build_page.js`, against a bridge started with `--faults --port 8766`. Without an API key, the replays and live runs use a scripted stand-in for the OpenAI decision step. It uses the same JSON contract and the same guardrails, and the core still whitelists, clamps and re-validates whatever it returns.

## Repository layout

```
wrapper/            server.py – HTTP bridge to the provided simulator (+ TEST-ONLY fault injector)
                    p3_energy_api.py, common.py, data/ – provided by the organisers (unchanged)
planner/core.js     the agent's deterministic core (forecast prep, optimiser, validator, monitor,
                    guardrails, what-if, demand response, diary, KPIs) – inlined into the n8n Code nodes
planner/harness.js  runs the same stages as n8n from the command line (fast testing)
planner/runner.js   same stages with a full 15-minute trace; shared by the platform (browser) and its data builder
platform/           index.html (control platform), src.html (source), build_data.js, build_page.js, data/scenarios.json
n8n/                PHEA_Day_Agent.json, PHEA_Test_Runner.json, PHEA_DR_Webhook.json (import these)
                    build_workflow.js regenerates them from core.js; workbook_constants.json = build-time fallback
tests/              robustness.js (unit checks) · stress.js (20 injected disruptions)
run_competition.py  one-command setup and run (practice or hidden scenarios)
results/            practice-day results (n8n), stress results, example decision diaries
docs/               technical report (6 pages), run instructions, poster
```

## Quick start (one command)

```
python run_competition.py --setup            # once: Python packages + import the 3 n8n workflows
python run_competition.py                    # run the 6 practice days through n8n and print the simulator's scores
```

On competition day the hidden scenarios run the same way:

```
python run_competition.py --days hidden_01,hidden_02,hidden_03 --key <answer_key.xlsx>
```

The command does four things:
1. starts the simulator bridge with the answer key;
2. runs each day through the n8n Test Runner, in a separate execution, unattended;
3. prints cost, saving, peak, comfort minutes, late orders and violations from the simulator's own `run_summary()`;
4. saves `results/competition_results.csv`.

The scored action logs are in `wrapper/runs/P3/<day>/actions.jsonl`. Two other modes:
- `--bridge-only` starts the bridge so you can click **Execute** on the Test Runner in the n8n editor; the day list is read from the bridge.
- `--headless` runs the identical core without n8n, as a fallback.

Full details are in **[RUN.md](RUN.md)**.

## Declaration of tools and models used

| Tool / model | Version | Used for |
|---|---|---|
| n8n (self-hosted, Community) | 1.80.0 (tested) | Agent orchestration: triggers, HTTP Request, Code (JavaScript), IF, Loop Over Items, Wait (form), Execute Workflow, Webhook, AI Agent, Google Sheets nodes |
| OpenAI `gpt-4o-mini` via n8n *OpenAI Chat Model* + *AI Agent* (LangChain) nodes | n8n langchain nodes 1.7 / 1.2 | Event-time caution decision (accept / conservative / escalate) and the 3-sentence daily narrative. Optional (`use_ai`); swappable for any chat model node |
| JavaScript (Node.js, inside n8n Code nodes) | Node 18+ | Optimiser, validator, monitor, guardrails, KPIs (`planner/core.js`) |
| Python 3 + pandas, numpy, openpyxl | 3.10+ | HTTP bridge to the provided simulator (`wrapper/server.py`) |
| Provided toolkit: `p3_energy_api.py`, `common.py`, `P3_Energy_Agent_Data.xlsx` | AgentX@CCI 2026 | Simulator, tools and data (unchanged) |
| Google Sheets (n8n node, OAuth2) | – | Daily_Reports, Decision_Log, Test_Results (optional) |
| Cloudflare `cloudflared` quick tunnel | – | Only when n8n runs on a different machine than the bridge |
| HTML, CSS, JavaScript (no framework); Google Fonts (Barlow, IBM Plex Mono) | – | Control platform (`platform/`); charts and the digital twin are hand-drawn SVG |
| Playwright (Chromium) | – | Automated screenshots and checks of the platform during development |
| matplotlib, python-pptx, pandoc | – | Poster and report figures/documents only |

**Data:** only the organiser-provided workbook and simulator.

- No real company data and no external data.
- The agent never reads the practice twist notes.
- The practice answers are not hard-coded: all plans come from the tools at run time.

**AI assistance:** the team used Claude (Anthropic) as a coding and writing assistant during development.
