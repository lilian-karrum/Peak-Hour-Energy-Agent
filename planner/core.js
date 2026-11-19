// ============================================================================
// Peak Hour Energy Agent - deterministic core (forecast prep, optimizer,
// constraint validator, plant model). Inlined into the n8n Code nodes by
// n8n/build_workflow.js so every node uses the identical logic.
// Sources: workbook sheets Site_Parameters, Chillers, Tariff, Practice_Baseline
// (served by the wrapper) + simulator physics documented in p3_energy_api.py
// (COP curve shape, 30 kW pumps per running chiller, 15-minute steps).
// ============================================================================
const CORE = (() => {
  const H = 3600e3;
  const parseTs = s => Date.parse(/Z$|[+-]\d\d:\d\d$/.test(String(s)) ? s : String(s) + 'Z');
  const fmtTs = ms => new Date(ms).toISOString().slice(0, 19);
  const num = s => parseFloat(String(s).replace(/,/g, ''));
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // ---------------------------------------------------------------- site config
  function buildSite(siteRows, chillerRows, tariffRows, baselineRows) {
    const P = {}, U = {}, missing = [];
    for (const r of siteRows || []) { P[r.parameter] = String(r.value ?? ''); U[r.parameter] = String(r['unit / note'] ?? ''); }
    const need = (k) => { if (!(k in P)) missing.push(k); return P[k]; };
    const heat = String(need('Building heat gain') || '');
    const m = heat.match(/=\s*([\d.]+)\s*\+\s*([\d.]+)\s*x\s*\(outdoor\s*-\s*([\d.]+)\s*C\)\s*\+\s*([\d.]+)\s*x\s*solar.*?\+\s*([\d.]+)\s*per running press/i);
    if (!m) missing.push('Building heat gain formula');
    const press = (U['Extrusion presses'] || '').match(/([\d,]+)\s*kW electric and\s*([\d,]+)\s*kW heat/i);
    if (!press) missing.push('Extrusion presses kW');
    const floorResp = String(need('Floor temperature response') || '').match(/([\d.]+)\s*C per hour for every\s*([\d.]+)\s*kW/i);
    const band = String(need('Production floor comfort band') || '').match(/([\d.]+)\s*-\s*([\d.]+)/);
    const chillers = (chillerRows || []).map(r => ({
      id: r.chiller_id, cap: num(r.capacity_kwth), rated: num(r.rated_cop), minPlr: num(r.min_part_load),
      ice: r.ice_mode_capable === true || String(r.ice_mode_capable).toLowerCase() === 'true',
      iceFactor: r.ice_mode_cop_factor == null ? null : num(r.ice_mode_cop_factor)
    })).sort((a, b) => b.rated - a.rated);
    if (!chillers.length) missing.push('Chillers sheet');
    const iceF = chillers.find(c => c.ice && c.iceFactor);
    const demandRow = (tariffRows || []).find(r => /demand/i.test(r.band));
    const co2Row = (baselineRows || []).find(r => num(r.baseline_grid_kwh) > 0 && num(r.baseline_co2_kg) > 0);
    if (!tariffRows || !tariffRows.length) missing.push('Tariff');
    const N = {};
    for (const [k, key] of [['baseKw', 'Base electrical load (lighting, compressed air, offices)'], ['iceMax', 'Ice thermal storage capacity'], ['chargeMax', 'Ice tank max charge rate'],
      ['dischargeMax', 'Ice tank max discharge rate'], ['iceLossPctH', 'Ice tank standing loss']]) { N[k] = num(P[key]); if (isNaN(N[k])) missing.push(key); }
    if (chillers.some(c => isNaN(c.cap) || isNaN(c.rated))) missing.push('Chillers capacity/COP');
    if (missing.length) throw new Error('Missing/unparseable site data: ' + missing.join(', '));
    return {
      load: { a: +m[1], b: +m[2], t0: +m[3], c: +m[4], d: +m[5] },
      pressKw: num(press[1]), pressHeat: num(press[2]), ...N,
      floorRise: floorResp ? +floorResp[1] / +floorResp[2] : 0.006, comfort: band ? [+band[1], +band[2]] : [20, 27],
      chillers, iceFactor: iceF ? iceF.iceFactor : 0.72, pumpKw: 30,
      demandAedPerKwMonth: demandRow ? num(demandRow.rate_aed_per_kwh) : 0, demandDays: 31,
      presses: (String(P['Extrusion presses'] || '').match(/EP-\d+/g) || ['EP-1', 'EP-2', 'EP-3']),
      co2KgPerKwh: co2Row ? num(co2Row.baseline_co2_kg) / num(co2Row.baseline_grid_kwh) : null,
      tariffRows
    };
  }

  function tariffForDay(site, dayStartMs) {
    const month = new Date(dayStartMs).getUTCMonth();
    const inSeason = s => {
      if (/all year/i.test(s)) return true;
      const mm = s.toLowerCase().match(/\((\w{3})-(\w{3})\)/); if (!mm) return false;
      const a = MONTHS.indexOf(mm[1]), b = MONTHS.indexOf(mm[2]);
      return a <= b ? month >= a && month <= b : month >= a || month <= b;
    };
    const rate = new Array(24).fill(null), band = new Array(24).fill(null);
    for (const r of site.tariffRows) {
      if (!inSeason(String(r.season)) || isNaN(num(r.rate_aed_per_kwh)) || /demand|export/i.test(r.band)) continue;
      for (const seg of String(r.hours).matchAll(/(\d\d):\d\d\s*-\s*(\d\d):\d\d/g)) {
        let h = +seg[1]; const e = +seg[2];
        do { rate[h] = num(r.rate_aed_per_kwh); band[h] = r.band; h = (h + 1) % 24; } while (h !== e);
      }
    }
    if (rate.some(x => x == null)) throw new Error('Tariff does not cover all 24 hours for month ' + (month + 1));
    return { rate, band };
  }

  // ------------------------------------------------- forecast normalisation
  // Missing values are interpolated; actuals replace forecasts for past hours;
  // the remaining forecast is bias-corrected from the latest actuals.
  function buildHours(site, weatherRows, solarRows, nowMs) {
    if (!weatherRows || !weatherRows.length) throw new Error('No weather forecast returned');
    const stamps = weatherRows.map(r => parseTs(r.timestamp)).filter(isFinite);
    if (!stamps.length) throw new Error('Weather forecast has no valid timestamps');
    const dayStart = Math.min(...stamps);
    const W = new Array(24).fill(null).map(() => ({})), warnings = [];
    const ok = (v, lo, hi, what, h) => { const x = Number(v); if (v == null || v === '' || !isFinite(x)) return null; if (x < lo || x > hi) { warnings.push(`rejected implausible ${what} ${v} at hour ${h}`); return null; } return x; };
    for (const r of weatherRows) { const h = Math.round((parseTs(r.timestamp) - dayStart) / H); if (h >= 0 && h < 24) Object.assign(W[h], { Tf: ok(r.forecast_temp_c, -10, 60, 'forecast temp', h), Gf: ok(r.forecast_ghi_w_m2, 0, 1400, 'forecast GHI', h), Ta: ok(r.actual_temp_c, -10, 60, 'measured temp', h) }); }
    for (const r of solarRows || []) { const h = Math.round((parseTs(r.timestamp) - dayStart) / H); if (h >= 0 && h < 24) Object.assign(W[h], { PVf: ok(r.forecast_pv_kw, 0, 2000, 'PV forecast', h), PVa: ok(r.actual_pv_kw, 0, 2000, 'PV measured', h) }); }
    const fill = key => {
      const ok = W.map(w => w[key] != null && !isNaN(w[key]));
      if (!ok.some(Boolean)) return false;
      for (let h = 0; h < 24; h++) if (!ok[h]) {
        let a = h - 1; while (a >= 0 && !ok[a]) a--; let b = h + 1; while (b < 24 && !ok[b]) b++;
        W[h][key] = a < 0 ? W[b][key] : b > 23 ? W[a][key] : W[a][key] + (W[b][key] - W[a][key]) * (h - a) / (b - a);
        warnings.push(`${key} missing at hour ${h}: interpolated`);
      }
      return true;
    };
    if (!fill('Tf')) throw new Error('Weather forecast has no temperatures');
    if (!fill('Gf')) { W.forEach(w => w.Gf = 0); warnings.push('GHI forecast missing: assumed 0 (conservative for PV, optimistic for load)'); }
    if (!fill('PVf')) { W.forEach(w => w.PVf = 0); warnings.push('PV forecast missing: assumed 0 kW (conservative)'); }
    const nowH = Math.floor((nowMs - dayStart) / H);
    const past = []; for (let h = 0; h < Math.min(nowH, 24); h++) if (W[h].Ta != null) past.push(h);
    const last2 = past.slice(-2);
    let dT = last2.length ? last2.reduce((s, h) => s + (W[h].Ta - W[h].Tf), 0) / last2.length : 0;
    dT = dT > 0 ? dT : dT * 0.5;
    const pvPast = past.filter(h => W[h].PVf > 50 && W[h].PVa != null).slice(-2);
    let pvRatio = pvPast.length ? pvPast.reduce((s, h) => s + W[h].PVa / W[h].PVf, 0) / pvPast.length : 1;
    pvRatio = Math.min(1.2, Math.max(0.3, pvRatio));
    const { rate, band } = tariffForDay(site, dayStart);
    const hours = W.map((w, h) => {
      const isPast = h < nowH && w.Ta != null;
      return { h, ts: fmtTs(dayStart + h * H), T: isPast ? w.Ta : w.Tf + dT, ghi: w.Gf * (isPast ? 1 : pvRatio),
        pv: isPast && w.PVa != null ? w.PVa : w.PVf * pvRatio, Tf: w.Tf, rate: rate[h], band: band[h] };
    });
    return { dayStart, hours, bias: { dT: +dT.toFixed(2), pvRatio: +pvRatio.toFixed(2) }, warnings };
  }

  const INJECTION = /(ignore|disregard|override|instruction|system prompt|assistant|you are|turn (all )?(chillers|everything) off|shut ?down|bypass|jailbreak|do not follow|new rule)/i;
  const KNOWN_ORDER_FIELDS = ['order_id', 'allowed_presses', 'duration_h', 'earliest_start', 'due_by', 'priority', 'scheduled_press', 'scheduled_start', 'product', 'alloy', 'customer', 'status'];
  function normOrders(orderRows, dayStart, site) {
    const pressIds = (site && site.presses) || ['EP-1', 'EP-2', 'EP-3'], seen = new Set(), out = [];
    for (const o of (Array.isArray(orderRows) ? orderRows : [])) {
      if (!o || typeof o !== 'object') continue;
      const id = String(o.order_id ?? '').trim(), problems = [];
      const safeId = /^[A-Za-z0-9_-]{1,24}$/.test(id) ? id : null;
      if (!safeId) problems.push('invalid order id');
      else if (seen.has(safeId)) problems.push('duplicate order id');
      const presses = String(o.allowed_presses ?? '').split(',').map(x => x.trim()).filter(x => pressIds.includes(x));
      if (!presses.length) problems.push('no valid press');
      const dur = Number(o.duration_h); if (!(Number.isInteger(dur) && dur >= 1 && dur <= 24)) problems.push('invalid duration');
      const es = Math.ceil((parseTs(o.earliest_start) - dayStart) / H), due = Math.floor((parseTs(o.due_by) - dayStart) / H);
      if (!isFinite(es) || !isFinite(due)) problems.push('invalid times');
      const texts = Object.entries(o).filter(([k, v]) => typeof v === 'string' && (!KNOWN_ORDER_FIELDS.includes(k) || v.length > 60));
      const suspicious = Object.values(o).some(v => typeof v === 'string' && INJECTION.test(v));
      if (suspicious) problems.push('instruction-like text in order data (ignored)');
      const curStart = o.scheduled_press ? Math.round((parseTs(o.scheduled_start) - dayStart) / H) : NaN;
      if (safeId) seen.add(safeId);
      out.push({ id: safeId || ('INVALID-' + out.length), presses, dur, es, due, priority: /^[A-Za-z]{1,12}$/.test(String(o.priority)) ? o.priority : 'normal',
        cur: o.scheduled_press && pressIds.includes(o.scheduled_press) && isFinite(curStart) ? { press: o.scheduled_press, start: curStart } : null,
        invalid: problems.some(p => !/ignored/.test(p)), suspicious, problems, extraText: texts.length });
    }
    return out;
  }
  const plannable = orders => orders.filter(o => !o.invalid && !o.rejected);
  const markRejected = (orders, st) => { for (const o of orders) if ((st.rejected || []).includes(o.id)) { o.rejected = true; } return orders; };
  // remember tool replies that prove an order does not exist in the plant system
  function noteToolErrors(st, cmds, results) {
    const errs = [];
    (cmds || []).forEach((c, i) => {
      const r = (results || [])[i];
      if (r && r.error) {
        errs.push({ tool: c.tool, args: c.args, error: clean(r.error, 120) });
        if (c.tool === 'schedule_batch' && /unknown|not found|no such/i.test(r.error)) { st.rejected = st.rejected || []; if (!st.rejected.includes(c.args.order_id)) { st.rejected.push(c.args.order_id); st.alerts.push(`ESCALATION: order ${c.args.order_id} rejected by the plant system (${clean(r.error, 60)}) – quarantined`); } }
      }
    });
    return errs;
  }

  // ------------------------------------------------------------ plant model
  const cop = (rated, T, plr) => { plr = Math.min(Math.max(plr, 0.25), 1); return rated * (1 - 0.018 * (T - 35)) * (1 - 0.35 * (plr - 0.75) ** 2); };
  const coolLoad = (s, T, ghi, np) => s.load.a + s.load.b * (T - s.load.t0) + s.load.c * ghi + s.load.d * np;
  function pressCount(schedule, orders, h) { let n = 0; for (const o of orders) { const a = schedule[o.id]; if (a && a.start <= h && h < a.start + o.dur) n++; } return n; }

  // 15-minute forward simulation mirroring the simulator's _step()
  function simulate(site, hours, plan, init, uplift = 0) {
    const byId = Object.fromEntries(site.chillers.map(c => [c.id, c]));
    let ice = init.ice, floor = init.floor, cost = 0, kwh = 0, peak = 0, floorMax = floor, comfortMin = 0, standbyViol = 0, unmetKwh = 0;
    const per = [];
    const lossStep = 1 - site.iceLossPctH / 100 / 4;
    for (let h = init.fromHour; h < 24; h++) {
      const w = hours[h], p = plan.hours[h], np = p.np;
      const running = p.run.filter(c => !init.tripped.includes(c));
      const availOff = site.chillers.filter(c => !running.includes(c.id) && !init.tripped.includes(c.id));
      let hc = 0, hk = 0, gmax = 0;
      for (let q = 0; q < 4; q++) {
        const T = w.T + uplift, load = coolLoad(site, T, w.ghi, np);
        if (!availOff.length) standbyViol += 15;
        const cap = running.reduce((s, c) => s + byId[c].cap, 0);
        let charge = 0, dis = 0;
        if (p.mode === 'charge') charge = Math.min(p.rate, site.chargeMax, running.filter(c => byId[c].ice).reduce((s, c) => s + byId[c].cap, 0), (site.iceMax - ice) / 0.25);
        else if (p.mode === 'discharge') dis = Math.min(p.rate, site.dischargeMax, ice / 0.25, load);
        const toFloor = Math.min(Math.max(cap - charge, 0), Math.max(load - dis, 0));
        const unmet = load - dis - toFloor;
        let elec = 0;
        if (running.length) {
          const plr = cap ? (toFloor + charge) / cap : 0, rc = running.reduce((s, c) => s + byId[c].rated, 0) / running.length;
          const k = cop(rc, T, plr); elec = toFloor / k + charge / (k * site.iceFactor) + site.pumpKw * running.length;
        }
        ice = Math.min(site.iceMax, Math.max(0, ice * lossStep + (charge - dis) * 0.25));
        if (unmet > 1) { floor += site.floorRise * unmet * 0.25; unmetKwh += unmet * 0.25; } else if (floor > 24) floor = Math.max(24, floor - 0.25);
        floorMax = Math.max(floorMax, floor);
        if (floor < site.comfort[0] || floor > site.comfort[1]) comfortMin += 15;
        const grid = Math.max(elec + site.pressKw * np + site.baseKw - w.pv, 0);
        peak = Math.max(peak, grid); gmax = Math.max(gmax, grid); hc += grid * w.rate * 0.25; hk += grid * 0.25;
      }
      cost += hc; kwh += hk;
      per.push({ h, cost: +hc.toFixed(1), kwh: Math.round(hk), gmax: Math.round(gmax), ice: Math.round(ice), floor: +floor.toFixed(2) });
    }
    return { cost, kwh, peak, floorMax, comfortMin, standbyViol, unmetKwh, iceEnd: ice, per };
  }

  // ------------------------------------- storage + chiller dispatch (greedy)
  function planStorage(site, hours, np, init, margin) {
    const F = init.fromHour, avail = site.chillers.filter(c => !init.tripped.includes(c.id));
    const maxRun = Math.max(avail.length - 1, 0), cap1 = avail.length ? avail[0].cap : 1200;
    const iceAvail = avail.filter(c => c.ice), iceCapKw = iceAvail.reduce((s, x) => s + x.cap, 0);
    const d = (1 - site.iceLossPctH / 100 / 4) ** 4, q = 150;
    const L = [], Lm = [], D = new Array(24).fill(0), C = new Array(24).fill(0), dcap = [], ccap = [];
    for (let h = F; h < 24; h++) {
      L[h] = coolLoad(site, hours[h].T, hours[h].ghi, np[h]); Lm[h] = L[h] * (1 + margin);
      dcap[h] = Math.min(site.dischargeMax, Lm[h]);
      ccap[h] = iceAvail.length ? Math.max(0, Math.min(site.chargeMax, iceCapKw, maxRun * cap1 - Lm[h])) : 0;
    }
    // marginal grid cost of an hour for a given discharge / charge (solar surplus is free)
    const costH = (h, Dh, Ch) => {
      const need = Math.max(Lm[h] - Dh, 0) + Ch, n = need <= 1e-6 ? 0 : Math.min(maxRun, Math.ceil(need / cap1 - 1e-9));
      let elec = 0;
      if (n) {
        const rc = avail.slice(0, n).reduce((s, x) => s + x.rated, 0) / n;
        const toFloor = Math.max(L[h] - Dh, 0), k = cop(rc, hours[h].T, (toFloor + Ch) / (n * cap1));
        elec = toFloor / k + Ch / (k * site.iceFactor) + site.pumpKw * n;
      }
      const grid = Math.max(site.baseKw + site.pressKw * np[h] + elec - hours[h].pv, 0);
      const dr = init.drCap && init.drCap[h] != null && grid > init.drCap[h] ? 8 * (grid - init.drCap[h]) : 0;
      return grid * hours[h].rate + (site.peakCapKw && grid > site.peakCapKw ? 2 * (grid - site.peakCapKw) : 0) + dr;
    };
    const levelsOk = () => { let l = init.ice; for (let h = F; h < 24; h++) { if (D[h] > l * d + C[h] + 1e-6) return false; l = l * d + C[h] - D[h]; if (l > site.iceMax + 1e-6) return false; } return true; };
    for (let it = 0; it < 500; it++) {
      const hs = [];
      for (let h = F; h < 24; h++) if (C[h] === 0 && D[h] + q <= dcap[h] + 1e-6) { const g = costH(h, D[h], 0) - costH(h, D[h] + q, 0); if (g > 1e-6) hs.push([h, g]); }
      hs.sort((x, y) => y[1] - x[1]);
      let accepted = false;
      for (const [h, gain] of hs) {
        D[h] += q; if (levelsOk()) { accepted = true; break; }
        const gs = [];
        for (let g = F; g < h; g++) { const qc = q / d ** (h - g) + 1; if (D[g] === 0 && C[g] + qc <= ccap[g] + 1e-6) gs.push([g, qc, costH(g, 0, C[g] + qc) - costH(g, 0, C[g])]); }
        gs.sort((x, y) => x[2] - y[2]);
        for (const [g, qc, cc] of gs) { if (cc >= gain - 1e-6) break; C[g] += qc; if (levelsOk()) { accepted = true; break; } C[g] -= qc; }
        if (accepted) break;
        D[h] -= q;
      }
      if (!accepted) break;
    }
    const out = new Array(24).fill(null);
    for (let h = F; h < 24; h++) {
      let need = Math.max(Lm[h] - D[h], 0) + C[h];
      let n = need <= 1e-6 ? 0 : Math.ceil(need / cap1 - 1e-9);
      if (n > maxRun) { const over = (n - maxRun) * cap1; C[h] = Math.max(0, C[h] - over); n = maxRun; }
      const run = avail.slice(0, n).map(x => x.id);
      const mode = C[h] > 0 ? 'charge' : D[h] > 0 ? 'discharge' : 'idle';
      const rate = mode === 'charge' ? C[h] : mode === 'discharge' ? (n === 0 ? site.dischargeMax : D[h]) : 0;
      out[h] = { h, np: np[h], load: Math.round(L[h]), run, mode, rate: Math.round(rate), D: Math.round(D[h]), C: Math.round(C[h]) };
    }
    return { hours: out };
  }

  function evaluate(site, hours, orders, schedule, init, margin) {
    const np = new Array(24).fill(0); for (let h = 0; h < 24; h++) np[h] = pressCount(schedule, orders, h);
    const plan = planStorage(site, hours, np, init, margin);
    const sim = simulate(site, hours, plan, init, 0);
    const demand = (site.demandWeight ?? 0) * sim.peak * site.demandAedPerKwMonth / site.demandDays + (site.peakCapKw ? 5 * Math.max(0, sim.peak - site.peakCapKw) : 0);
    const drPen = init.drCap ? sim.per.reduce((s, p) => s + (init.drCap[p.h] != null ? 20 * Math.max(0, p.gmax - init.drCap[p.h]) : 0), 0) : 0;
    const penalty = (sim.floorMax > 26 ? 1e5 * (sim.floorMax - 26) : 0) + sim.standbyViol * 1e4 + drPen;
    return { plan, sim, obj: sim.cost + demand + penalty };
  }

  // ----------------------------------------------------- press scheduling
  function candidates(o, init) {
    const out = []; const from = Math.max(o.es, init.pressFrom);
    for (const p of o.presses) for (let s = from; s + o.dur <= Math.min(o.due, 24); s++) out.push({ press: p, start: s });
    return out;
  }
  const overlaps = (a, da, b, db) => a.press === b.press && a.start < b.start + db && b.start < a.start + da;

  function optimize(site, hours, orders, init, margin, opts = {}) {
    const fixed = {}, free = [], infeasible = [];
    for (const o of orders) {
      if (o.cur && o.cur.start < init.pressFrom) fixed[o.id] = o.cur;      // started / locked
      else { const cand = candidates(o, init); if (!cand.length) infeasible.push(o.id); else free.push({ o, cand }); }
    }
    // separable marginal cost per press-hour from a no-free-press reference plan
    const ref = evaluate(site, hours, orders, fixed, init, margin);
    const eH = new Array(24).fill(0);
    for (let h = init.fromHour; h < 24; h++) {
      const p = ref.plan.hours[h], w = hours[h];
      const chillerKw = p.run.length ? (Math.max(p.load * (1 + margin) - p.D, 0) + p.C / site.iceFactor) / cop(5.3, w.T, 0.75) + site.pumpKw * p.run.length : 0;
      const surplus = Math.max(0, w.pv - site.baseKw - site.pressKw * p.np - chillerKw);
      eH[h] = w.rate * (Math.max(0, site.pressKw - surplus) + site.pressHeat / cop(5.3, w.T, 0.75));
    }
    const ocost = (o, a) => { let s = 0; for (let h = a.start; h < a.start + o.dur; h++) s += eH[h]; return s + (a.press !== 'EP-3' && o.presses.includes('EP-3') ? 0.5 * o.dur : 0); };
    free.forEach(f => { f.cand.forEach(a => a.cost = ocost(f.o, a)); f.cand.sort((x, y) => x.cost - y.cost); f.min = f.cand[0].cost; });
    free.sort((x, y) => x.cand.length - y.cand.length);
    const K = opts.topK || 15, best = []; let nodes = 0;
    const occ = Object.entries(fixed).map(([id, a]) => ({ a, dur: orders.find(o => o.id === id).dur }));
    const suffixMin = free.map((_, i) => free.slice(i).reduce((s, f) => s + f.min, 0));
    const cur = {};
    (function dfs(i, cost) {
      if (++nodes > (opts.nodeLimit || 200000)) return;
      if (best.length === K && cost + (suffixMin[i] || 0) >= best[best.length - 1].cost) return;
      if (i === free.length) { best.push({ cost, sch: { ...cur } }); best.sort((a, b) => a.cost - b.cost); if (best.length > K) best.pop(); return; }
      const { o, cand } = free[i];
      for (const a of cand) {
        if (occ.some(x => overlaps(a, o.dur, x.a, x.dur))) continue;
        cur[o.id] = a; occ.push({ a, dur: o.dur });
        dfs(i + 1, cost + a.cost);
        occ.pop(); delete cur[o.id];
      }
    })(0, 0);
    if (!best.length && free.length) return { ok: false, reason: 'no feasible press schedule', infeasible: free.map(f => f.o.id).concat(infeasible) };
    let top = null;
    for (const b of best.length ? best : [{ sch: {} }]) {
      const sch = { ...fixed }; for (const [k, a] of Object.entries(b.sch)) sch[k] = { press: a.press, start: a.start };
      const ev = evaluate(site, hours, orders, sch, init, margin);
      if (!top || ev.obj < top.ev.obj) top = { sch, ev };
    }
    // local search with full evaluation (captures demand charge, solar, ice coupling)
    let evals = 0, improved = true;
    while (improved && evals < (opts.evalBudget || 400)) {
      improved = false;
      for (const f of free) {
        for (const a of f.cand) {
          const curA = top.sch[f.o.id]; if (curA.press === a.press && curA.start === a.start) continue;
          if (Object.entries(top.sch).some(([id, x]) => id !== f.o.id && overlaps(a, f.o.dur, x, orders.find(o => o.id === id).dur))) continue;
          const sch = { ...top.sch, [f.o.id]: { press: a.press, start: a.start } };
          const ev = evaluate(site, hours, orders, sch, init, margin); evals++;
          if (ev.obj < top.ev.obj - 0.5) { top = { sch, ev }; improved = true; break; }
        }
        if (evals >= (opts.evalBudget || 400)) break;
      }
    }
    return { ok: infeasible.length === 0, infeasible, schedule: top.sch, plan: top.ev.plan, sim: top.ev.sim, obj: top.ev.obj, margin, nodes, evals };
  }

  // ------------------------------------------------- hard-constraint validator
  function validate(site, hours, orders, res, init, opts = {}) {
    const v = [], uplift = opts.uplift ?? 1.0, floorLimit = opts.floorLimit ?? 26.5;
    if (!res || !res.plan) return { ok: false, violations: ['no plan'] };
    const avail = site.chillers.filter(c => !init.tripped.includes(c.id)).map(c => c.id);
    const byId = Object.fromEntries(site.chillers.map(c => [c.id, c]));
    for (let h = init.fromHour; h < 24; h++) {
      const p = res.plan.hours[h];
      if (p.run.some(c => !avail.includes(c))) v.push(`h${h}: runs unavailable chiller`);
      if (!avail.some(c => !p.run.includes(c))) v.push(`h${h}: no chiller on standby`);
      if (p.mode === 'charge' && !p.run.some(c => byId[c].ice)) v.push(`h${h}: charging without ice-capable chiller`);
      if (p.mode === 'charge' && p.rate > site.chargeMax) v.push(`h${h}: charge rate above max`);
      if (p.mode === 'discharge' && p.rate > site.dischargeMax) v.push(`h${h}: discharge rate above max`);
    }
    for (const o of orders) {
      const a = res.schedule[o.id];
      if (!a && (res.infeasible || []).includes(o.id)) continue;
      if (!a) { v.push(`${o.id}: not scheduled`); continue; }
      if (!o.presses.includes(a.press)) v.push(`${o.id}: press ${a.press} not allowed`);
      if (a.start < o.es) v.push(`${o.id}: starts before earliest start`);
      if (a.start < init.pressFrom && !(o.cur && o.cur.start === a.start && o.cur.press === a.press)) v.push(`${o.id}: start time is in the past`);
      if (a.start + o.dur > o.due) v.push(`${o.id}: finishes after due time`);
      for (const o2 of orders) if (o2.id < o.id && res.schedule[o2.id] && overlaps(a, o.dur, res.schedule[o2.id], o2.dur)) v.push(`${o.id}/${o2.id}: overlap on ${a.press}`);
    }
    const sim = simulate(site, hours, res.plan, init, uplift);
    if (sim.floorMax > floorLimit) v.push(`floor reaches ${sim.floorMax.toFixed(2)} C with +${uplift} C stress (limit ${floorLimit})`);
    if (sim.comfortMin > 0) v.push(`comfort band violated ${sim.comfortMin} min under stress`);
    if (sim.standbyViol > 0) v.push('standby violation in simulation');
    return { ok: v.length === 0, violations: v, stress: { uplift, floorMax: +sim.floorMax.toFixed(2) } };
  }

  // optimise + validate + deterministic repair (raise safety margin)
  function planAndValidate(site, hours, allOrders, init, minMargin = 0.08) {
    const orders = plannable(allOrders);
    const margins = [0.08, 0.15, 0.25, 0.4, 0.6].filter(m => m >= minMargin);
    if (!margins.length) margins.push(minMargin);
    let last = null;
    for (const m of margins) {
      const res = optimize(site, hours, orders, init, m);
      if (!res.schedule) return { ok: false, res, validation: { ok: false, violations: [res.reason + ': ' + (res.infeasible || []).join(',')] }, attempts: m };
      const val = validate(site, hours, orders, res, init);
      last = { ok: val.ok, res, validation: val, margin: m };
      if (val.ok) return last;
    }
    return last;
  }

  function summarizePlan(site, res) {
    return {
      margin: res.margin, est_cost_aed: Math.round(res.sim.cost), est_peak_kw: Math.round(res.sim.peak), est_kwh: Math.round(res.sim.kwh),
      est_floor_max_c: +res.sim.floorMax.toFixed(2),
      batches: Object.entries(res.schedule).map(([id, a]) => `${id}@${a.press}@${String(a.start).padStart(2, '0')}:00`),
      hours: res.plan.hours.filter(Boolean).map(p => `${String(p.h).padStart(2, '0')} ch=${p.run.length}(${p.run.join('/')}) ${p.mode}${p.rate ? ':' + p.rate : ''} presses=${p.np}`)
    };
  }


  // ======================================================================
  // Hourly monitor / re-plan, guardrails, explainability, DR, what-if
  // ======================================================================
  const REPLAN_EVENTS = ['chiller_trip', 'chiller_recovered', 'new_order', 'order_cancelled', 'forecast_deviation', 'floor_high', 'demand_response', 'sensor_fault', 'invalid_order'];
  const AI_EVENTS = ['chiller_trip', 'new_order', 'forecast_deviation', 'validation_failed', 'order_infeasible', 'sensor_fault', 'invalid_order', 'demand_response'];
  const VALID_STATES = ['on', 'off', 'tripped'];
  const hhmm = h => String(h).padStart(2, '0') + ':00';
  const prose = (v, n) => String(v ?? '').replace(/[<>{}`\u0000-\u001f]/g, ' ').slice(0, n);
  const clean = (v, n = 40) => String(v ?? '').replace(/[^A-Za-z0-9 .:_%°+\-\/]/g, '').slice(0, n);

  // ---- demand response: utility asks to keep grid import <= cap_kw in a window
  function parseDr(list) {
    const toH = t => { const m = String(t ?? '').match(/^(\d{1,2})(?::(\d\d))?$/); return m ? Math.min(24, +m[1] + (+(m[2] || 0)) / 60) : NaN; };
    return (Array.isArray(list) ? list : []).map(e => ({ announce: toH(e.announce ?? '00:00'), start: Math.floor(toH(e.start)), end: Math.ceil(toH(e.end)), cap: Number(e.cap_kw), id: clean(e.id || `DR ${e.start}-${e.end}`, 24) }))
      .filter(e => isFinite(e.start) && isFinite(e.end) && e.end > e.start && e.cap > 0 && isFinite(e.announce));
  }
  function drCapArray(active) {
    if (!active || !active.length) return null;
    const cap = new Array(24).fill(null);
    for (const e of active) for (let h = Math.max(0, e.start); h < Math.min(24, e.end); h++) cap[h] = cap[h] == null ? e.cap : Math.min(cap[h], e.cap);
    return cap;
  }

  // ---- sensor validation: implausible or jumping readings are replaced by the last good value
  function sanitizeStatus(raw, st, site) {
    const faults = [], s = Object.assign({}, raw || {});
    const ch = {};
    const src = raw && typeof raw.chillers === 'object' && raw.chillers ? raw.chillers : null;
    if (!src) faults.push('chiller status missing: last known used');
    for (const c of site.chillers) {
      const v = src ? src[c.id] : undefined;
      if (VALID_STATES.includes(v)) ch[c.id] = v;
      else { ch[c.id] = (st.lastStatus && st.lastStatus.chillers && st.lastStatus.chillers[c.id]) || 'unknown'; if (src) faults.push(`${c.id} status "${clean(v, 12)}" invalid`); }
    }
    s.chillers = ch;
    const lg = st.lastGood || { floor: 24, ice: null };
    let f = Number(raw && raw.floor_temp_c);
    if (!isFinite(f) || f < 5 || f > 50) { faults.push(`floor reading ${clean(raw && raw.floor_temp_c, 10)} implausible`); f = lg.floor; s.floorSuspect = true; }
    else if (st.lastGood && Math.abs(f - lg.floor) > 3) { faults.push(`floor jumped ${lg.floor}→${f} °C in 15 min`); s.floorSuspect = true; f = Math.max(lg.floor, Math.min(f, lg.floor + 2)); }
    s.floor_temp_c = f;
    let ice = Number(raw && raw.ice_kwhth);
    if (!isFinite(ice) || ice < 0 || ice > site.iceMax * 1.02) { faults.push(`ice reading ${clean(raw && raw.ice_kwhth, 10)} implausible`); ice = lg.ice != null ? lg.ice : 0; }
    s.ice_kwhth = ice;
    if (!['charge', 'discharge', 'idle'].includes(s.storage_mode)) s.storage_mode = 'unknown';
    s.storage_rate_kwth = isFinite(Number(s.storage_rate_kwth)) ? Number(s.storage_rate_kwth) : 0;
    if (!s.floorSuspect) st.lastGood = { floor: f, ice };
    else st.lastGood = { floor: lg.floor, ice };
    st.lastStatus = { chillers: ch };
    return { status: s, faults };
  }

  // ---- safe mode: used whenever planning cannot run (no forecast, unexpected error)
  function safePlan(site, orders, init) {
    const avail = site.chillers.filter(c => !init.tripped.includes(c.id)), maxRun = Math.max(avail.length - 1, 0);
    const schedule = {}, busy = {};
    for (const o of orders) if (o.cur && o.cur.start < init.pressFrom) { schedule[o.id] = o.cur; (busy[o.cur.press] = busy[o.cur.press] || []).push([o.cur.start, o.cur.start + o.dur]); }
    for (const o of plannable(orders).filter(o => !schedule[o.id]).sort((a, b) => a.due - b.due)) {
      let best = null;
      for (const p of o.presses) for (let st = Math.max(o.es, init.pressFrom); st + o.dur <= Math.min(o.due, 24); st++) {
        if ((busy[p] || []).some(([a, b]) => st < b && a < st + o.dur)) continue;
        if (!best || st < best.start) best = { press: p, start: st }; break;
      }
      if (best) { schedule[o.id] = best; (busy[best.press] = busy[best.press] || []).push([best.start, best.start + o.dur]); }
    }
    const hours = new Array(24).fill(null);
    for (let h = init.fromHour; h < 24; h++) hours[h] = { h, np: pressCount(schedule, orders, h), load: null, run: avail.slice(0, maxRun).map(c => c.id), mode: init.ice > 200 ? 'discharge' : 'idle', rate: init.ice > 200 ? site.dischargeMax : 0, D: 0, C: 0 };
    return { schedule, plan: { hours }, sim: null, margin: null, safeMode: true };
  }

  // ---- explainability: one plain-language diary line per decision
  function explainHour(site, p, hrs, tripped = []) {
    if (!p) return '';
    const w = hrs && hrs[p.h];
    const why = [];
    const cheapest = hrs ? Math.min(...hrs.filter(Boolean).map(x => x.rate)) : null;
    if (p.mode === 'discharge') why.push(w && w.rate <= cheapest ? `melting ice to keep grid import under the ${site.peakCapKw || ''} kW peak limit while ${p.np} press(es) run` : `melting ice${w ? ` (power costs ${w.rate} AED/kWh, ${Math.round(w.pv)} kW solar)` : ''}`);
    if (p.mode === 'charge') why.push(w && w.rate > cheapest && w.pv > site.baseKw ? `making ice at ${p.rate} kW with spare solar power (${Math.round(w.pv)} kW solar)` : `making ice at ${p.rate} kW while power is cheap${w ? ` (${w.rate} AED/kWh)` : ''}`);
    why.push(`${p.run.length} chiller(s) ${p.run.join('/') || '-'} for ~${p.load ?? '?'} kW cooling need`);
    const off = site.chillers.map(c => c.id).filter(c => !p.run.includes(c) && !tripped.includes(c));
    if (off.length) why.push(`backup: ${off[0]}`);
    return why.join('; ');
  }
  function diary(st, t, saw, decided, why) {
    st.diary = st.diary || [];
    st.diary.push({ t: String(t).slice(11, 16) || String(t), saw: prose(saw, 300), decided: prose(decided, 300), why: prose(why, 360) });
    if (st.diary.length > 400) st.diary.shift();
  }
  function scheduleDiff(a, b) {
    const ch = [];
    for (const [id, x] of Object.entries(b || {})) { const y = (a || {})[id]; if (!y || y.press !== x.press || y.start !== x.start) ch.push(`${id} to ${x.press} at ${hhmm(x.start)}`); }
    return ch;
  }

  // ---- what-if view: options shown to the operator before committing the day plan
  function doNothingPlan(site, hours, orders, init) {
    const ref = safePlan(site, orders, init);
    const avail = site.chillers.filter(c => !init.tripped.includes(c.id)), maxRun = Math.max(avail.length - 1, 0);
    for (let h = init.fromHour; h < 24; h++) {
      const np = pressCount(ref.schedule, orders, h), L = coolLoad(site, hours[h].T, hours[h].ghi, np);
      ref.plan.hours[h] = { h, np, load: Math.round(L), run: avail.slice(0, Math.min(maxRun, Math.ceil(L / avail[0].cap))).map(c => c.id), mode: 'idle', rate: 0, D: 0, C: 0 };
    }
    ref.sim = simulate(site, hours, ref.plan, init, 0); ref.safeMode = false; return ref;
  }
  function whatIf(site, hours, allOrders, init, cfg) {
    const orders = plannable(allOrders), out = [];
    const variant = (key, label, s2, minMargin, note) => {
      try {
        const r = planAndValidate(s2, hours, allOrders, init, minMargin);
        if (!r.res || !r.res.schedule) { out.push({ key, label, ok: false, note: 'no feasible plan' }); return; }
        out.push(summarizeOption(s2, hours, orders, init, key, label, r.res, r.ok, note));
      } catch (e) { out.push({ key, label, ok: false, note: 'error: ' + clean(e.message, 80) }); }
    };
    variant('A', 'Recommended', site, cfg.margin || 0.08, 'balanced cost, peak and safety');
    variant('B', 'Max savings', Object.assign({}, site, { peakCapKw: 0 }), 0.08, 'no peak limit: cheapest energy, higher demand charge');
    variant('C', 'Extra safe', site, 0.25, '25% extra cooling margin');
    try { const d = doNothingPlan(site, hours, orders, init); out.push(summarizeOption(site, hours, orders, init, 'D', 'Do nothing (reference)', d, true, 'orders as early as possible, no ice strategy')); } catch (e) { /* reference only */ }
    return out;
  }
  function summarizeOption(site, hours, orders, init, key, label, res, ok, note) {
    const stress = simulate(site, hours, res.plan, init, 1.0), sim = res.sim || simulate(site, hours, res.plan, init, 0);
    const dpk = site.demandAedPerKwMonth / site.demandDays, peakPress = [];
    for (let h = 12; h < 18; h++) if (res.plan.hours[h] && res.plan.hours[h].np) peakPress.push(h);
    const late = orders.filter(o => { const a = res.schedule[o.id]; return !a || a.start + o.dur > o.due; }).length;
    const drOver = init.drCap ? sim.per.reduce((m, p) => init.drCap[p.h] != null ? Math.max(m, p.gmax - init.drCap[p.h]) : m, 0) : null;
    return { key, label, note, ok: !!ok, energy_cost_aed: Math.round(sim.cost), demand_charge_aed: Math.round(sim.peak * dpk), total_aed: Math.round(sim.cost + sim.peak * dpk),
      peak_kw: Math.round(sim.peak), floor_max_stress_c: +stress.floorMax.toFixed(1), late_orders: late, press_hours_in_peak: peakPress.length,
      dr_over_kw: drOver == null ? null : Math.max(0, Math.round(drOver)), schedule: res.schedule, hours: res.plan.hours, margin: res.margin };
  }
  function whatIfText(opts) {
    const L = ['Option | Energy AED | Demand AED | Total AED | Peak kW | Floor max (+1°C) | Late | Press hrs in peak' + (opts.some(o => o.dr_over_kw != null) ? ' | DR over kW' : '') + ' | Valid'];
    for (const o of opts) L.push(`${o.key} ${o.label} | ${o.energy_cost_aed ?? '-'} | ${o.demand_charge_aed ?? '-'} | ${o.total_aed ?? '-'} | ${o.peak_kw ?? '-'} | ${o.floor_max_stress_c ?? '-'} | ${o.late_orders ?? '-'} | ${o.press_hours_in_peak ?? '-'}` + (o.dr_over_kw != null ? ` | ${o.dr_over_kw}` : '') + ` | ${o.ok ? 'yes' : 'NO'}`);
    return L.join('\n');
  }

  // ---- the 15-minute monitor (never throws: callers wrap it, see safeDesired)
  function monitorTick(c) {
    const { site, cfg, orderRows, weatherRows, solarRows } = c; const st = c.state;
    const nowMs = parseTs(c.status && c.status.now);
    if (!isFinite(nowMs)) throw new Error('plant status has no valid time');
    const { status, faults } = sanitizeStatus(c.status, st, site);
    let hh, fcFail = null;
    try { hh = buildHours(site, weatherRows, solarRows, nowMs); } catch (e) { fcFail = e.message; }
    const dayStart = st.dayStart;
    const hour = Math.floor((nowMs - dayStart) / H), minute = Math.round(((nowMs - dayStart) % H) / 60000);
    const events = [], alerts = [];
    if (hour >= 24) return { finished: true, events, alerts, state: st };
    if (faults.length) { events.push({ type: 'sensor_fault', detail: faults.join('; ') }); alerts.push(`WARN ${status.now}: sensor fault – ${faults.join('; ')} (last good value used)`); }
    if (fcFail) { events.push({ type: 'sensor_fault', detail: 'forecast unavailable: ' + clean(fcFail, 80) }); alerts.push(`WARN ${status.now}: forecast unavailable – safe mode`); }
    const tripped = Object.entries(status.chillers).filter(([, v]) => v !== 'on' && v !== 'off').map(([k]) => k);
    for (const t of tripped) if (!st.tripped.includes(t)) { events.push({ type: 'chiller_trip', chiller: t }); alerts.push(`ALERT ${status.now}: ${t} unavailable (${status.chillers[t]}) – removed from dispatch, backup recomputed`); }
    for (const t of st.tripped) if (!tripped.includes(t)) events.push({ type: 'chiller_recovered', chiller: t });
    const orders = markRejected(normOrders(orderRows, dayStart, site), st);
    const ids = orders.map(o => o.id);
    for (const o of orders) if (!st.known.includes(o.id)) {
      if (o.invalid || o.suspicious) { events.push({ type: 'invalid_order', order: o.id, problems: o.problems.join('; ') }); alerts.push(`ESCALATION ${status.now}: order ${o.id} needs a human – ${o.problems.join('; ')}`); }
      else events.push({ type: 'new_order', order: o.id, priority: o.priority, due_hour: o.due, dur: o.dur });
    }
    if (Array.isArray(orderRows)) for (const k of st.known) if (!ids.includes(k)) events.push({ type: 'order_cancelled', order: k });
    if (hh && Math.abs(hh.bias.dT) >= 1.5 && Math.abs(hh.bias.dT - (st.lastAlertDT || 0)) >= 1.5) { events.push({ type: 'forecast_deviation', dT: hh.bias.dT }); st.lastAlertDT = hh.bias.dT; }
    if (status.floor_temp_c > 25.5) events.push({ type: 'floor_high', floor: status.floor_temp_c });
    // demand response
    const hNow = (nowMs - dayStart) / H;
    for (const e of st.drAll || []) if (!st.drActive.some(x => x.id === e.id) && hNow >= e.announce) {
      st.drActive.push(e); events.push({ type: 'demand_response', window: `${hhmm(e.start)}-${hhmm(e.end)}`, cap_kw: e.cap });
      alerts.push(`INFO ${status.now}: demand-response request ${hhmm(e.start)}–${hhmm(e.end)} keep grid ≤ ${e.cap} kW – accepted, re-planning`);
    }
    const availOff = Object.entries(status.chillers).filter(([, v]) => v === 'off').length;
    if (!availOff) alerts.push(`ALERT ${status.now}: no chiller on standby (observed)`);
    st.tripped = tripped; if (Array.isArray(orderRows)) st.known = ids; if (hh) st.bias = hh.bias;
    let replanned = false, validation = null;
    const init = { fromHour: hour, pressFrom: minute === 0 ? hour : hour + 1, ice: status.ice_kwhth, floor: status.floor_temp_c, tripped, drCap: drCapArray(st.drActive) };
    if (minute === 0 || events.some(e => REPLAN_EVENTS.includes(e.type))) {
      const before = st.schedule;
      if (!hh) {
        const r = safePlan(site, orders, init); st.schedule = Object.assign({}, st.schedule, r.schedule); st.hours = r.plan.hours; st.safeMode = true; st.safeModeUsed = true; replanned = true;
        diary(st, status.now, 'no usable forecast', 'safe mode: max chillers allowed (one kept as backup), no ice making', 'cannot plan cost-optimally without a forecast; safety first');
      } else {
        const r = planAndValidate(site, hh.hours, orders, init, st.minMargin || cfg.margin || 0.08);
        let chosen = r;
        if (st.schedule && r.res && r.res.schedule) {
          const prev = {}; let ok = true;
          for (const o of plannable(orders)) { const a = st.schedule[o.id] || (o.cur && { press: o.cur.press, start: o.cur.start }); if (!a) { ok = false; break; } prev[o.id] = a; }
          if (ok) {
            const ev = evaluate(site, hh.hours, plannable(orders), prev, init, r.margin ?? r.res.margin);
            const pr = { schedule: prev, plan: ev.plan, sim: ev.sim, obj: ev.obj, margin: r.margin ?? r.res.margin };
            const pv = validate(site, hh.hours, plannable(orders), pr, init);
            if (pv.ok && (!r.ok || ev.obj <= r.res.obj + (cfg.hysteresis_aed ?? 30))) chosen = { ok: true, res: pr, validation: pv, margin: pr.margin };
          }
        }
        validation = chosen.validation;
        if (chosen.res && chosen.res.schedule) {
          st.schedule = chosen.res.schedule; st.hours = chosen.res.plan.hours; st.margin = chosen.margin; st.safeMode = false;
          st.est = { cost: Math.round(chosen.res.sim.cost), peak: Math.round(chosen.res.sim.peak) }; replanned = true;
          if (init.drCap) {
            const over = chosen.res.sim.per.filter(p => init.drCap[p.h] != null && p.gmax > init.drCap[p.h] + 1);
            const key = over.map(p => p.h).join(',');
            if (over.length && st.drWarned !== key) { st.drWarned = key; alerts.push(`ESCALATION ${status.now}: demand-response cap cannot be fully met (predicted max ${Math.max(...over.map(p => p.gmax))} kW in ${over.map(p => hhmm(p.h)).join(',')}) – best effort, hard rules kept`); }
          }
        } else {
          const r2 = safePlan(site, orders, init); st.schedule = Object.assign({}, st.schedule, r2.schedule); st.hours = r2.plan.hours; st.safeMode = true; replanned = true;
        }
        const infeasNew = ((chosen.res && chosen.res.infeasible) || []).filter(id => !(st.escalated || []).includes(id));
        if (infeasNew.length) {
          st.escalated = (st.escalated || []).concat(infeasNew);
          events.push({ type: 'order_infeasible', orders: infeasNew });
          alerts.push(`ESCALATION ${status.now}: order(s) ${infeasNew.join(',')} cannot meet due time with any press – human decision needed; all other orders planned normally`);
          diary(st, status.now, `order(s) ${infeasNew.join(',')} impossible before due time`, 'escalated to a human, kept planning the rest', 'no press can finish it in time; breaking other rules would not help');
        }
        if (!chosen.ok) {
          const late = [];
          events.push({ type: late.length ? 'order_infeasible' : 'validation_failed', violations: ((chosen.validation || {}).violations || []).slice(0, 4), orders: late });
          alerts.push(`${late.length ? 'ESCALATION' : 'ALERT'} ${status.now}: ${late.length ? 'order(s) ' + late.join(',') + ' cannot meet due time – human decision needed' : 'plan failed validation – ' + ((chosen.validation || {}).violations || []).slice(0, 2).join('; ')}`);
        }
        const ev = events.filter(e => e.type !== 'safety_override');
        const moved = scheduleDiff(before, st.schedule);
        if (ev.length || moved.length || minute === 0) {
          const saw = ev.length ? ev.map(e => `${e.type}${e.chiller ? ' ' + e.chiller : ''}${e.order ? ' ' + e.order : ''}${e.dT != null ? ' ' + e.dT + '°C' : ''}${e.window ? ' ' + e.window + ' ≤' + e.cap_kw + 'kW' : ''}`).join(', ')
            : `hourly check: floor ${status.floor_temp_c} °C, ice ${Math.round(status.ice_kwhth)} kWh, forecast bias ${hh.bias.dT} °C`;
          const p = st.hours[hour];
          diary(st, status.now, saw, (moved.length ? 'moved ' + moved.join(', ') + '; ' : (ev.length ? 'kept press schedule; ' : '')) + `this hour: ${p ? p.run.length + ' chiller(s), ' + p.mode + (p.rate ? ' ' + p.rate + ' kW' : '') : '-'}`,
            explainHour(site, p, hh.hours, tripped) + (st.safeMode ? '; SAFE MODE' : `; margin ${Math.round((st.margin || 0) * 100)}%`) + (init.drCap && init.drCap[hour] != null ? `; DR cap ${init.drCap[hour]} kW` : ''));
        }
      }
    }
    // ---- 15-minute safety layer on the live state (never exceeds the standby rule)
    const desired = JSON.parse(JSON.stringify(st.hours[hour] || { run: [], mode: 'idle', rate: 0, np: 0 }));
    const avail = site.chillers.filter(x => !tripped.includes(x.id)), maxRun = Math.max(avail.length - 1, 0);
    desired.run = desired.run.filter(x => avail.some(a => a.id === x)).slice(0, maxRun);
    const running = Array.isArray(c.status && c.status.presses_running) ? c.status.presses_running.length : 0;
    const np = Math.max(pressCount(st.schedule || {}, plannable(orders), hour), running), w = hh ? hh.hours[hour] : null;
    const T = w ? w.T + 0.5 : 48, ghi = w ? w.ghi : 900;
    const load = coolLoad(site, T, ghi, np) * ((status.floor_temp_c > 25 || status.floorSuspect) ? 1.1 : 1.03);
    const cap1 = avail.length ? avail[0].cap : 0;
    const supply = d => d.run.length * cap1 - (d.mode === 'charge' ? d.rate : 0) + (d.mode === 'discharge' ? Math.min(d.rate, site.dischargeMax, status.ice_kwhth * 4, load) : 0);
    if (supply(desired) < load) {
      if (desired.mode === 'charge') { desired.mode = 'idle'; desired.rate = 0; }
      if (supply(desired) < load && status.ice_kwhth > 300) { desired.mode = 'discharge'; desired.rate = site.dischargeMax; }
      while (supply(desired) < load && desired.run.length < maxRun) desired.run.push(avail.find(x => !desired.run.includes(x.id)).id);
      const so = { load: Math.round(load), supply: Math.round(supply(desired)), run: desired.run, mode: desired.mode };
      events.push({ type: 'safety_override', ...so });
      diary(st, status.now, `cooling for next 15 min looked short (need ~${so.load} kW)`, `safety override: ${so.run.length} chiller(s), ${so.mode}`, 'protect the 27 °C limit; backup chiller still kept');
    }
    const aiEvents = events.filter(e => AI_EVENTS.includes(e.type));
    const ai_needed = !!cfg.use_ai && aiEvents.length > 0 && (st.aiCalls || 0) < (cfg.max_ai_calls ?? 6);
    const escalate = alerts.some(a => /^ESCALATION/.test(a));
    st.events.push(...events.map(e => ({ t: status.now, ...e }))); st.alerts.push(...alerts);
    return { finished: false, now: status.now, hour, minute, replanned, events, alerts, validation, desired, ai_needed, escalate,
      ai_context: ai_needed ? aiContext(status, aiEvents, hh, st, hour) : null, state: st };
  }

  // only structured, sanitised fields ever reach the LLM (prompt-injection guard)
  function aiContext(status, aiEvents, hh, st, hour) {
    return {
      now: clean(status.now, 19),
      events: aiEvents.map(e => ({ type: clean(e.type, 24), chiller: e.chiller ? clean(e.chiller, 6) : undefined, order: e.order ? clean(e.order, 24) : undefined,
        dT: typeof e.dT === 'number' ? e.dT : undefined, window: e.window ? clean(e.window, 12) : undefined, cap_kw: typeof e.cap_kw === 'number' ? e.cap_kw : undefined,
        problems: e.problems ? 'order data failed validation' : undefined, violations: Array.isArray(e.violations) ? e.violations.length : undefined })),
      plant: { floor_c: status.floor_temp_c, floor_sensor_suspect: !!status.floorSuspect, ice_kwh: Math.round(status.ice_kwhth), chillers: status.chillers },
      forecast_bias_c: hh ? hh.bias.dT : null, plan_margin: st.margin, safe_mode: !!st.safeMode,
      next_hours: (st.hours || []).slice(hour, hour + 6).filter(Boolean).map(p => ({ h: p.h, chillers: p.run.length, mode: p.mode, rate: p.rate, presses: p.np }))
    };
  }

  // fallback desired state when anything unexpected happens in a tick
  function safeDesired(site, st, rawStatus) {
    const ch = (rawStatus && rawStatus.chillers) || {};
    const avail = site.chillers.filter(c => ch[c.id] === 'on' || ch[c.id] === 'off');
    const ice = Number(rawStatus && rawStatus.ice_kwhth);
    return { run: avail.slice(0, Math.max(avail.length - 1, 0)).map(c => c.id), mode: isFinite(ice) && ice > 200 ? 'discharge' : 'idle', rate: isFinite(ice) && ice > 200 ? site.dischargeMax : 0, np: 0, safe: true };
  }

  // AI decision -> may only make the plan MORE conservative; strict whitelist; validator stays the gate
  function applyAiDecision(c, decision) {
    const st = c.state; let d = null;
    try { d = typeof decision === 'object' && decision ? decision : JSON.parse(String(decision).replace(/```json|```/g, '').trim()); } catch (e) { return { applied: false, reason: 'AI output not JSON – deterministic plan kept' }; }
    const strategy = ['accept', 'conservative', 'escalate'].includes(d.strategy) ? d.strategy : null;
    if (!strategy) return { applied: false, reason: 'AI output outside allowed choices – ignored' };
    const m = Math.min(0.6, Math.max(0.08, Number(d.min_margin) || 0)), reason = clean(d.reason, 200);
    st.aiCalls = (st.aiCalls || 0) + 1; st.aiDecisions.push({ t: clean(c.status.now, 19), strategy, min_margin: m, reason });
    diary(st, c.status.now, 'AI asked about unusual event', `AI chose ${strategy}${strategy === 'conservative' ? ' (margin ' + Math.round(m * 100) + '%)' : ''}`, reason || '-');
    if (strategy === 'escalate') st.alerts.push(`ESCALATION ${c.status.now}: AI requests human review – ${reason}`);
    if (strategy !== 'conservative' || !(m > (st.margin || 0))) return { applied: false, decision: { strategy, min_margin: m, reason }, escalate: strategy === 'escalate' };
    const nowMs = parseTs(c.status.now), hh = buildHours(c.site, c.weatherRows, c.solarRows, nowMs);
    const hour = Math.floor((nowMs - st.dayStart) / H), minute = Math.round(((nowMs - st.dayStart) % H) / 60000);
    const { status } = sanitizeStatus(c.status, Object.assign({}, st), c.site);
    const init = { fromHour: hour, pressFrom: minute === 0 ? hour : hour + 1, ice: status.ice_kwhth, floor: status.floor_temp_c, tripped: st.tripped, drCap: drCapArray(st.drActive) };
    const r = planAndValidate(c.site, hh.hours, markRejected(normOrders(c.orderRows, st.dayStart, c.site), st), init, m);
    if (!r.ok) return { applied: false, decision: { strategy, min_margin: m, reason }, reason: 'conservative plan failed validation' };
    st.minMargin = m; st.schedule = r.res.schedule; st.hours = r.res.plan.hours; st.margin = r.margin;
    diary(st, c.status.now, 'AI advice', `re-planned with ${Math.round(r.margin * 100)}% margin (first standard safety step at or above the AI's ${Math.round(m * 100)}%) and passed the rule check`, 'extra cooling headroom while the situation is unusual');
    return { applied: true, decision: { strategy, min_margin: m, reason }, desired: r.res.plan.hours[hour] };
  }

  // ----------------------------------------- desired state -> tool commands
  function buildCommands(status, orderRows, schedule, desired, dayStart, st, site) {
    const cmds = [], nowMs = parseTs(status.now);
    const orders = plannable(markRejected(normOrders(orderRows, dayStart, site), st));
    const chillerIds = site ? site.chillers.map(c => c.id) : Object.keys(status.chillers || {});
    const occ = {}; for (const o of orders) if (o.cur) occ[o.id] = { ...o.cur, dur: o.dur };
    const moves = orders.filter(o => schedule && schedule[o.id] && !(o.cur && o.cur.start * H + dayStart <= nowMs) && !(o.cur && o.cur.press === schedule[o.id].press && o.cur.start === schedule[o.id].start));
    for (let pass = 0; pass < 4 && moves.length; pass++) {
      for (let i = 0; i < moves.length; i++) {
        const o = moves[i], a = schedule[o.id];
        if (a.start * H + dayStart < Math.floor(nowMs / H) * H) { moves.splice(i--, 1); continue; }
        if (Object.entries(occ).some(([id, x]) => id !== o.id && overlaps(a, o.dur, x, x.dur))) continue;
        cmds.push({ tool: 'schedule_batch', args: { order_id: o.id, press_id: a.press, start_time: fmtTs(dayStart + a.start * H) } });
        occ[o.id] = { ...a, dur: o.dur }; moves.splice(i--, 1);
      }
    }
    if (desired) {
      const run = (desired.run || []).filter(id => chillerIds.includes(id));
      const chs = status.chillers || {};
      for (const id of chillerIds) {
        const s = chs[id];
        if (s && s !== 'on' && s !== 'off' && !st.offSent.includes(id)) { cmds.push({ tool: 'set_chiller_state', args: { chiller_id: id, state: 'off' } }); st.offSent.push(id); }
        if ((s === 'on' || s === 'off') && st.offSent.includes(id)) st.offSent = st.offSent.filter(x => x !== id);
        if (s === 'on' && !run.includes(id)) cmds.push({ tool: 'set_chiller_state', args: { chiller_id: id, state: 'off' } });
      }
      for (const id of run) if (chs[id] === 'off') cmds.push({ tool: 'set_chiller_state', args: { chiller_id: id, state: 'on' } });
      const mode = ['charge', 'discharge', 'idle'].includes(desired.mode) ? desired.mode : 'idle';
      const lim = site ? (mode === 'charge' ? site.chargeMax : site.dischargeMax) : 1800;
      const rate = mode === 'idle' ? 0 : Math.max(0, Math.min(lim, Math.round(Number(desired.rate) || 0)));
      if (status.storage_mode !== mode || Math.abs((status.storage_rate_kwth || 0) - rate) > 1) cmds.push({ tool: 'set_storage_mode', args: { mode, rate_kwth: rate } });
    }
    if (!cmds.length) cmds.push({ tool: 'get_current_time', args: {}, noop: true });
    return cmds;
  }

  // ------------------------------------------------------------- daily KPIs
  function dailyKpis(site, meters, orderRows, baselineRow, state) {
    const m = (Array.isArray(meters) ? meters : []).filter(r => r && isFinite(r.grid_kw) && r.grid_kw >= 0 && isFinite(r.cost_aed));
    const kwh = m.reduce((s, r) => s + r.grid_kw * 0.25, 0), cost = m.reduce((s, r) => s + r.cost_aed, 0);
    const peak = m.reduce((s, r) => Math.max(s, r.grid_kw), 0);
    const co2f = site.co2KgPerKwh ?? 0.4, dpk = site.demandAedPerKwMonth / site.demandDays;
    const comfort = m.filter(r => r.floor_c < site.comfort[0] || r.floor_c > site.comfort[1]).length * 15;
    const late = (Array.isArray(orderRows) ? orderRows : []).filter(o => !o.scheduled_start || parseTs(o.scheduled_start) + o.duration_h * H > parseTs(o.due_by)).map(o => clean(o.order_id, 24));
    const b = baselineRow || {}, bc = Number(b.baseline_cost_aed) || null;
    const bDemand = (Number(b.baseline_peak_kw) || 0) * dpk, demand = peak * dpk;
    const pct = (x, y) => y ? +(100 * (1 - x / y)).toFixed(1) : null;
    // demand-response compliance
    let dr = null;
    if (state.drActive && state.drActive.length) {
      dr = state.drActive.map(e => {
        const rows = m.filter(r => { const hr = (parseTs(r.timestamp) - state.dayStart) / H; return hr >= e.start && hr < e.end; });
        const mx = rows.reduce((s, r) => Math.max(s, r.grid_kw), 0), over = rows.reduce((s, r) => s + Math.max(0, r.grid_kw - e.cap) * 0.25, 0);
        return `${hhmm(e.start)}-${hhmm(e.end)} cap ${e.cap} kW: max ${Math.round(mx)} kW, ${over < 1 ? 'MET' : 'missed by ' + Math.round(over) + ' kWh'}`;
      }).join(' | ');
    }
    return {
      day: b.day || state.day, date: String(b.date || '').slice(0, 10), day_type: b.day_type || '',
      grid_kwh: Math.round(kwh), energy_cost_aed: Math.round(cost), peak_kw: Math.round(peak), demand_charge_aed: Math.round(demand),
      total_cost_aed: Math.round(cost + demand), co2_kg: Math.round(kwh * co2f),
      baseline_grid_kwh: b.baseline_grid_kwh ?? null, baseline_energy_cost_aed: bc, baseline_peak_kw: b.baseline_peak_kw ?? null,
      baseline_demand_charge_aed: bc ? Math.round(bDemand) : null, baseline_total_cost_aed: bc ? Math.round(bc + bDemand) : null, baseline_co2_kg: b.baseline_co2_kg ?? null,
      energy_saving_aed: bc ? Math.round(bc - cost) : null, energy_saving_pct: pct(cost, bc),
      total_saving_aed: bc ? Math.round(bc + bDemand - cost - demand) : null, total_saving_pct: bc ? pct(cost + demand, bc + bDemand) : null,
      peak_reduction_kw: b.baseline_peak_kw != null ? Math.round(b.baseline_peak_kw - peak) : null, kwh_saving: b.baseline_grid_kwh != null ? Math.round(b.baseline_grid_kwh - kwh) : null,
      co2_saving_kg: b.baseline_co2_kg != null ? Math.round(b.baseline_co2_kg - kwh * co2f) : null,
      comfort_violation_min: comfort, floor_max_c: m.length ? Math.max(...m.map(r => r.floor_c)) : null, late_orders: late.length, late_order_ids: late.join(','),
      standby_alerts: (state.alerts || []).filter(a => /no chiller on standby/.test(a)).length,
      chiller_trips: (state.events || []).filter(e => e.type === 'chiller_trip').length,
      sensor_faults: (state.events || []).filter(e => e.type === 'sensor_fault').length,
      escalations: (state.alerts || []).filter(a => /^ESCALATION/.test(a)).length,
      replans: state.replans || 0, safety_overrides: (state.events || []).filter(e => e.type === 'safety_override').length, ai_calls: state.aiCalls || 0,
      demand_response: dr || '', what_if_choice: state.whatIfChoice || '', safe_mode_used: !!state.safeModeUsed,
      alerts: (state.alerts || []).join(' | ').slice(0, 4000)
    };
  }

  // ======================================================================
  // Crash-proof entry points used by the n8n Code nodes and the harness
  // ======================================================================
  // Stage B: forecast & data preparation (never throws if defaultSite is given)
  function prepareDay(x) {
    const cfg = x.cfg || {}, alerts = [];
    let site;
    try { site = buildSite(x.siteRows, x.chillerRows, x.tariffRows, x.baselineRow ? [x.baselineRow] : []); }
    catch (e) {
      if (!x.defaultSite) throw e;
      site = JSON.parse(JSON.stringify(x.defaultSite)); if (Array.isArray(x.tariffRows) && x.tariffRows.length) site.tariffRows = x.tariffRows;
      alerts.push('WARN site data unreadable (' + clean(e.message, 80) + ') – using constants captured from the workbook at build time');
    }
    site.peakCapKw = cfg.peak_cap_kw ?? 4300; site.demandWeight = cfg.demand_weight ?? 0;
    const raw = x.status || {}, nowMs = isFinite(parseTs(raw.now)) ? parseTs(raw.now) : Date.now();
    const st = { day: cfg.day, tripped: [], known: [], events: [], alerts, aiDecisions: [], offSent: [], replans: 0, aiCalls: 0, diary: [], lastGood: null, rejected: [], escalated: [] };
    const { status, faults } = sanitizeStatus(Object.assign({ now: fmtTs(nowMs) }, raw), st, site);
    if (faults.length) alerts.push('WARN start: sensor fault – ' + faults.join('; '));
    let hh = null;
    try { hh = buildHours(site, x.weatherRows, x.solarRows, nowMs); } catch (e) { alerts.push('WARN start: forecast unusable – ' + clean(e.message, 80)); }
    st.dayStart = hh ? hh.dayStart : Math.floor(nowMs / (24 * H)) * 24 * H;
    if (Array.isArray(x.orderRows)) st.lastOrderRows = x.orderRows;
    const orders = normOrders(x.orderRows, st.dayStart, site);
    st.known = orders.map(o => o.id);
    for (const o of orders) if (o.invalid || o.suspicious) alerts.push(`ESCALATION start: order ${o.id} needs a human – ${o.problems.join('; ')}`);
    st.drAll = parseDr(cfg.dr_events); st.drActive = st.drAll.filter(e => e.announce <= 0);
    const tripped = Object.entries(status.chillers).filter(([, v]) => v !== 'on' && v !== 'off').map(([k]) => k);
    st.tripped = tripped;
    st.init = { fromHour: 0, pressFrom: 0, ice: status.ice_kwhth, floor: status.floor_temp_c, tripped, drCap: drCapArray(st.drActive) };
    st.warnings = hh ? hh.warnings : [];
    return { site, state: st, hours: hh ? hh.hours : null, orders, status };
  }
  // Stage C: optimisation – the what-if options (each already re-planned and validated)
  function planOptions(site, st, hours, orders, cfg) {
    let options = [];
    if (hours) { try { options = whatIf(site, hours, orders, st.init, cfg || {}); } catch (e) { st.alerts.push('WARN what-if failed – ' + clean(e.message, 80)); } }
    st.whatIf = options.map(o => ({ key: o.key, label: o.label, ok: o.ok, schedule: o.schedule, hours: o.hours, margin: o.margin }));
    st.whatIfTable = whatIfText(options);
    return options.map(o => { const { schedule, hours: hs, ...rest } = o; return rest; });
  }
  // Stage D: independent hard-constraint re-check of every option before anything is executed
  function revalidateOptions(site, st, hours, orders) {
    const out = [];
    for (const o of st.whatIf || []) {
      if (o.key === 'D' || !o.schedule || !hours) { out.push({ key: o.key, ok: o.ok, violations: [] }); continue; }
      const v = validate(site, hours, plannable(orders), { schedule: o.schedule, plan: { hours: o.hours }, infeasible: plannable(orders).filter(x => !o.schedule[x.id]).map(x => x.id) }, st.init);
      o.ok = o.ok && v.ok; out.push({ key: o.key, ok: o.ok, violations: v.violations });
    }
    return out;
  }
  function whatIfHtml(st) {
    const rows = String(st.whatIfTable || '').split('\n').map(l => l.split(' | '));
    if (!rows.length || rows[0].length < 2) return '<p>No options could be computed – the agent will run in safe mode.</p>';
    const esc = v => String(v).replace(/[<>&]/g, '');
    return '<table border="1" cellpadding="4" style="border-collapse:collapse;font-size:13px">' + rows.map((r, i) => '<tr>' + r.map(c => i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`).join('') + '</tr>').join('') + '</table>' +
      '<p>A = recommended balance of cost and safety · B = cheapest energy, higher demand charge · C = extra cooling margin · D = do-nothing reference (not selectable). Every option shown as valid passed the hard-rule check.</p>';
  }
  function startDay(x) {
    const p = prepareDay(x);
    const options = planOptions(p.site, p.state, p.hours, p.orders, x.cfg);
    revalidateOptions(p.site, p.state, p.hours, p.orders);
    return Object.assign(p, { options, whatIfTable: p.state.whatIfTable });
  }

  // commit the operator's (or default) choice; falls back to a valid option, then to safe mode
  function commitChoice(site, st, key, orders) {
    const opts = (st.whatIf || []).filter(o => o.key !== 'D');
    let pick = opts.find(o => o.key === key && o.ok) || opts.find(o => o.key === 'A' && o.ok) || opts.find(o => o.ok);
    if (pick) { st.schedule = pick.schedule; st.hours = pick.hours; st.margin = pick.margin; st.safeMode = false; st.whatIfChoice = pick.key + ' ' + pick.label; }
    else { const r = safePlan(site, orders, st.init); st.schedule = r.schedule; st.hours = r.plan.hours; st.margin = null; st.safeMode = true; st.safeModeUsed = true; st.whatIfChoice = 'safe mode (no valid option)'; st.alerts.push('ALERT start: no valid plan – safe mode'); }
    if (key && pick && pick.key !== key) st.alerts.push(`WARN operator choice ${clean(key, 4)} not valid – used ${pick.key}`);
    const p = st.hours[0];
    diary(st, fmtTs(st.dayStart), `day start: ${orders.length} orders, ice ${Math.round(st.init.ice)} kWh` + (st.drActive.length ? `, DR request ${st.drActive.map(e => hhmm(e.start) + '-' + hhmm(e.end) + ' ≤' + e.cap + 'kW').join(', ')}` : ''),
      `committed plan ${st.whatIfChoice}; presses: ${Object.entries(st.schedule).map(([o, a]) => o + ' on ' + a.press + ' at ' + hhmm(a.start)).join(', ')}`,
      'chosen from the what-if options; it passed the rule check (20–27 °C with +1 °C stress, due times, backup chiller)');
    return st.whatIfChoice;
  }

  function tick(x) {
    const st = x.state;
    try {
      let orderRows = x.orderRows;
      if (Array.isArray(orderRows)) st.lastOrderRows = orderRows;
      else { orderRows = st.lastOrderRows || []; st.alerts.push(`WARN ${x.status && x.status.now}: order service unavailable – last known orders used`); }
      const out = monitorTick({ site: x.site, cfg: x.cfg || {}, state: st, status: x.status, orderRows, weatherRows: x.weatherRows, solarRows: x.solarRows });
      if (out.replanned) st.replans++;
      return out;
    } catch (e) {
      const d = safeDesired(x.site, st, x.status);
      st.safeModeUsed = true; st.alerts.push('ALERT tick error (' + clean(e.message, 80) + ') – safe settings applied');
      diary(st, (x.status && x.status.now) || '?', 'unexpected data / internal error', `safe settings: ${d.run.length} chiller(s), ${d.mode}`, 'never stop the plant without cooling; backup kept');
      return { finished: false, now: x.status && x.status.now, desired: d, events: [{ type: 'error' }], alerts: [], ai_needed: false, escalate: true, error: clean(e.message, 120) };
    }
  }
  const diaryText = st => (st.diary || []).map(d => `${d.t} | SAW: ${d.saw} | DID: ${d.decided} | WHY: ${d.why}`).join('\n');

  return { H, parseTs, fmtTs, buildSite, buildHours, normOrders, plannable, simulate, evaluate, optimize, validate, planAndValidate, summarizePlan, coolLoad, cop, pressCount,
    monitorTick, applyAiDecision, buildCommands, dailyKpis, sanitizeStatus, safePlan, safeDesired, parseDr, drCapArray, whatIf, whatIfText, diary, diaryText, explainHour, clean, startDay, prepareDay, planOptions, revalidateOptions, whatIfHtml, commitChoice, tick, noteToolErrors, markRejected };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
