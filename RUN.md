# Run instructions

## 0. One command
```
python run_competition.py --setup                                        # once
python run_competition.py                                                # practice days
python run_competition.py --days hidden_01,hidden_02,hidden_03 --key KEY.xlsx   # competition day
```
This needs Python 3.10+, Node.js 18+ and the n8n CLI (`npm i -g n8n`, or `npx` is used automatically).
- Each day runs in its own n8n execution, unattended. That takes about 70–80 s per day on a laptop, so 3 hidden scenarios take about 4 minutes.
- Without the n8n CLI, use one of these instead:
  - `--bridge-only`, then click **Execute Workflow** on the Test Runner in the n8n editor. It reads the day list from the bridge, so nothing needs editing.
  - `--headless`, which runs the same core code with Node.js but without the AI step.

**Competition-day checklist**
1. Run on the same laptop as n8n, not through a tunnel.
2. Start the bridge in normal mode only. Never use `--faults`.
3. Set `use_ai` in the Test Runner's **Settings** node.
4. Set `require_approval: false` so the run is unattended. The what-if table is still computed and logged.
5. Keep the laptop plugged in, with sleep set to Never.

The steps below describe the same thing done by hand.

## 1. Requirements
- Python 3.10+ with `pandas numpy openpyxl`. Anaconda already includes them.
- n8n 1.80+, self-hosted. `npx n8n` is the quickest way.
- Optional: an OpenAI API key (for the AI decision agent and the narrative), and Google Sheets OAuth2 credentials (for reports).

## 2. Start the simulator bridge
```
cd wrapper
python server.py                       # practice days, http://localhost:8765
python server.py --key <answer_key.xlsx>   # competition day: enables the hidden days
```
Check it at `http://localhost:8765/health`. It should return `{"ok": true}`.

If n8n runs on another machine, expose the bridge:
```
cloudflared tunnel --url http://localhost:8765
```
Then use the printed `https://…trycloudflare.com` link as `api_base`. For the timed hidden-scenario run, prefer running n8n on the same machine, because it is faster and needs no internet.

## 3. Import into n8n
Import, in this order:
1. `n8n/PHEA_Day_Agent.json`
2. `n8n/PHEA_Test_Runner.json`
3. `n8n/PHEA_DR_Webhook.json` (optional)

If n8n assigns a new ID to the Day Agent, open **Test Runner → Run Day Agent** and pick the Day Agent with **From list**.

## 4. Configure
| Where | Setting | Meaning |
|---|---|---|
| Day Agent → **Config** | `api_base` | bridge address (localhost or tunnel link) |
| | `use_ai`, `max_ai_calls` | OpenAI decision agent on/off, daily cap |
| | `require_approval`, `what_if_choice`, `approval_timeout_min` | show the what-if form and wait for the operator; default option; timeout |
| | `write_sheets`, `sheet_id` | Google Sheets output |
| | `notify_webhook` | optional URL that receives ESCALATION messages (Slack/Teams/email bridge) |
| | `dr_events` | demand-response requests for simulation, e.g. `[{"announce":"12:00","start":"18:00","end":"21:00","cap_kw":1200}]` |
| Test Runner → **Settings** | `api_base`, `use_ai`, `write_sheets`, `sheet_id`, `require_approval` | settings passed to every Day Agent run; these **override** Config |
| Bridge `--days` (or `run_competition.py --days`) | day ids | which days the Test Runner runs (practice or hidden); default: the 6 practice days |

- **Credentials.** Pick your OpenAI credential in both *OpenAI Chat Model* nodes, and your Google credential in the *Google Sheets* nodes.
- **Sheet tabs.** The Google Sheet needs tabs named `Daily_Reports`, `Decision_Log` and `Test_Results`. n8n maps columns automatically; add a header row if a tab is empty.

## 5. Run
- **One day:** open the Day Agent and click **Execute Workflow**. Check the result in **Return Report** (or in Sheets).
- **Several days:** open the Test Runner and click **Execute Workflow**. Each row of the **Results Table** includes the simulator's own score and `pass = true/false`.
- **What-if approval:** set `require_approval: true`. The run pauses at **What-If View: Operator Approval**. Open the form link shown in that node, compare options A/B/C/D and pick one. If nobody answers within `approval_timeout_min`, the default option is used.
- **Demand response from a utility:**
  1. Activate the DR webhook workflow.
  2. POST `{"start":"18:00","end":"21:00","cap_kw":1200}` to `/webhook/phea-demand-response`.
  3. For simulator tests, use `dr_events` in Config instead.
- **Memory:** for six days in one execution, start n8n with `NODE_OPTIONS=--max-old-space-size=4096`.

## 6. Control platform (demo for judges)
```
python run_competition.py --platform        # serves http://localhost:8765/ and opens it
```
- In this mode every scenario on the **What-If Simulator** runs live on the simulator (about 4 s each), and **Build your own scenario** combines any practice day with a disruption, a demand-response cap and an operator option.
- Opening `platform/index.html` without the bridge replays the recorded runs instead. VS Code **Live Server** (Go Live) works too: it replays, and it switches to live mode by itself when a bridge is running on port 8765 (`cd wrapper` then `python server.py --faults`).
- This mode turns the fault injector on so the disruption scenarios work. Use it for demos only, never for a scored run.

## 7. Tests (no n8n needed)
```
cd wrapper && python server.py --faults      # TEST ONLY: enables the fault injector
node planner/harness.js all                  # the same stages as n8n, all practice days
node tests/robustness.js                     # unit-level guardrail checks
node tests/stress.js                         # 20 injected disruptions -> results/stress_results.json
```
Never use `--faults` for a scored run.

## 8. Changing the logic
1. Edit `planner/core.js`.
2. Run `node n8n/build_workflow.js` to regenerate all three workflow files with the code inlined.
3. Re-import them into n8n.
4. Rebuild the platform: start the bridge with `--faults --port 8766`, then run `API=http://localhost:8766 node platform/build_data.js && node platform/build_page.js`.
