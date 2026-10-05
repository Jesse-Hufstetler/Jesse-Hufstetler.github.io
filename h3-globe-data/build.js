// Source data: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson (save next to this file as ne_50m_land.geojson)
// Builds land.json (compact coastline rings) and counts of land-touching H3 cells per resolution.
// Usage: node build.js   (needs h3-js available, e.g. `npm i h3-js` somewhere on NODE_PATH)
const fs = require('fs'), h3 = require('h3-js');
const src = JSON.parse(fs.readFileSync(__dirname + '/ne_50m_land.geojson'));

// --- compact rings (2 decimals, flat [lon,lat,...]) ---
const rings = [];
for (const f of src.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) for (const r of p) {
        const flat = []; let lx, ly;
        for (const [x, y] of r) {
            const X = Math.round(x * 100) / 100, Y = Math.round(y * 100) / 100;
            if (X === lx && Y === ly) continue;
            flat.push(X, Y); lx = X; ly = Y;
        }
        if (flat.length >= 6) rings.push(flat);
    }
}

// --- even-odd scanline raster of all rings ---
const W = 16384, H = 8192;
const mask = new Uint8Array(W * H);
const cross = Array.from({ length: H }, () => []);
for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
        const j = (i + 2) % r.length;
        let x1 = (r[i] + 180) / 360 * W, y1 = (90 - r[i + 1]) / 180 * H;
        let x2 = (r[j] + 180) / 360 * W, y2 = (90 - r[j + 1]) / 180 * H;
        if (y1 === y2) continue;
        if (y1 > y2) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1]; }
        const a = Math.max(0, Math.ceil(y1 - 0.5)), b = Math.min(H - 1, Math.ceil(y2 - 0.5) - 1);
        for (let y = a; y <= b; y++) cross[y].push(x1 + (y + 0.5 - y1) / (y2 - y1) * (x2 - x1));
    }
}
for (let y = 0; y < H; y++) {
    const c = cross[y].sort((p, q) => p - q);
    for (let k = 0; k + 1 < c.length; k += 2) {
        for (let x = Math.max(0, Math.round(c[k])); x < Math.min(W, Math.round(c[k + 1])); x++) mask[y * W + x] = 1;
    }
}
const land = (lng, lat) => {
    let x = Math.floor((lng + 180) / 360 * W), y = Math.floor((90 - lat) / 180 * H);
    x = ((x % W) + W) % W; y = Math.min(H - 1, Math.max(0, y));
    return mask[y * W + x] === 1;
};
function touches(c) {
    const [la, ln] = h3.cellToLatLng(c);
    if (land(ln, la)) return true;
    const b = h3.cellToBoundary(c, true);
    for (let i = 0; i < b.length; i++) {
        const p = b[i], q = b[(i + 1) % b.length];
        if (land(p[0], p[1])) return true;
        let dl = q[0] - p[0]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
        if (land(p[0] + dl / 2, (p[1] + q[1]) / 2)) return true;
    }
    return false;
}

const counts = [];
for (let res = 0; res <= 6; res++) {
    let n = 0;
    for (const base of h3.getRes0Cells()) for (const c of h3.cellToChildren(base, res)) if (touches(c)) n++;
    counts.push(n);
    console.log('res', res, n);
}
fs.writeFileSync(__dirname + '/land.json', JSON.stringify({ rings, counts }));
console.log('wrote land.json', fs.statSync(__dirname + '/land.json').size);
