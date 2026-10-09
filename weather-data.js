// Data layer for weather.html: location, fetching every source, normalising to the payload start(D) expects.
// Series = {src, metric, s: [[startUnix, endUnix, value], ...]}
(() => {
const $ = id => document.getElementById(id);
const NOW = Math.floor(Date.now() / 1000);
const KEY_STORE = 'owmKey';

// ───────────── config (mirrors the LINQPad script) ─────────────
const HORIZON_DAYS = 10;
const TEMP_STOPS = [[-10,'#4b1d91'],[10,'#2b3fd6'],[32,'#3b8cff'],[45,'#9ad4f5'],[55,'#bfcde8'],[65,'#6fd0d0'],[75,'#6fd08a'],[85,'#f3d34a'],[95,'#f08a24'],[105,'#d61f1f'],[115,'#7a0a0a']];
const METRICS = [
  { key:'temp',  label:'Temperature', unit:'°F',   dec:0, good:[65,75],   stops:TEMP_STOPS },
  { key:'feels', label:'Feels like',  unit:'°F',   dec:0, good:[65,75],   stops:TEMP_STOPS },
  { key:'dew',   label:'Dew point',   unit:'°F',   dec:0, good:[40,60],   stops:[[0,'#6a7bd6'],[32,'#8fb8f0'],[40,'#6fd08a'],[60,'#6fd08a'],[65,'#f3d34a'],[70,'#f08a24'],[75,'#d61f1f'],[80,'#7a0a0a']] },
  { key:'wind',  label:'Wind',        unit:'mph',  dec:0, good:[0,10],    stops:[[0,'#6fd08a'],[10,'#6fd08a'],[15,'#f3d34a'],[25,'#f08a24'],[35,'#d61f1f'],[50,'#6b0a3a']] },
  { key:'gust',  label:'Gusts',       unit:'mph',  dec:0, good:[0,15],    stops:[[0,'#6fd08a'],[15,'#6fd08a'],[25,'#f3d34a'],[35,'#f08a24'],[45,'#d61f1f'],[60,'#6b0a3a']] },
  { key:'pop',   label:'Rain chance', unit:'%',    dec:0, good:[0,15],    stops:[[0,'#6fd08a'],[15,'#6fd08a'],[35,'#c9e58a'],[50,'#6fb1ff'],[70,'#2f6be0'],[100,'#1b2a8f']] },
  { key:'rain',  label:'Rain rate',   unit:'in/hr',dec:2, good:[0,0.004], stops:[[0,'#6fd08a'],[0.004,'#6fd08a'],[0.02,'#6fb1ff'],[0.1,'#2f6be0'],[0.3,'#6a2fd6'],[1,'#d61f1f']] },
  { key:'cloud', label:'Cloud cover', unit:'%',    dec:0, good:[0,100],   stops:[[0,'#6fd08a'],[50,'#a6b9ad'],[100,'#576360']] },
];
const SOURCES = [
  ['nws','NWS forecast','NWS'],['nbm','NBM (blend)','NBM'],['hrrr','HRRR (rapid refresh)','HRRR'],['gfs','GFS (US)','GFS'],
  ['ecmwf','ECMWF (Europe)','ECMWF'],['icon','ICON (Germany)','ICON'],['gem','GEM (Canada)','GEM'],['ukmo','UKMO (UK)','UKMO'],
  ['mf','Météo-France','MF'],['jma','JMA (Japan)','JMA'],['metno','MET Norway','MET.no'],['owm','OpenWeatherMap','OWM'],['om15','Open-Meteo 15-min','OM15'],
].map(([id, name, short]) => ({ id, name, short }));

// ───────────── unit + weather math ─────────────
const ctof = c => c * 9 / 5 + 32, kmh = k => k * 0.621371, ms = m => m * 2.236936, mm = m => m / 25.4;
const r3 = v => Math.round(v * 1000) / 1000;
const dewPointF = (tF, rh) => { const c = (tF - 32) * 5 / 9, a = 17.62, b = 243.12, g = Math.log(Math.max(rh, 1) / 100) + a * c / (b + c); return ctof(b * g / (a - g)); };
const rhPct = (tF, dF) => { const c = (tF - 32) * 5 / 9, d = (dF - 32) * 5 / 9, a = 17.62, b = 243.12; return Math.min(100, 100 * Math.exp(a * d / (b + d) - a * c / (b + c))); };
function feelsLikeF(t, dew, wind) {   // wind chill when cold and breezy, heat index when hot, else air temp
  if (t <= 50 && wind > 3) { const v = Math.pow(wind, 0.16); return 35.74 + 0.6215 * t - 35.75 * v + 0.4275 * t * v; }
  if (t < 80) return t;
  const rh = rhPct(t, dew);
  let hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - .22475541 * t * rh - .00683783 * t * t - .05481717 * rh * rh + .00122874 * t * t * rh + .00085282 * t * rh * rh - .00000199 * t * t * rh * rh;
  if (rh < 13 && t <= 112) hi -= (13 - rh) / 4 * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  else if (rh > 85 && t <= 87) hi += (rh - 85) / 10 * ((87 - t) / 5);
  return hi;
}
const unix = iso => Date.parse(iso) / 1000;
function isoDurSeconds(d) {   // PT6H, P1DT6H, PT30M …
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d) || [];
  return ((+m[1] || 0) * 86400) + ((+m[2] || 0) * 3600) + ((+m[3] || 0) * 60);
}

// A point sample owns the time nearest to it (midpoint before to midpoint after).
function voronoi(pts) {
  pts = [...pts].sort((a, b) => a[0] - b[0]);
  return pts.map(([t, v], i) => {
    const prev = i > 0 ? t - pts[i - 1][0] : (i + 1 < pts.length ? pts[i + 1][0] - t : 3600);
    const next = i + 1 < pts.length ? pts[i + 1][0] - t : prev;
    return [t - prev / 2, t + next / 2, r3(v)];
  });
}
function keep(list, src, metric, spans) {
  spans = spans.filter(s => s[1] > NOW - 3600).sort((a, b) => a[0] - b[0]);
  if (spans.length) list.push({ src, metric, s: spans });
}
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
    catch (e) { if (attempt >= 2) throw e; await new Promise(r => setTimeout(r, 1500)); }
  }
}

function deriveFeelsLike(all) {
  const at = (s, t) => { const x = s.find(x => x[0] <= t && t < x[1]); return x ? x[2] : null; };
  const out = [], bySrc = {};
  all.forEach(s => (bySrc[s.src] = bySrc[s.src] || []).push(s));
  for (const [src, g] of Object.entries(bySrc)) {
    if (g.some(s => s.metric === 'feels')) continue;
    const temp = g.find(s => s.metric === 'temp'), dew = g.find(s => s.metric === 'dew'), wind = g.find(s => s.metric === 'wind');
    if (!temp || !dew || !wind) continue;
    const spans = [];
    for (const s of temp.s) {
      const mid = (s[0] + s[1]) / 2, d = at(dew.s, mid), w = at(wind.s, mid);
      if (d != null && w != null) spans.push([s[0], s[1], r3(feelsLikeF(s[2], d, w))]);
    }
    if (spans.length) out.push({ src, metric: 'feels', s: spans });
  }
  return out;
}

// ───────────── sources ─────────────
async function fetchNws(lat, lon) {
  const pt = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`);
  const p = (await getJson(pt.properties.forecastGridData)).properties, list = [];
  const add = (key, metric, conv) => {
    const vals = p[key]?.values; if (!vals) return;
    const spans = [];
    for (const x of vals) {
      if (x.value == null) continue;
      const [t0, dur] = x.validTime.split('/'), start = unix(t0), secs = isoDurSeconds(dur);
      spans.push([start, start + secs, r3(conv(x.value, secs / 3600))]);
    }
    keep(list, 'nws', metric, spans);
  };
  add('temperature', 'temp', ctof); add('apparentTemperature', 'feels', ctof); add('dewpoint', 'dew', ctof);
  add('windSpeed', 'wind', kmh); add('windGust', 'gust', kmh); add('probabilityOfPrecipitation', 'pop', v => v);
  add('quantitativePrecipitation', 'rain', (v, h) => mm(v) / h); add('skyCover', 'cloud', v => v);
  return list;
}

async function fetchMetNo(lat, lon) {
  const j = await getJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
  const ts = j.properties.timeseries, list = [];
  const inst = (field, metric, conv) => {
    const pts = []; for (const t of ts) { const v = t.data.instant.details[field]; if (v != null) pts.push([unix(t.time), conv(v)]); }
    keep(list, 'metno', metric, voronoi(pts));
  };
  inst('air_temperature', 'temp', ctof); inst('dew_point_temperature', 'dew', ctof); inst('wind_speed', 'wind', ms);
  inst('wind_speed_of_gust', 'gust', ms); inst('cloud_area_fraction', 'cloud', v => v);
  const rain = [], pop = [];
  for (const t of ts) {
    const start = unix(t.time); let hrs = 1, blk = t.data.next_1_hours;
    if (!blk) { hrs = 6; blk = t.data.next_6_hours; }
    const d = blk?.details; if (!d) continue;
    if (d.precipitation_amount != null) rain.push([start, start + hrs * 3600, Math.round(mm(d.precipitation_amount) / hrs * 1e4) / 1e4]);
    if (d.probability_of_precipitation != null) pop.push([start, start + hrs * 3600, d.probability_of_precipitation]);
  }
  keep(list, 'metno', 'rain', rain); keep(list, 'metno', 'pop', pop);
  return list;
}

async function fetchOwm(lat, lon, key) {
  if (!key) return [];
  const j = await getJson(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&units=imperial&appid=${encodeURIComponent(key)}`);
  const list = [];
  const block = f => j.list.flatMap(it => { const v = f(it); return v == null ? [] : [[it.dt - 5400, it.dt + 5400, r3(v)]]; });   // dt = centre of a 3h block
  keep(list, 'owm', 'temp', block(it => it.main.temp));
  keep(list, 'owm', 'feels', block(it => it.main.feels_like));
  keep(list, 'owm', 'dew', block(it => dewPointF(it.main.temp, it.main.humidity)));
  keep(list, 'owm', 'wind', block(it => it.wind.speed));
  keep(list, 'owm', 'gust', block(it => it.wind.gust));
  keep(list, 'owm', 'pop', block(it => it.pop * 100));
  keep(list, 'owm', 'rain', block(it => mm((it.rain?.['3h'] ?? 0) + (it.snow?.['3h'] ?? 0)) / 3));
  keep(list, 'owm', 'cloud', block(it => it.clouds.all));
  return list;
}

async function fetchOpenMeteoModels(lat, lon, out) {
  const models = { gfs_seamless:'gfs', ecmwf_ifs025:'ecmwf', icon_seamless:'icon', gem_seamless:'gem', ukmo_seamless:'ukmo', meteofrance_seamless:'mf', jma_seamless:'jma', gfs_hrrr:'hrrr', ncep_nbm_conus:'nbm' };
  const vars = [['temperature_2m','temp',false],['apparent_temperature','feels',false],['dew_point_2m','dew',false],['wind_speed_10m','wind',false],['wind_gusts_10m','gust',false],
                ['cloud_cover','cloud',false],['precipitation_probability','pop',true],['precipitation','rain',true]];
  const url = 'https://api.open-meteo.com/v1/forecast?' +
    `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${vars.map(v => v[0]).join(',')}&daily=sunrise,sunset` +
    `&models=${Object.keys(models).join(',')}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime&forecast_days=16&timezone=auto`;
  const j = await getJson(url);
  out.tz = j.timezone;
  const times = j.hourly.time, list = [];
  for (const [model, src] of Object.entries(models))
    for (const [api, metric, preceding] of vars) {
      const arr = j.hourly[`${api}_${model}`]; if (!arr) continue;
      if (preceding) {   // value describes the hour ENDING at t
        const spans = []; arr.forEach((v, i) => { if (v != null) spans.push([times[i] - 3600, times[i], r3(v)]); });
        keep(list, src, metric, spans);
      } else {
        const pts = []; arr.forEach((v, i) => { if (v != null) pts.push([times[i], v]); });
        keep(list, src, metric, voronoi(pts));
      }
    }
  const rise = j.daily.sunrise_gfs_seamless || j.daily.sunrise, set = j.daily.sunset_gfs_seamless || j.daily.sunset;
  rise.forEach((r, i) => { if (r != null && set[i] != null) out.sun.push([r, set[i]]); });
  return list;
}

async function fetchOpenMeteoMinutely(lat, lon) {
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&minutely_15=precipitation&forecast_minutely_15=96&precipitation_unit=inch&timeformat=unixtime`);
  const t = j.minutely_15.time, spans = [];
  j.minutely_15.precipitation.forEach((v, i) => { if (v != null) spans.push([t[i] - 900, t[i], Math.round(v * 4 * 1e4) / 1e4]); });   // in/15min -> in/hr
  const list = []; keep(list, 'om15', 'rain', spans); return list;
}

// ───────────── location ─────────────
const STATES = { AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia' };

async function geocode(text) {
  text = text.trim();
  const ll = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (ll) return { lat: +ll[1], lon: +ll[2], name: `${(+ll[1]).toFixed(3)}, ${(+ll[2]).toFixed(3)}` };
  const zip = /^(\d{5})(?:-\d{4})?$/.exec(text);   // Open-Meteo's geocoder doesn't do postal codes
  if (zip) {
    const z = await getJson(`https://api.zippopotam.us/us/${zip[1]}`).catch(() => null);
    const p = z && z.places && z.places[0];
    if (p) return { lat: +p.latitude, lon: +p.longitude, name: `${p['place name']}, ${p['state abbreviation']}` };
    throw new Error(`No place found for "${text}"`);
  }
  const [first, ...rest] = text.split(',').map(s => s.trim());
  const hint = rest.join(' ').toLowerCase();
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(first)}&count=10&language=en&format=json`);
  const res = j.results || [];
  if (!res.length) throw new Error(`No place found for "${text}"`);
  const want = (STATES[hint.toUpperCase()] || hint).toLowerCase();
  const pick = (hint && res.find(r => [r.admin1, r.country, r.country_code].some(x => x && x.toLowerCase() === want))) || res[0];
  return { lat: pick.latitude, lon: pick.longitude, name: [pick.name, pick.admin1 && pick.country_code === 'US' ? Object.keys(STATES).find(k => STATES[k] === pick.admin1) || pick.admin1 : pick.admin1 || pick.country].filter(Boolean).join(', ') };
}
function gpsPosition() {
  return new Promise((res, rej) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), e => rej(new Error(e.message || 'Location unavailable')), { timeout: 15000, maximumAge: 600000 })
    : rej(new Error('Geolocation not supported')));
}
async function reverseName(lat, lon) {   // best effort; falls back to coordinates
  try {
    const j = await getJson(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const st = (j.principalSubdivisionCode || '').split('-')[1] || j.principalSubdivision;
    const n = [j.city || j.locality, st].filter(Boolean).join(', ');
    if (n) return n;
  } catch {}
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };

function setOverride(loc) {   // the override lives in the URL; no override params = use device location
  const u = new URL(location.href);
  ['lat', 'lon', 'name'].forEach(k => u.searchParams.delete(k));
  if (loc) { u.searchParams.set('lat', loc.lat.toFixed(4)); u.searchParams.set('lon', loc.lon.toFixed(4)); u.searchParams.set('name', loc.name); }
  location.href = u.toString();
}

// ───────────── footer: optional OpenWeatherMap key ─────────────
function keyUi() {
  const label = () => $('keyb').textContent = lsGet(KEY_STORE) ? 'OpenWeatherMap: on' : '+ OpenWeatherMap (optional)';
  label();
  $('keyb').onclick = () => { $('keyrow').hidden = !$('keyrow').hidden; if (!$('keyrow').hidden) $('key').focus(); };
  $('keysave').onclick = () => { const v = $('key').value.trim(); if (v) { lsSet(KEY_STORE, v); location.reload(); } };
  $('keyclr').onclick = () => { lsSet(KEY_STORE, ''); location.reload(); };
}

// ───────────── main ─────────────
async function main() {
  keyUi();
  const q = new URLSearchParams(location.search);
  const hasOverride = q.has('lat') && q.has('lon') && isFinite(+q.get('lat')) && isFinite(+q.get('lon'));
  $('gps').hidden = !hasOverride;
  $('gps').onclick = () => setOverride(null);
  $('locf').onsubmit = async e => {
    e.preventDefault();
    const text = $('loc').value.trim(); if (!text) return setOverride(null);
    try { setOverride(await geocode(text)); } catch (err) { $('warn').textContent = '⚠ ' + err.message; }
  };

  let loc;
  if (hasOverride) {
    loc = { lat: +q.get('lat'), lon: +q.get('lon'), name: q.get('name') || `${(+q.get('lat')).toFixed(3)}, ${(+q.get('lon')).toFixed(3)}` };
    $('loc').value = loc.name;
  } else {
    try {
      const p = await gpsPosition();
      loc = { ...p, name: await reverseName(p.lat, p.lon) };
    } catch (err) {
      $('msg').textContent = `Couldn't get your location (${err.message}). Type a city, zip, or lat,lon above.`;
      return;
    }
  }
  $('msg').textContent = `Fetching forecasts for ${loc.name}…`;

  const extra = { tz: 'UTC', sun: [] };
  const jobs = [
    ['NWS', () => fetchNws(loc.lat, loc.lon)], ['MET Norway', () => fetchMetNo(loc.lat, loc.lon)],
    ['OpenWeatherMap', () => fetchOwm(loc.lat, loc.lon, lsGet(KEY_STORE))],
    ['Open-Meteo models', () => fetchOpenMeteoModels(loc.lat, loc.lon, extra)], ['Open-Meteo 15-min', () => fetchOpenMeteoMinutely(loc.lat, loc.lon)],
  ];
  const results = await Promise.all(jobs.map(async ([name, run]) => {
    try { return { name, data: await run() }; } catch (e) { return { name, data: [], err: e.message.split('\n')[0] }; }   // one dead source shouldn't kill the page
  }));
  const warnings = results.filter(r => r.err).map(r => `${r.name}: ${r.err}`);
  const series = results.flatMap(r => r.data);
  series.push(...deriveFeelsLike(series));
  if (!series.length) { $('msg').textContent = 'No forecast data came back. ' + warnings.join(' | '); return; }

  start({ place: loc.name, lat: loc.lat, lon: loc.lon, generated: NOW, tz: extra.tz, horizonDays: HORIZON_DAYS, warnings,
          metrics: METRICS, sources: SOURCES, series: series.map(s => ({ src: s.src, metric: s.metric, s: s.s })), sun: extra.sun });
}
main();
})();
