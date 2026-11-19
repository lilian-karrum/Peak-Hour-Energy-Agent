// Dev/test harness: runs the same stages as the n8n Day Agent against the wrapper,
// using the same crash-proof entry points (startDay -> commitChoice -> tick x96 -> dailyKpis).
//   node planner/harness.js [day|all] [--ai '{"strategy":...}'] [--fault '{"kind":...}'] [--dr '[...]'] [--choice B] [--out dir]
const C = require('./core.js');
const fs = require('fs');
const B = process.env.API || 'http://localhost:8765';
const post = (p, b) => fetch(B + p, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
const get = p => fetch(B + p).then(r => r.json()).catch(e => ({ error: String(e) }));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

async function runDay(day, cfg, opt = {}) {
  await post('/fault', { day, clear: true });
  await post('/session', { day });
  for (const f of opt.faults || []) await post('/fault', { day, ...f });
  const call = (tool, args) => post('/call', { day, tool, args }).then(r => (r && 'result' in r) ? r.result : { error: r && r.error || 'no response' });
  const ok = r => (r && !r.error) ? r : null;
  const sd = C.startDay({ cfg, siteRows: await get('/workbook?sheet=Site_Parameters'), chillerRows: await get('/workbook?sheet=Chillers'),
    tariffRows: ok(await call('get_tariff')), baselineRow: ok(await get('/baseline?day=' + day)), status: ok(await call('get_plant_status')),
    weatherRows: ok(await call('get_weather_forecast')), solarRows: ok(await call('get_solar_forecast')), orderRows: ok(await call('get_production_orders')),
    defaultSite: opt.defaultSite });
  const { site, state: st } = sd;
  C.commitChoice(site, st, opt.choice || 'A', sd.orders);
  const errors = [];
  const exec = async cmds => { const res = []; for (const c of cmds) res.push(await call(c.tool, c.args)); for (const e of C.noteToolErrors(st, cmds, res)) { errors.push(`${e.tool} ${JSON.stringify(e.args)}: ${e.error}`); st.alerts.push(`TOOL_ERROR ${e.tool}: ${e.error}`); } };
  let status = sd.status, orderRows = ok(await call('get_production_orders'));
  await exec(C.buildCommands(status, orderRows || [], st.schedule, st.hours[0], st.dayStart, st, site));
  for (let k = 0; k < 96; k++) {
    await call('advance_time', { minutes: 15 });
    const raw = await call('get_plant_status'); await call('read_meters', { last_hours: 1 });
    orderRows = ok(await call('get_production_orders'));
    const weather = ok(await call('get_weather_forecast')), solar = ok(await call('get_solar_forecast'));
    const x = { site, cfg, state: st, status: raw && !raw.error ? raw : { now: C.fmtTs(st.dayStart + (k + 1) * 15 * 60000) }, orderRows, weatherRows: weather, solarRows: solar };
    const out = C.tick(x);
    if (out.finished) break;
    if (out.ai_needed && opt.ai) { const a = C.applyAiDecision({ site, cfg, state: st, status: x.status, orderRows, weatherRows: weather, solarRows: solar }, opt.ai); if (a.applied && a.desired) out.desired = a.desired; }
    if (process.env.V) for (const e of out.events || []) if (e.type !== 'safety_override') console.log(day, out.now, JSON.stringify(e).slice(0, 160));
    let cmds; try { cmds = C.buildCommands(x.status.chillers ? x.status : { ...x.status, chillers: {} }, orderRows || st.lastOrderRows || [], st.schedule, out.desired, st.dayStart, st, site); } catch (e) { cmds = []; st.alerts.push('ALERT command build error'); }
    await exec(cmds);
  }
  const meters = ok(await call('read_meters', { last_hours: 24 }));
  const k = C.dailyKpis(site, meters, ok(await call('get_production_orders')), ok(await get('/baseline?day=' + day)), st);
  const sum = await get('/summary?day=' + day);
  if (opt.out) { fs.mkdirSync(opt.out, { recursive: true }); fs.writeFileSync(`${opt.out}/${day}_diary.txt`, C.diaryText(st)); fs.writeFileSync(`${opt.out}/${day}_whatif.txt`, st.whatIfTable); fs.writeFileSync(`${opt.out}/${day}_meters.json`, JSON.stringify(meters)); }
  return { k, sum, st, errors };
}
module.exports = { runDay };
if (require.main === module) (async () => {
  const d = arg('--day', process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all');
  const days = d === 'all' ? ['practice_01', 'practice_02', 'practice_03', 'practice_04', 'practice_05', 'practice_06'] : d.split(',');
  const cfg = { day: null, margin: 0.08, peak_cap_kw: 4300, demand_weight: 0, use_ai: !!arg('--ai'), max_ai_calls: 6, hysteresis_aed: 30, dr_events: JSON.parse(arg('--dr', '[]')) };
  const faults = arg('--fault') ? [JSON.parse(arg('--fault'))] : [];
  for (const day of days) {
    cfg.day = day;
    const { k, sum, errors } = await runDay(day, cfg, { ai: arg('--ai'), faults, choice: arg('--choice', 'A'), out: arg('--out') });
    console.log(`${day} cost ${k.energy_cost_aed}/${k.baseline_energy_cost_aed} (${k.energy_saving_pct}%) total ${k.total_saving_pct}% peak ${k.peak_kw}/${k.baseline_peak_kw} comfort ${k.comfort_violation_min} late ${k.late_orders} | SIM viol ${(sum.violations || []).length} late ${(sum.late_orders || []).length} | ai ${k.ai_calls} esc ${k.escalations} sens ${k.sensor_faults} safe ${k.safe_mode_used} toolErr ${errors.length} | ${k.what_if_choice}${k.demand_response ? ' | DR ' + k.demand_response : ''}`);
  }
})();
