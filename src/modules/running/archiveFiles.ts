/**
 * Reading a Strava archive (the zip Strava emails when you ask for your data): the zip itself, its
 * activities.csv, and the activity files inside (GPX, TCX or FIT, often gzipped). No libraries: a zip
 * is a list of entries at its end, and the browser can inflate them.
 *
 * Every parser returns a track in Apple Health's sample shape ([ms, lat, lon, elevation, speed] for
 * the route, [ms, bpm] for heart rate, [ms, metres] for distance) so the same code builds the splits,
 * best efforts, charts and map.
 */

// ---- Zip ---------------------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  method: number;
  size: number;
  csize: number;
  offset: number;
}

/** A zip's table of contents, read from its end (the file isn't loaded whole: archives can be large). */
export async function zipEntries(file: Blob): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 65_557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--)
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("This isn't a zip file. Choose the export_….zip file Strava emailed you.");
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error("This archive is too large to read here (over 4 GB). Ask Strava for it again without photos, or contact us.");
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const offset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    out.push({ name, method, size, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(data: Uint8Array, format: "deflate-raw" | "gzip"): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One entry's contents. */
export async function zipRead(file: Blob, e: ZipEntry): Promise<Uint8Array> {
  const head = new DataView(await file.slice(e.offset, e.offset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error(`The archive is damaged at ${e.name}.`);
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = new Uint8Array(await file.slice(start, start + e.csize).arrayBuffer());
  if (e.method === 0) return raw;
  if (e.method === 8) return inflate(raw, "deflate-raw");
  throw new Error(`The archive uses a compression this app can't read (${e.method}).`);
}

export const gunzip = (b: Uint8Array) => (b[0] === 0x1f && b[1] === 0x8b ? inflate(b, "gzip") : Promise.resolve(b));

// ---- CSV ---------------------------------------------------------------------------------------

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and new lines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0]);
}

export interface ArchiveActivity {
  id: string;
  /** UTC, ms. */
  start: number;
  name: string;
  type: string;
  elapsed: number;
  moving: number;
  /** Metres. */
  distance: number;
  elevation: number | null;
  avgHr: number | null;
  maxHr: number | null;
  file: string | null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Strava writes "Nov 8, 2026, 7:12:45 AM" (UTC) in English archives; ISO in some. */
export function parseStravaDate(s: string): number | null {
  const t = s.trim();
  const m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec(t);
  if (m && MONTHS[m[1].toLowerCase()] != null) {
    let h = +m[4] % (m[7] ? 12 : 24);
    if (m[7]?.toUpperCase() === "PM") h += 12;
    return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], h, +m[5], +m[6]);
  }
  const iso = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  return Number.isFinite(iso) ? iso : null;
}

const num = (s: string | undefined) => {
  if (s == null || s.trim() === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * activities.csv. Its header repeats some names (Strava lists a short summary, then the detailed
 * columns): "Distance" first in km, later in metres; "Elapsed Time" twice. So columns are found by
 * their last occurrence where the detailed value is wanted, and distance is checked for its unit.
 */
export function parseActivitiesCsv(text: string): ArchiveActivity[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const first = (n: string) => head.indexOf(n);
  const last = (n: string) => head.lastIndexOf(n);
  const col = {
    id: first("activity id"),
    date: first("activity date"),
    name: first("activity name"),
    type: first("activity type"),
    elapsed: last("elapsed time"),
    moving: last("moving time"),
    distKm: first("distance"),
    distM: last("distance"),
    elev: last("elevation gain"),
    avgHr: last("average heart rate"),
    maxHr: last("max heart rate"),
    file: last("filename"),
  };
  if (col.id < 0 || col.date < 0) throw new Error("activities.csv doesn't look like a Strava export (no Activity ID or Activity Date).");
  const out: ArchiveActivity[] = [];
  for (const r of rows.slice(1)) {
    const id = r[col.id]?.trim();
    const start = parseStravaDate(r[col.date] ?? "");
    if (!id || !/^\d+$/.test(id) || start == null) continue;
    // Metres if there's a separate metres column, else the summary distance in km.
    const dm = col.distM !== col.distKm ? num(r[col.distM]) : null;
    const dk = num(r[col.distKm]);
    const distance = dm != null && dm > 0 ? dm : dk != null ? dk * 1000 : 0;
    const elapsed = num(r[col.elapsed]) ?? 0;
    out.push({
      id,
      start,
      name: (r[col.name] ?? "").trim() || "Run",
      type: (r[col.type] ?? "").trim(),
      elapsed,
      moving: num(r[col.moving]) ?? elapsed,
      distance,
      elevation: col.elev >= 0 ? num(r[col.elev]) : null,
      avgHr: col.avgHr >= 0 ? num(r[col.avgHr]) : null,
      maxHr: col.maxHr >= 0 ? num(r[col.maxHr]) : null,
      file: col.file >= 0 ? (r[col.file] ?? "").trim() || null : null,
    });
  }
  return out;
}

/** Runs only: Run, Trail Run, Virtual Run (treadmill). */
export const isRunType = (t: string) => /^(run|trail run|virtual run|treadmill)$/i.test(t.trim());

// ---- Activity files ---------------------------------------------------------------------------

export interface Track {
  route: number[][];
  hr: number[][];
  dist: number[][];
  /** Minutes east of UTC where the run was recorded, when the file says (FIT does). */
  tzOffsetMin?: number;
}

const tag = (s: string, name: string) => {
  const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`).exec(s);
  return m ? m[1] : null;
};

export function parseGpx(xml: string): Track {
  const route: number[][] = [];
  const hr: number[][] = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const lat = Number(/lat="([^"]+)"/.exec(m[1])?.[1]);
    const lon = Number(/lon="([^"]+)"/.exec(m[1])?.[1]);
    const time = Date.parse(tag(m[2], "time") ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(time)) continue;
    const ele = num(tag(m[2], "ele") ?? undefined);
    route.push([time, lat, lon, ele as number, -1]);
    const h = num(tag(m[2], "hr") ?? undefined);
    if (h) hr.push([time, h]);
  }
  return { route, hr, dist: [] };
}

export function parseTcx(xml: string): Track {
  const route: number[][] = [];
  const hr: number[][] = [];
  const dist: number[][] = [];
  const re = /<Trackpoint>([\s\S]*?)<\/Trackpoint>/g;
  let m: RegExpExecArray | null;
  let lastD = 0;
  while ((m = re.exec(xml))) {
    const time = Date.parse(tag(m[1], "Time") ?? "");
    if (!Number.isFinite(time)) continue;
    const lat = num(tag(m[1], "LatitudeDegrees") ?? undefined);
    const lon = num(tag(m[1], "LongitudeDegrees") ?? undefined);
    const ele = num(tag(m[1], "AltitudeMeters") ?? undefined);
    if (lat != null && lon != null) route.push([time, lat, lon, ele as number, -1]);
    const h = /<HeartRateBpm[^>]*>\s*<Value>(\d+)<\/Value>/.exec(m[1]);
    if (h) hr.push([time, +h[1]]);
    const d = num(tag(m[1], "DistanceMeters") ?? undefined);
    if (d != null && d >= lastD) {
      dist.push([time, d - lastD]);
      lastD = d;
    }
  }
  return { route, hr, dist: route.length > 1 ? [] : dist };
}

/** FIT: the binary format watches record in. Only what a run needs: record messages (and the time zone). */
export function parseFit(buf: Uint8Array): Track {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hlen = buf[0];
  if (hlen < 12 || String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) !== ".FIT") throw new Error("Not a FIT file");
  const end = Math.min(buf.byteLength, hlen + v.getUint32(4, true));
  type Def = { little: boolean; global: number; fields: { num: number; size: number; type: number }[]; devSize: number };
  const defs = new Map<number, Def>();
  const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;
  let lastTs = 0;
  const route: number[][] = [];
  const hr: number[][] = [];
  const dist: number[][] = [];
  let lastD = 0;
  let tz: number | undefined;
  const read = (p: number, size: number, type: number, little: boolean): number | null => {
    const base = type & 0x1f;
    switch (size) {
      case 1: {
        const x = base === 1 ? v.getInt8(p) : v.getUint8(p);
        return (base === 1 ? x === 0x7f : x === 0xff) ? null : x;
      }
      case 2: {
        const x = base === 3 ? v.getInt16(p, little) : v.getUint16(p, little);
        return (base === 3 ? x === 0x7fff : x === 0xffff) ? null : x;
      }
      case 4: {
        const x = base === 5 ? v.getInt32(p, little) : v.getUint32(p, little);
        return (base === 5 ? x === 0x7fffffff : x === 0xffffffff) ? null : x;
      }
      default:
        return null;
    }
  };
  let p = hlen;
  while (p < end) {
    const h = buf[p++];
    if (h & 0x80) {
      // Compressed timestamp header: a data message with a 5-bit time offset.
      const local = (h >> 5) & 0x3;
      const off = h & 0x1f;
      const ts = (lastTs & ~0x1f) + off + (off < (lastTs & 0x1f) ? 0x20 : 0);
      lastTs = ts;
      const d = defs.get(local);
      if (!d) break;
      p = message(d, p, ts);
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      // Definition message.
      const little = buf[p + 1] === 0;
      const global = little ? v.getUint16(p + 2, true) : v.getUint16(p + 2, false);
      const n = buf[p + 4];
      const fields = [];
      for (let i = 0; i < n; i++) fields.push({ num: buf[p + 5 + i * 3], size: buf[p + 6 + i * 3], type: buf[p + 7 + i * 3] });
      p += 5 + n * 3;
      let devSize = 0;
      if (h & 0x20) {
        const dn = buf[p++];
        for (let i = 0; i < dn; i++) devSize += buf[p + i * 3 + 1];
        p += dn * 3;
      }
      defs.set(local, { little, global, fields, devSize });
    } else {
      const d = defs.get(local);
      if (!d) break;
      p = message(d, p, null);
    }
  }
  function message(d: Def, at: number, compressedTs: number | null): number {
    let q = at;
    const f: Record<number, number | null> = {};
    for (const fd of d.fields) {
      f[fd.num] = fd.size <= 4 ? read(q, fd.size, fd.type, d.little) : null;
      q += fd.size;
    }
    q += d.devSize;
    const ts = f[253] ?? compressedTs;
    if (f[253] != null) lastTs = f[253] as number;
    if (d.global === 20 && ts != null) {
      // record: position (semicircles), altitude, heart rate, distance (cm), speed (mm/s)
      const ms = (ts + FIT_EPOCH) * 1000;
      const lat = f[0];
      const lon = f[1];
      const alt = f[78] != null ? (f[78] as number) / 5 - 500 : f[2] != null ? (f[2] as number) / 5 - 500 : null;
      const spd = f[73] != null ? (f[73] as number) / 1000 : f[6] != null ? (f[6] as number) / 1000 : -1;
      if (lat != null && lon != null) route.push([ms, (lat * 180) / 2 ** 31, (lon * 180) / 2 ** 31, alt as number, spd]);
      if (f[3]) hr.push([ms, f[3] as number]);
      if (f[5] != null) {
        const m = (f[5] as number) / 100;
        if (m >= lastD) {
          dist.push([ms, m - lastD]);
          lastD = m;
        }
      }
    } else if (d.global === 34 && f[253] != null && f[5] != null) {
      // activity: local_timestamp − timestamp = the time zone it was recorded in
      tz = Math.round(((f[5] as number) - (f[253] as number)) / 60);
    }
    return q;
  }
  return { route, hr, dist: route.length > 1 ? [] : dist, tzOffsetMin: tz };
}

/** Any of the three, by the file's name (".fit.gz", ".gpx", ".tcx.gz"…). */
export async function parseActivityFile(name: string, bytes: Uint8Array): Promise<Track | null> {
  const n = name.toLowerCase();
  const b = n.endsWith(".gz") ? await gunzip(bytes) : bytes;
  if (/\.fit(\.gz)?$/.test(n)) return parseFit(b);
  const text = new TextDecoder().decode(b).trimStart();
  if (/\.gpx(\.gz)?$/.test(n)) return parseGpx(text);
  if (/\.tcx(\.gz)?$/.test(n)) return parseTcx(text);
  return null;
}
