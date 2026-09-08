import { mkdir, writeFile } from 'node:fs/promises';

const YEAR = 2024;
const STEP = 5;
const BATCH_SIZE = 240;
const CONCURRENCY = 1;
const MIN_REQUEST_INTERVAL_MS = 65000;
const endpoint = 'https://archive-api.open-meteo.com/v1/archive';

const lats = Array.from({ length: 36 }, (_, index) => -87.5 + index * STEP);
const lons = Array.from({ length: 72 }, (_, index) => -177.5 + index * STEP);
const points = lats.flatMap((lat) => lons.map((lon) => ({ lat, lon })));
const days = 366;
let lastRequestAt = 0;

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function fetchBatch(batch, batchIndex) {
  const params = new URLSearchParams({
    latitude: batch.map((point) => point.lat).join(','),
    longitude: batch.map((point) => point.lon).join(','),
    start_date: `${YEAR}-01-01`,
    end_date: `${YEAR}-12-31`,
    daily: 'temperature_2m_max,dew_point_2m_mean,wind_speed_10m_max,relative_humidity_2m_mean,cloud_cover_mean',
    timezone: 'UTC',
    wind_speed_unit: 'ms',
    cell_selection: 'nearest',
  });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
    lastRequestAt = Date.now();
    const response = await fetch(`${endpoint}?${params}`);
    if (response.ok) {
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [payload];
    }
    const errorBody = await response.text();
    if (/daily api request limit exceeded/i.test(errorBody)) throw new Error('Open-Meteo daily API quota is exhausted; retry the atlas import after the quota resets');
    if (response.status !== 429 && response.status < 500) throw new Error(`Open-Meteo batch ${batchIndex + 1} failed: ${response.status}`);
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) ? Math.max(MIN_REQUEST_INTERVAL_MS, retryAfter * 1000) : MIN_REQUEST_INTERVAL_MS;
    process.stdout.write(`Rate limited on batch ${batchIndex + 1}; waiting ${Math.round(waitMs / 1000)}s\n`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  throw new Error(`Open-Meteo batch ${batchIndex + 1} failed after retries`);
}

async function main() {
  const count = points.length * days;
  const tmax = new Int16Array(count);
  const dew = new Int16Array(count);
  const wind = new Uint8Array(count);
  const humidity = new Uint8Array(count);
  const cloud = new Uint8Array(count);
  const batches = chunks(points, BATCH_SIZE);
  let nextBatch = 0;

  async function worker() {
    while (nextBatch < batches.length) {
      const batchIndex = nextBatch++;
      const payloads = await fetchBatch(batches[batchIndex], batchIndex);
      payloads.forEach((payload, payloadIndex) => {
        const pointIndex = batchIndex * BATCH_SIZE + payloadIndex;
        const offset = pointIndex * days;
        const daily = payload.daily ?? {};
        for (let day = 0; day < days; day += 1) {
          const temp = Number(daily.temperature_2m_max?.[day]);
          const dewPoint = Number(daily.dew_point_2m_mean?.[day]);
          const speed = Number(daily.wind_speed_10m_max?.[day]);
          const rh = Number(daily.relative_humidity_2m_mean?.[day]);
          const cover = Number(daily.cloud_cover_mean?.[day]);
          tmax[offset + day] = Number.isFinite(temp) ? Math.round(temp * 10) : -32768;
          dew[offset + day] = Number.isFinite(dewPoint) ? Math.round(dewPoint * 10) : -32768;
          wind[offset + day] = Number.isFinite(speed) ? Math.max(0, Math.min(255, Math.round(speed * 10))) : 255;
          humidity[offset + day] = Number.isFinite(rh) ? Math.max(0, Math.min(100, Math.round(rh))) : 255;
          cloud[offset + day] = Number.isFinite(cover) ? Math.max(0, Math.min(100, Math.round(cover))) : 255;
        }
      });
      process.stdout.write(`Fetched ${Math.min((batchIndex + 1) * BATCH_SIZE, points.length)}/${points.length} grid cells\n`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const headerBytes = 16;
  const bytes = Buffer.alloc(headerBytes + tmax.byteLength + dew.byteLength + wind.byteLength + humidity.byteLength + cloud.byteLength);
  const header = new Uint32Array(bytes.buffer, bytes.byteOffset, 4);
  header[0] = lons.length;
  header[1] = lats.length;
  header[2] = days;
  header[3] = YEAR;
  let offset = headerBytes;
  Buffer.from(tmax.buffer).copy(bytes, offset); offset += tmax.byteLength;
  Buffer.from(dew.buffer).copy(bytes, offset); offset += dew.byteLength;
  Buffer.from(wind.buffer).copy(bytes, offset); offset += wind.byteLength;
  Buffer.from(humidity.buffer).copy(bytes, offset); offset += humidity.byteLength;
  Buffer.from(cloud.buffer).copy(bytes, offset);

  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await writeFile(new URL('../public/atlas-2024.bin', import.meta.url), bytes);
  await writeFile(new URL('../public/atlas-meta.json', import.meta.url), JSON.stringify({
    source: 'Open-Meteo Historical Weather API (ERA5 reanalysis)',
    sourceUrl: 'https://open-meteo.com/en/docs/historical-weather-api',
    year: YEAR,
    resolution: `${STEP}° global grid`,
    latitudeCenters: lats,
    longitudeCenters: lons,
    variables: {
      tmax: 'Daily maximum 2 m temperature, encoded in tenths of °C',
      dew: 'Daily mean 2 m dew point, encoded in tenths of °C',
      wind: 'Daily maximum 10 m wind speed, encoded in tenths of m/s',
      humidity: 'Daily mean 2 m relative humidity, %',
      cloud: 'Daily mean total cloud cover, %',
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
