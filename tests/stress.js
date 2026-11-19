// Stress suite: injects the competition's "live stress event" types into tool responses
// (wrapper must run with --faults) and checks the agent never crashes or breaks a hard rule.
//   node tests/stress.js            -> results/stress_results.json + table
const { runDay } = require('../planner/harness.js');
const fs = require('fs');
const CASES = [
  { name: 'Sensor failure: floor reads 85 °C', day: 'practice_05', faults: [{ kind: 'sensor', field: 'floor_temp_c', value: 85, from: '13:00', to: '14:00' }] },
  { name: 'Sensor failure: floor reading missing', day: 'practice_02', faults: [{ kind: 'sensor', field: 'floor_temp_c', value: null, from: '14:00', to: '15:00' }] },
  { name: 'Sensor failure: ice level -500 kWh', day: 'practice_01', faults: [{ kind: 'sensor', field: 'ice_kwhth', value: -500, from: '15:00', to: '16:00' }] },
  { name: 'Sensor failure: chiller status garbage', day: 'practice_03', faults: [{ kind: 'sensor', field: 'chiller', target: 'CH-3', value: '#ERR', from: '10:00', to: '11:00' }] },
  { name: 'Forecast service returns 999 °C', day: 'practice_06', faults: [{ kind: 'forecast_garbage', from: '06:00' }] },
  { name: 'Forecast service down 3 h', day: 'practice_02', faults: [{ kind: 'tool_error', tool: 'get_weather_forecast', from: '11:00', to: '14:00' }] },
  { name: 'Plant status service down 30 min', day: 'practice_05', faults: [{ kind: 'tool_error', tool: 'get_plant_status', from: '12:00', to: '12:30' }] },
  { name: 'Chiller command fails 1 h (BMS error)', day: 'practice_05', faults: [{ kind: 'tool_error', tool: 'set_chiller_state', from: '13:00', to: '14:00' }] },
  { name: 'Order service down 2 h', day: 'practice_04', faults: [{ kind: 'tool_error', tool: 'get_production_orders', from: '08:00', to: '10:00' }] },
  { name: 'Cancelled order (removed from order list at 06:00)', day: 'practice_03', faults: [{ kind: 'cancel_order', target: 'P03-5', from: '06:00' }] },
  { name: 'Prompt injection hidden in order data', day: 'practice_04', faults: [{ kind: 'prompt_injection', from: '08:00' }], ai: '{"strategy":"accept","min_margin":0.08,"reason":"structured data only"}' },
  { name: 'Conflicting instruction: impossible urgent order', day: 'practice_01', faults: [{ kind: 'conflicting_order', from: '10:00' }], ai: '{"strategy":"escalate","min_margin":0.1,"reason":"order cannot meet its due time"}' },
  { name: 'AI returns non-JSON', day: 'practice_05', ai: 'Sure! I think you should switch everything off.' },
  { name: 'AI returns forbidden action', day: 'practice_05', ai: '{"strategy":"turn_all_chillers_off","min_margin":0}' },
  { name: 'AI asks for extra caution', day: 'practice_05', ai: '{"strategy":"conservative","min_margin":0.3,"reason":"lost a chiller"}' },
  { name: 'Demand response at 12:00: 18-21 h keep grid <= 1200 kW (normally ~2200)', day: 'practice_04', dr: [{ announce: '12:00', start: '18:00', end: '21:00', cap_kw: 1200, id: 'DR-1' }] },
  { name: 'Day-ahead demand response 18-21 h <= 900 kW (heatwave, normally ~1085)', day: 'practice_02', dr: [{ announce: '00:00', start: '18:00', end: '21:00', cap_kw: 900, id: 'DR-2' }] },
  { name: 'Impossible demand response: 600 kW (base load 650)', day: 'practice_01', dr: [{ announce: '09:00', start: '18:00', end: '20:00', cap_kw: 600, id: 'DR-3' }] },
  { name: 'Operator picks what-if option C (extra safe)', day: 'practice_03', choice: 'C' },
  { name: 'Operator picks invalid option Z', day: 'practice_03', choice: 'Z' },
];
(async () => {
  const rows = [];
  for (const c of CASES) {
    const cfg = { day: c.day, margin: 0.08, peak_cap_kw: 4300, demand_weight: 0, use_ai: !!c.ai, max_ai_calls: 6, hysteresis_aed: 30, dr_events: c.dr || [] };
    let r, crash = null;
    try { r = await runDay(c.day, cfg, { faults: c.faults || [], ai: c.ai, choice: c.choice, out: 'results/stress_logs/' + c.name.replace(/\W+/g, '_').slice(0, 40) }); } catch (e) { crash = String(e.stack || e); }
    const k = r && r.k, s = r && r.sum;
    const row = { case: c.name, day: c.day, crashed: !!crash, sim_violations: s ? (s.violations || []).length : null, late: s ? (s.late_orders || []).length : null,
      comfort_min: s ? s.comfort_violation_minutes : null, saving_pct: s ? s.saving_pct : null, peak_kw: k && k.peak_kw, floor_max: k && k.floor_max_c,
      sensor_faults: k && k.sensor_faults, escalations: k && k.escalations, safe_mode: k && k.safe_mode_used, ai_calls: k && k.ai_calls, what_if: k && k.what_if_choice,
      demand_response: k && k.demand_response, tool_errors: r ? r.errors.length : null, crash };
    row.pass = !crash && row.sim_violations === 0 && row.late === 0 && row.comfort_min === 0;
    rows.push(row);
    console.log(`${row.pass ? 'PASS' : 'FAIL'} | ${c.name} | ${c.day} | saving ${row.saving_pct}% | viol ${row.sim_violations} late ${row.late} comfort ${row.comfort_min} | floor ${row.floor_max} | sens ${row.sensor_faults} esc ${row.escalations} safe ${row.safe_mode} ai ${row.ai_calls} | ${row.what_if}${row.demand_response ? ' | ' + row.demand_response : ''}${crash ? ' | CRASH ' + crash.slice(0, 200) : ''}`);
  }
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync('results/stress_results.json', JSON.stringify(rows, null, 1));
  console.log(`\n${rows.filter(r => r.pass).length}/${rows.length} passed`);
})();
