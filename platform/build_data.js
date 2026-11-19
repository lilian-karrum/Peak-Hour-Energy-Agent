// Builds platform/data/scenarios.json from REAL simulator runs (provided EnergyAPI via the bridge).
//   cd wrapper && python server.py --faults --port 8766   (fault injector needed for the sensor / injection scenarios)
//   API=http://localhost:8766 node platform/build_data.js && node platform/build_page.js
// Every number in the platform comes from these runs: the simulator's own meters and run_summary(),
// the agent's own trace and decision diary. Nothing is typed in by hand.
const C = require('../planner/core.js');
const R = require('../planner/runner.js');
const fs = require('fs');
const BASE = process.env.API || 'http://localhost:8766';
const SCEN = require('./scenarios_def.json');

(async () => {
  const t0 = Date.now();
  const chillers = await fetch(BASE + '/workbook?sheet=Chillers').then(r => r.json());
  const out = { generated: new Date().toISOString(), source: 'AgentX@CCI 2026 P3 simulator (p3_energy_api.EnergyAPI) through wrapper/server.py',
    meter_cols: R.METER_COLS, chillers, baselines: {}, scenarios: [] };
  for (const d of [...new Set(SCEN.map(s => s.day))]) {
    const b = await R.runBaseline(C, BASE, d);
    const off = await fetch(BASE + '/baseline?day=' + d).then(r => r.json());
    out.baselines[d] = R.packBaseline(b, off);
    console.log('baseline', d, b.sum.cost_aed, 'official', off.baseline_cost_aed, 'peak', b.sum.peak_kw, '/', off.baseline_peak_kw, 'late', (b.sum.late_orders || []).length);
  }
  for (const s of SCEN) {
    const p = await R.runScenario(C, BASE, s);
    out.scenarios.push(p);
    console.log(s.id.padEnd(10), s.day, 'saving', p.sum.saving_pct, '% peak', p.sum.peak_kw, 'viol', (p.sum.violations || []).length, 'late', (p.sum.late_orders || []).length, 'comfort', p.sum.comfort_violation_minutes, 'ai', p.kpi.ai_calls, p.kpi.demand_response || '');
  }
  fs.mkdirSync(__dirname + '/data', { recursive: true });
  fs.writeFileSync(__dirname + '/data/scenarios.json', JSON.stringify(out));
  console.log('wrote platform/data/scenarios.json', (fs.statSync(__dirname + '/data/scenarios.json').size / 1024).toFixed(0), 'KB in', ((Date.now() - t0) / 1000).toFixed(0), 's');
})();
