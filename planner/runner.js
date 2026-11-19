// Runs one simulator day with the agent core (same stages as the n8n Day Agent) and records a
// full 15-minute trace for the platform. Works in Node (harness, data builder) and in the browser
// (platform live mode). Needs CORE (planner/core.js) and a bridge base URL.
//   runDay(CORE, base, day, cfg, opt)   -> { k, sum, st, errors, trace, plan }
//   runBaseline(CORE, base, day)        -> { sum, meters, trace }   (do-nothing reference, same simulator)
(function (root) {
  function api(base) {
    const post = (p, b) => fetch(base + p, { method: 'POST', body: JSON.stringify(b) }).then(r => r.json()).catch(e => ({ error: String(e) }));
    const get = p => fetch(base + p).then(r => r.json()).catch(e => ({ error: String(e) }));
    return { post, get };
  }
  const ok = r => (r && !r.error) ? r : null;

  async function begin(C, base, day, cfg, opt) {
    const { post, get } = api(base);
    await post('/fault', { day, clear: true });
    await post('/session', { day });
    for (const f of opt.faults || []) await post('/fault', { day, ...f });
    const call = (tool, args) => post('/call', { day, tool, args }).then(r => (r && 'result' in r) ? r.result : { error: r && r.error || 'no response' });
    const sd = C.startDay({ cfg, siteRows: await get('/workbook?sheet=Site_Parameters'), chillerRows: await get('/workbook?sheet=Chillers'),
      tariffRows: ok(await call('get_tariff')), baselineRow: ok(await get('/baseline?day=' + day)), status: ok(await call('get_plant_status')),
      weatherRows: ok(await call('get_weather_forecast')), solarRows: ok(await call('get_solar_forecast')), orderRows: ok(await call('get_production_orders')),
      defaultSite: opt.defaultSite });
    return { post, get, call, sd };
  }

  function snap(status, cmds, res) {
    const s = status && !status.error ? status : {};
    return { chillers: s.chillers || null, storage_mode: s.storage_mode || null, storage_rate: s.storage_rate_kwth ?? null,
      presses: (s.presses_running || []).map(p => ({ order: p.order_id, press: p.press })),
      commands: (cmds || []).filter(c => !c.noop).map((c, i) => ({ tool: c.tool, args: c.args, ok: !(res[i] && res[i].error), error: res[i] && res[i].error ? String(res[i].error).slice(0, 120) : undefined })) };
  }

  async function runDay(C, base, day, cfg, opt = {}) {
    const { get, call, sd } = await begin(C, base, day, cfg, opt);
    const { site, state: st } = sd;
    C.commitChoice(site, st, opt.choice || 'A', sd.orders);
    const errors = [], trace = [];
    const exec = async cmds => { const res = []; for (const c of cmds) res.push(await call(c.tool, c.args)); for (const e of C.noteToolErrors(st, cmds, res)) { errors.push(`${e.tool} ${JSON.stringify(e.args)}: ${e.error}`); st.alerts.push(`TOOL_ERROR ${e.tool}: ${e.error}`); } return res; };
    let status = sd.status, orderRows = ok(await call('get_production_orders'));
    const c0 = C.buildCommands(status, orderRows || [], st.schedule, st.hours[0], st.dayStart, st, site);
    const r0 = await exec(c0);
    trace.push({ k: 0, t: C.fmtTs(st.dayStart), events: [], ai: null, validation: { ok: true, stage: 'day plan' }, replanned: true, ...snap(ok(await call('get_plant_status')), c0, r0), diary: (st.diary || []).length });
    const aiFor = opt.aiFor || (() => opt.ai);
    for (let k = 0; k < 96; k++) {
      await call('advance_time', { minutes: 15 });
      const raw = await call('get_plant_status'); await call('read_meters', { last_hours: 1 });
      orderRows = ok(await call('get_production_orders'));
      const weather = ok(await call('get_weather_forecast')), solar = ok(await call('get_solar_forecast'));
      const x = { site, cfg, state: st, status: raw && !raw.error ? raw : { now: C.fmtTs(st.dayStart + (k + 1) * 15 * 60000) }, orderRows, weatherRows: weather, solarRows: solar };
      const dBefore = (st.diary || []).length;
      const out = C.tick(x);
      if (out.finished) break;
      let ai = null;
      if (out.ai_needed) {
        const ans = aiFor(out.ai_context, out.events);
        if (ans) {
          const a = C.applyAiDecision({ site, cfg, state: st, status: x.status, orderRows, weatherRows: weather, solarRows: solar }, ans);
          ai = { asked: out.ai_context, answer: typeof ans === 'string' ? ans.slice(0, 200) : ans, applied: !!a.applied, decision: a.decision || null, note: a.reason || null };
          if (a.applied && a.desired) out.desired = a.desired;
        }
      }
      if (opt.onTick) opt.onTick(k, out);
      let cmds; try { cmds = C.buildCommands(x.status.chillers ? x.status : { ...x.status, chillers: {} }, orderRows || st.lastOrderRows || [], st.schedule, out.desired, st.dayStart, st, site); } catch (e) { cmds = []; st.alerts.push('ALERT command build error'); }
      const res = await exec(cmds);
      const v = out.validation;
      trace.push({ k: k + 1, t: out.now || x.status.now, raw_ok: !!(raw && !raw.error), events: (out.events || []).map(e => ({ ...e })), alerts: out.alerts || [], ai,
        validation: v ? { ok: !!v.ok, violations: (v.violations || []).slice(0, 4), stage: 'plan check' } : null, replanned: !!out.replanned, margin: st.margin, safe_mode: !!st.safeMode,
        desired: out.desired ? { run: out.desired.run, mode: out.desired.mode, rate: out.desired.rate } : null, diary_from: dBefore, diary_to: (st.diary || []).length,
        ...snap(raw && !raw.error ? raw : null, cmds, res) });
    }
    const meters = ok(await call('read_meters', { last_hours: 24 }));
    const k = C.dailyKpis(site, meters, ok(await call('get_production_orders')), ok(await get('/baseline?day=' + day)), st);
    const sum = await get('/summary?day=' + day);
    return { k, sum, st, errors, trace, meters, options: sd.options, site };
  }

  // Do-nothing reference in the same simulator: orders as early as possible, no ice strategy,
  // chillers staged to the load with one kept on standby (what-if option D).
  async function runBaseline(C, base, day, opt = {}) {
    const cfg = { day, margin: 0.08, peak_cap_kw: 4300, demand_weight: 0, use_ai: false, dr_events: [] };
    const { get, call, sd } = await begin(C, base, day, cfg, { faults: [] });
    const { site, state: st } = sd;
    const D = (st.whatIf || []).find(o => o.key === 'D');
    st.schedule = D.schedule; st.hours = D.hours; st.margin = 0;
    const trace = [];
    let known = sd.orders.length;
    const step = async (k, status, orderRows) => {
      const h = Math.min(23, Math.floor(k / 4));
      if (Array.isArray(orderRows) && orderRows.length > known) {      // a new (rush) order: start it as early as possible
        known = orderRows.length;
        try {
          const os = C.normOrders(orderRows, st.dayStart, site);
          const busy = p => os.filter(o => o.cur && o.cur.press === p).map(o => [o.cur.start, o.cur.start + o.dur]);
          for (const o of os) if (!o.cur && !st.schedule[o.id] && !o.invalid && !o.suspicious) {
            let best = null;
            for (const p of o.presses) { let t = Math.max(o.es, k % 4 === 0 ? h : h + 1); for (const [a, b] of busy(p).sort((x, y) => x[0] - y[0])) if (t < b && a < t + o.dur) t = b; if (!best || t < best.start) best = { press: p, start: t }; }
            if (best) { st.schedule[o.id] = best; for (let x = best.start; x < Math.min(24, best.start + o.dur); x++) if (st.hours[x]) st.hours[x] = Object.assign({}, st.hours[x], { run: site.chillers.slice(0, Math.min(3, (st.hours[x].run || []).length + 1)).map(c => c.id) }); }
          }
        } catch (e) { /* reference only */ }
      }
      const avail = site.chillers.filter(c => status.chillers && (status.chillers[c.id] === 'on' || status.chillers[c.id] === 'off'));
      const want = Math.min(Math.max(avail.length - 1, 0), (st.hours[h] || { run: [] }).run.length);
      const desired = { run: avail.slice(0, want).map(c => c.id), mode: 'idle', rate: 0 };
      const cmds = C.buildCommands(status, orderRows || [], st.schedule, desired, st.dayStart, st, site);
      const res = []; for (const c of cmds) res.push(await call(c.tool, c.args));
      trace.push({ k, t: status.now, ...snap(status, cmds, res) });
    };
    await step(0, ok(await call('get_plant_status')), ok(await call('get_production_orders')));
    for (let k = 0; k < 96; k++) {
      await call('advance_time', { minutes: 15 });
      const s = ok(await call('get_plant_status'));
      if (!s || C.parseTs(s.now) >= st.dayStart + 24 * 3600000) break;
      await step(k + 1, s, ok(await call('get_production_orders')));
    }
    const meters = ok(await call('read_meters', { last_hours: 24 }));
    const sum = await get('/summary?day=' + day);
    return { sum, meters, trace, schedule: st.schedule };
  }

  // Stand-in for the OpenAI decision agent so replays are reproducible without an API key. Same JSON
  // contract as the n8n "Energy Decision Agent"; the core still whitelists, clamps and re-validates it.
  function scriptedAi(ctx, events) {
    const t = (events || []).map(e => e.type);
    if (t.includes('invalid_order')) return { strategy: 'escalate', min_margin: 0.1, reason: 'order data failed validation and contains instruction-like text; a human must review it' };
    if (t.includes('chiller_trip')) return { strategy: 'conservative', min_margin: 0.3, reason: 'lost a chiller during the peak; keep extra cooling headroom until it is back' };
    if (t.includes('forecast_deviation')) return { strategy: 'conservative', min_margin: 0.25, reason: 'actual temperature is running well above the forecast' };
    if (t.includes('sensor_fault')) return { strategy: 'conservative', min_margin: 0.15, reason: 'a plant reading is not trustworthy; small extra margin while the last good value is used' };
    if (t.includes('order_infeasible') || t.includes('validation_failed')) return { strategy: 'escalate', min_margin: 0.1, reason: 'the plan cannot satisfy every rule; a human should decide' };
    if (t.includes('demand_response')) return { strategy: 'accept', min_margin: 0.08, reason: 'utility request accepted; the validator checks the cap and the hard rules' };
    if (t.includes('new_order')) return { strategy: 'accept', min_margin: 0.08, reason: 'the new order fits the plan without extra margin' };
    return { strategy: 'accept', min_margin: 0.08, reason: 'plan is within limits' };
  }
  const METER_COLS = ['t', 'grid_kw', 'chiller_kw', 'solar_kw', 'ice_kwhth', 'floor_c', 'outdoor_c', 'presses', 'chillers', 'cost_aed', 'tariff', 'load_kwth'];
  const compactMeters = m => (m || []).map(r => [String(r.timestamp).slice(11, 16), r.grid_kw, r.chiller_kw, r.solar_kw, r.ice_kwhth, r.floor_c, r.outdoor_c, r.presses_running, r.chillers_running, r.cost_aed, r.tariff, r.cooling_load_kwth]);
  function packScenario(s, r, orders) {
    return { ...s, sum: r.sum, kpi: r.k, options: r.options, orders, schedule: r.st.schedule, diary: r.st.diary, alerts: r.st.alerts, ai_decisions: r.st.aiDecisions, tool_errors: r.errors,
      meters: compactMeters(r.meters), trace: r.trace.map(x => ({ k: x.k, t: String(x.t).slice(11, 16), chillers: x.chillers, mode: x.storage_mode, rate: x.storage_rate, presses: x.presses,
        events: x.events || [], alerts: x.alerts, ai: x.ai ? { answer: x.ai.answer, applied: x.ai.applied, decision: x.ai.decision, note: x.ai.note, asked: x.ai.asked } : null,
        validation: x.validation, replanned: x.replanned, margin: x.margin, safe: x.safe_mode, desired: x.desired, cmds: x.commands, d0: x.diary_from, d1: x.diary_to, raw_ok: x.raw_ok })) };
  }
  const packBaseline = (b, official) => ({ sum: b.sum, official, meters: compactMeters(b.meters), schedule: b.schedule });
  async function runScenario(C, base, s) {
    const cfg = { day: s.day, margin: 0.08, peak_cap_kw: 4300, demand_weight: 0, use_ai: true, max_ai_calls: 6, hysteresis_aed: 30, dr_events: s.dr || [] };
    const r = await runDay(C, base, s.day, cfg, { faults: s.faults || [], aiFor: scriptedAi, choice: s.choice || 'A', onTick: s.onTick });
    const ord = await fetch(base + '/call', { method: 'POST', body: JSON.stringify({ day: s.day, tool: 'get_production_orders', args: {} }) }).then(x => x.json()).catch(() => ({}));
    const { onTick, ...meta } = s; return packScenario(meta, r, ord.result || []);
  }

  const R = { runDay, runBaseline, runScenario, scriptedAi, packScenario, packBaseline, compactMeters, METER_COLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = R; else root.RUNNER = R;
})(typeof window !== 'undefined' ? window : globalThis);
