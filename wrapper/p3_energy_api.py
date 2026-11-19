"""
Problem 3 - Peak-Hour Energy Agent: mock factory energy simulator.

    from p3_energy_api import EnergyAPI
    api = EnergyAPI("practice_02", data_xlsx="data/P3_Energy_Agent_Data.xlsx")
Hidden days: EnergyAPI("hidden_01", data_xlsx=..., key_xlsx="P3_Energy_Agent_ANSWER_KEY.xlsx")

The day runs 00:00-24:00 in 15-minute steps using the ACTUAL weather (the agent sees
the forecast, plus actual readings for hours already passed). Physics follows
Site_Parameters: cooling load = 520 + 46 x (outdoor - 24) + 0.25 x solar + 380 per
running press; chiller power = cooling / COP(curve) + 30 kW pumps; unmet cooling
heats the floor ~0.6 C per hour per 100 kW.
Violations: floor outside 20-27 C (minutes counted), no chiller left on standby,
an order finishing after its due time.
"""
import numpy as np
import pandas as pd
from common import MockAPI, ClockMixin, tool, S, APIError, sheets

DT = pd.Timedelta(minutes=15)


def cop(rated, t, plr):
    plr = min(max(plr, 0.25), 1.0)
    return rated * (1 - 0.018 * (t - 35)) * (1 - 0.35 * (plr - 0.75) ** 2)


class EnergyAPI(ClockMixin, MockAPI):
    PROBLEM = "P3"

    def __init__(self, scenario, data_xlsx, key_xlsx=None, log_path=None):
        d = sheets(data_xlsx, "Chillers", "Tariff")
        if scenario.startswith("hidden"):
            k = sheets(key_xlsx, "Hidden_Days", "Hidden_Forecast", "Hidden_Actual", "Hidden_Orders", "Hidden_Events", "Baselines_All")
            D, F, A, O, E, B = (k[x] for x in ("Hidden_Days", "Hidden_Forecast", "Hidden_Actual", "Hidden_Orders", "Hidden_Events", "Baselines_All"))
        else:
            k = sheets(data_xlsx, "Practice_Days", "Practice_Forecast", "Practice_Actual", "Practice_Orders", "Practice_Events", "Practice_Baseline")
            D, F, A, O, E, B = (k[x] for x in ("Practice_Days", "Practice_Forecast", "Practice_Actual", "Practice_Orders", "Practice_Events", "Practice_Baseline"))
        f = lambda x: x[x.day == scenario].reset_index(drop=True)
        D, F, A, O, E, B = map(f, (D, F, A, O, E, B))
        if D.empty:
            raise APIError(f"unknown scenario {scenario}")
        day = pd.Timestamp(D.date.iloc[0])
        super().__init__(scenario, log_path, day, day + pd.Timedelta(days=1))
        for x in (F, A):
            x["timestamp"] = pd.to_datetime(x.timestamp)
        for c in ("earliest_start", "due_by"):
            O[c] = pd.to_datetime(O[c])
        self.F, self.A, self.O, self.E, self.B = F.set_index("timestamp"), A.set_index("timestamp"), O.set_index("order_id"), E, B
        self.chillers = d["Chillers"].set_index("chiller_id"); self.tariff = d["Tariff"]
        self.on = {c: False for c in self.chillers.index}; self.on["CH-1"] = True; self.on["CH-2"] = True
        self.mode, self.rate = "idle", 0.0
        self.ice = float(D.ice_tank_start_kwhth.iloc[0]); self.floor = 24.0
        self.batches = {}   # order -> (press, start)
        self.trip = None
        for r in E.itertuples():
            if r.event == "chiller_trip":
                self.trip = (r.target, pd.Timestamp(r.time), day + pd.Timedelta(hours=19))
        self.meter = []; self.comfort_min = 0; self.standby_viol_min = 0

    # ------------------------------------------------------------ simulation
    def _rate(self, t):
        summer = t.month in (5, 6, 7, 8, 9, 10); h = t.hour
        if summer:
            return 0.62 if 12 <= h < 18 else 0.23 if (h >= 23 or h < 7) else 0.38
        return 0.22 if (h >= 23 or h < 7) else 0.30

    def _tripped(self, c, t):
        return self.trip is not None and self.trip[0] == c and self.trip[1] <= t < self.trip[2]

    def _presses(self, t):
        return [(o, p) for o, (p, s) in self.batches.items() if s <= t < s + pd.Timedelta(hours=int(self.O.loc[o, "duration_h"]))]

    def _step(self, until):
        t = self.now
        while t < until:
            hr = t.floor("h"); w = self.A.loc[hr]
            T, ghi, pv = float(w.actual_temp_c), float(w.actual_ghi_w_m2), float(w.actual_pv_kw)
            npress = len(self._presses(t))
            load = 520 + 46 * (T - 24) + 0.25 * ghi + 380 * npress
            running = [c for c in self.chillers.index if self.on[c] and not self._tripped(c, t)]
            avail_off = [c for c in self.chillers.index if not self.on[c] and not self._tripped(c, t)]
            if not avail_off:
                self.standby_viol_min += 15
                if self.standby_viol_min == 15 or self.standby_viol_min % 60 == 0:
                    self._violation("no_chiller_on_standby", at=t)
            cap = sum(self.chillers.loc[c, "capacity_kwth"] for c in running)
            charge = discharge = 0.0
            if self.mode == "charge":
                ice_cap = sum(self.chillers.loc[c, "capacity_kwth"] for c in running if c in ("CH-1", "CH-2"))
                charge = min(self.rate, 1500, ice_cap, (9000 - self.ice) / 0.25)
            elif self.mode == "discharge":
                discharge = min(self.rate, 1800, self.ice / 0.25, load)
            to_floor = min(max(cap - charge, 0), max(load - discharge, 0))
            unmet = load - discharge - to_floor
            elec = 0.0
            if running:
                plr = (to_floor + charge) / cap if cap else 0
                rc = float(np.mean([self.chillers.loc[c, "rated_cop"] for c in running]))
                elec = to_floor / cop(rc, T, plr) + charge / (cop(rc, T, plr) * 0.72) + 30 * len(running)
            self.ice = min(9000, max(0.0, self.ice * (1 - 0.005 / 4) + (charge - discharge) * 0.25))
            if unmet > 1:
                self.floor += 0.6 * unmet / 100 * 0.25
            else:
                self.floor = max(24.0, self.floor - 0.25) if self.floor > 24 else self.floor
            if not 20 <= self.floor <= 27:
                self.comfort_min += 15
            total = elec + 1100 * npress + 650
            grid = max(total - pv, 0)
            self.meter.append(dict(timestamp=t, outdoor_c=T, cooling_load_kwth=round(load), chillers_running=len(running), chiller_kw=round(elec),
                                   presses_running=npress, solar_kw=round(pv), grid_kw=round(grid), ice_kwhth=round(self.ice), floor_c=round(self.floor, 2),
                                   tariff=self._rate(t), cost_aed=round(grid * self._rate(t) * 0.25, 2)))
            t = t + DT

    # ------------------------------------------------------------ tools
    @tool("Day-ahead hourly weather forecast, plus actual readings for hours already passed.")
    def get_weather_forecast(self):
        out = self.F[["forecast_temp_c", "forecast_ghi_w_m2"]].copy()
        act = self.A[self.A.index < self.now.floor("h")][["actual_temp_c"]]
        out = out.join(act); out.index.name = "timestamp"
        return out.reset_index()

    @tool("Time-of-use tariff (AED per kWh) and demand charge.")
    def get_tariff(self):
        return self.tariff

    @tool("Day-ahead hourly solar PV forecast (kW), plus actual output for hours already passed.")
    def get_solar_forecast(self):
        out = self.F[["forecast_pv_kw"]].join(self.A[self.A.index < self.now.floor("h")][["actual_pv_kw"]]); out.index.name = "timestamp"
        return out.reset_index()

    @tool("Production orders known so far, with time windows, allowed presses and current schedule. Rush orders appear when released.")
    def get_production_orders(self):
        o = self.O[(self.O.priority != "rush") | (self.O.earliest_start <= self.now)].reset_index()
        o["scheduled_press"] = o.order_id.map(lambda x: self.batches.get(x, (None, None))[0])
        o["scheduled_start"] = o.order_id.map(lambda x: self.batches.get(x, (None, None))[1])
        return o.drop(columns="day")

    @tool("Turn a chiller on or off. At least one available chiller must stay off as standby.",
          dict(chiller_id=S("string", "CH-1..CH-4"), state=S("string", enum=["on", "off"])), ["chiller_id", "state"], mutating=True)
    def set_chiller_state(self, chiller_id, state):
        if chiller_id not in self.chillers.index or state not in ("on", "off"):
            raise APIError("unknown chiller or state")
        if state == "on" and self._tripped(chiller_id, self.now):
            raise APIError(f"{chiller_id} is tripped and cannot start")
        self.on[chiller_id] = state == "on"
        return dict(ok=True, running=[c for c, v in self.on.items() if v])

    @tool("Ice tank mode: 'charge' (make ice with CH-1/CH-2, max 1,500 kW), 'discharge' (melt ice to cool the floor, max 1,800 kW) or 'idle'.",
          dict(mode=S("string", enum=["charge", "discharge", "idle"]), rate_kwth=S("number", "Thermal rate in kW")), ["mode"], mutating=True)
    def set_storage_mode(self, mode, rate_kwth=0):
        if mode not in ("charge", "discharge", "idle"):
            raise APIError("mode must be charge, discharge or idle")
        self.mode, self.rate = mode, float(rate_kwth or (1500 if mode == "charge" else 1800 if mode == "discharge" else 0))
        return dict(ok=True, mode=mode, rate_kwth=self.rate, ice_kwhth=round(self.ice))

    @tool("Schedule (or move) a production order on a press. It must start at or after its earliest start, on an allowed press that is free, and should finish by its due time.",
          dict(order_id=S("string"), press_id=S("string", "EP-1, EP-2 or EP-3"), start_time=S("string", "ISO time, on the hour")), ["order_id", "press_id", "start_time"], mutating=True)
    def schedule_batch(self, order_id, press_id, start_time):
        if order_id not in self.O.index:
            raise APIError("unknown order")
        o = self.O.loc[order_id]; st = pd.Timestamp(start_time)
        if o.priority == "rush" and o.earliest_start > self.now:
            raise APIError("unknown order")
        if press_id not in o.allowed_presses.split(","):
            raise APIError(f"{order_id} may only run on {o.allowed_presses}")
        if st < o.earliest_start:
            raise APIError(f"cannot start before {o.earliest_start}")
        if order_id in self.batches and self.batches[order_id][1] <= self.now:
            raise APIError("order already started")
        if st < self.now.floor("h"):
            raise APIError("start time is in the past")
        en = st + pd.Timedelta(hours=int(o.duration_h))
        for x, (p, s) in self.batches.items():
            if x != order_id and p == press_id and s < en and st < s + pd.Timedelta(hours=int(self.O.loc[x, "duration_h"])):
                raise APIError(f"{press_id} is busy with {x}")
        self.batches[order_id] = (press_id, st)
        return dict(ok=True, finishes=en, due_by=o.due_by, on_time=en <= o.due_by)

    @tool("Meter readings so far (15-minute rows): load, chillers, presses, solar, grid import, ice level, floor temperature and cost.",
          dict(last_hours=S("integer", "How many past hours to return (default 4)")))
    def read_meters(self, last_hours=4):
        m = pd.DataFrame(self.meter)
        return m[m.timestamp >= self.now - pd.Timedelta(hours=int(last_hours))] if len(m) else []

    @tool("Current plant status: chillers (on/off/tripped), ice level, storage mode, floor temperature, presses running.")
    def get_plant_status(self):
        return dict(now=self.now, chillers={c: ("tripped" if self._tripped(c, self.now) else "on" if self.on[c] else "off") for c in self.chillers.index},
                    ice_kwhth=round(self.ice), ice_capacity_kwhth=9000, storage_mode=self.mode, storage_rate_kwth=self.rate, floor_temp_c=round(self.floor, 2),
                    presses_running=[dict(order_id=o, press=p) for o, p in self._presses(self.now)])

    def run_summary(self):
        m = pd.DataFrame(self.meter)
        late = []
        for o, r in self.O.iterrows():
            if o not in self.batches:
                late.append(o)
            elif self.batches[o][1] + pd.Timedelta(hours=int(r.duration_h)) > r.due_by:
                late.append(o)
        if self.now >= self.end:
            for o in late:
                if not any(v.get("order_id") == o for v in self.violations):
                    self._violation("order_late_or_not_run", order_id=o)
        base = float(self.B.baseline_cost_aed.iloc[0]) if len(self.B) else None
        cost = round(float(m.cost_aed.sum()), 0) if len(m) else None
        return dict(super().run_summary(), cost_aed=cost, baseline_cost_aed=base, saving_pct=round(100 * (1 - cost / base), 1) if (cost and base) else None,
                    grid_kwh=round(float(m.grid_kw.sum() * 0.25), 0) if len(m) else None, peak_kw=int(m.grid_kw.max()) if len(m) else None,
                    baseline_peak_kw=float(self.B.baseline_peak_kw.iloc[0]) if len(self.B) else None,
                    co2_kg=round(float(m.grid_kw.sum() * 0.25 * 0.40), 0) if len(m) else None, comfort_violation_minutes=self.comfort_min, late_orders=late)
