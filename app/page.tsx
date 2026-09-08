'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';

type Criteria = {
  tempMin: number;
  tempMax: number;
  dewMin: number;
  dewMax: number;
  windMax: number;
  cloudMax: number;
  monthStart: number;
  monthEnd: number;
};

type AtlasData = {
  width: number;
  height: number;
  days: number;
  year: number;
  lats: number[];
  lons: number[];
  tmax: Int16Array;
  wind: Uint8Array;
  humidity: Uint8Array;
  cloud: Uint8Array;
  source: 'Open-Meteo · ERA5' | 'local fallback';
};

type City = { name: string; country: string; lat: number; lon: number };
type HoverState = { index: number; displayCol: number; displayRow: number; lat: number; lon: number; x: number; y: number } | null;
type ViewState = { scale: number; x: number; y: number };
type HoverSummary = { temp: number; dew: number; wind: number; cloud: number; tempDays: number; dewDays: number; windDays: number; cloudDays: number };
type ViewMode = 'map' | 'globe';
type CountryFeature = GeoJSON.Feature<GeoJSON.GeometryObject>;
type CountryTopology = Topology<{ countries: GeometryCollection }>;

const DEFAULT_CRITERIA: Criteria = {
  tempMin: 20,
  tempMax: 28,
  dewMin: 4,
  dewMax: 16,
  windMax: 4.5,
  cloudMax: 65,
  monthStart: 1,
  monthEnd: 12,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PALETTE = ['#318fa0', '#71bca2', '#b9da9a', '#f5f5aa', '#ffd778', '#f99a5d', '#e95b50', '#ad1e4d'];
const DISPLAY_FACTOR = 5;
const OCEAN_COLOUR = '#d8e0dd';
const EQUATOR_COLOUR = 'rgba(35, 78, 84, .42)';
const CITIES: City[] = [
  { name: 'Vancouver', country: 'Canada', lat: 49.28, lon: -123.12 },
  { name: 'New York', country: 'United States', lat: 40.71, lon: -74.0 },
  { name: 'Mexico City', country: 'Mexico', lat: 19.43, lon: -99.13 },
  { name: 'Lima', country: 'Peru', lat: -12.05, lon: -77.04 },
  { name: 'Rio de Janeiro', country: 'Brazil', lat: -22.91, lon: -43.17 },
  { name: 'Lisbon', country: 'Portugal', lat: 38.72, lon: -9.14 },
  { name: 'London', country: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { name: 'Cape Town', country: 'South Africa', lat: -33.92, lon: 18.42 },
  { name: 'Nairobi', country: 'Kenya', lat: -1.29, lon: 36.82 },
  { name: 'Cairo', country: 'Egypt', lat: 30.04, lon: 31.24 },
  { name: 'Dubai', country: 'UAE', lat: 25.2, lon: 55.27 },
  { name: 'Mumbai', country: 'India', lat: 19.08, lon: 72.88 },
  { name: 'Singapore', country: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Sydney', country: 'Australia', lat: -33.87, lon: 151.21 },
  { name: 'Auckland', country: 'New Zealand', lat: -36.85, lon: 174.76 },
  { name: 'Tokyo', country: 'Japan', lat: 35.68, lon: 139.65 },
  { name: 'Honolulu', country: 'United States', lat: 21.31, lon: -157.86 },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function wrap(value: number, period: number) {
  return ((value % period) + period) % period;
}

function wrapLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function traceRing(context: CanvasRenderingContext2D, ring: number[][], width: number, height: number) {
  let previousLongitude: number | null = null;
  ring.forEach(([longitude, latitude], pointIndex) => {
    const x = ((longitude + 180) / 360) * width;
    const y = ((90 - latitude) / 180) * height;
    if (pointIndex === 0 || (previousLongitude !== null && Math.abs(longitude - previousLongitude) > 180)) context.moveTo(x, y);
    else context.lineTo(x, y);
    previousLongitude = longitude;
  });
}

function createLandMask(features: CountryFeature[], width: number, height: number) {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext('2d');
  if (!maskContext) return null;
  maskContext.fillStyle = '#fff';
  for (const country of features) {
    const geometry = country.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      maskContext.beginPath();
      for (const ring of polygon) traceRing(maskContext, ring, width, height);
      maskContext.fill();
    }
  }
  const pixels = maskContext.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) mask[index] = pixels[index * 4 + 3] > 0 ? 1 : 0;
  return mask;
}

function dewPoint(temp: number, relativeHumidity: number) {
  const rh = clamp(relativeHumidity, 1, 100);
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh / 100) + (a * temp) / (b + temp);
  return (b * gamma) / (a - gamma);
}

function createFallbackAtlas(): AtlasData {
  const width = 72;
  const height = 36;
  const days = 366;
  const lats = Array.from({ length: height }, (_, index) => -87.5 + index * 5);
  const lons = Array.from({ length: width }, (_, index) => -177.5 + index * 5);
  const size = width * height * days;
  const tmax = new Int16Array(size);
  const wind = new Uint8Array(size);
  const humidity = new Uint8Array(size);
  const cloud = new Uint8Array(size);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const lat = lats[row];
      const lon = lons[col];
      const base = row * width * days + col * days;
      const latitudeWarmth = 31 - Math.abs(lat) * 0.48;
      const coastWave = Math.sin((lon + lat * 1.4) * Math.PI / 36) * 3;
      for (let day = 0; day < days; day += 1) {
        const seasonal = Math.cos(((day - 24) / 366) * Math.PI * 2) * Math.sin((lat * Math.PI) / 180) * 11;
        const noise = Math.sin(day * 0.72 + lon * 0.11 + lat * 0.08) * 4;
        const value = latitudeWarmth + coastWave + seasonal + noise;
        const rh = clamp(61 + Math.abs(lat) * 0.16 + Math.cos(day / 19 + lon) * 16 - Math.max(0, value - 25) * 1.3, 20, 98);
        const breeze = clamp(2.2 + Math.abs(lat) / 26 + Math.sin(day / 13 + lon / 30) * 1.6, 0.4, 12);
        const cover = clamp(42 + Math.sin(day / 17 + lon / 20) * 28 + Math.abs(lat) * 0.08, 4, 100);
        tmax[base + day] = Math.round(value * 10);
        wind[base + day] = Math.round(breeze * 10);
        humidity[base + day] = Math.round(rh);
        cloud[base + day] = Math.round(cover);
      }
    }
  }
  return { width, height, days, year: 2024, lats, lons, tmax, wind, humidity, cloud, source: 'local fallback' };
}

async function loadAtlas(): Promise<AtlasData> {
  const [metaResponse, dataResponse] = await Promise.all([fetch('/atlas-meta.json'), fetch('/atlas-2024.bin')]);
  if (!metaResponse.ok || !dataResponse.ok) throw new Error('Atlas files are not available yet');
  const meta = await metaResponse.json();
  const buffer = await dataResponse.arrayBuffer();
  const header = new Uint32Array(buffer, 0, 4);
  const width = header[0];
  const height = header[1];
  const days = header[2];
  const year = header[3];
  const cellDays = width * height * days;
  let offset = 16;
  const tmax = new Int16Array(buffer, offset, cellDays); offset += cellDays * 2;
  const wind = new Uint8Array(buffer, offset, cellDays); offset += cellDays;
  const humidity = new Uint8Array(buffer, offset, cellDays); offset += cellDays;
  const cloud = new Uint8Array(buffer, offset, cellDays);
  return { width, height, days, year, lats: meta.latitudeCenters, lons: meta.longitudeCenters, tmax, wind, humidity, cloud, source: 'Open-Meteo · ERA5' };
}

function createMonthMap(year: number) {
  const result: number[] = [];
  for (let day = 0; day < 366; day += 1) result.push(new Date(Date.UTC(year, 0, day + 1)).getUTCMonth() + 1);
  return result;
}

function colourForCount(count: number, max: number) {
  if (max <= 0) return PALETTE[0];
  return PALETTE[Math.min(PALETTE.length - 1, Math.floor(clamp(count / max, 0, 1) * PALETTE.length))];
}

function refineCounts(counts: Uint16Array, width: number, height: number, factor: number) {
  const refinedWidth = width * factor;
  const refinedHeight = height * factor;
  const values = new Float32Array(refinedWidth * refinedHeight);
  const wrapColumn = (column: number) => (column + width) % width;
  const clampRow = (row: number) => clamp(row, 0, height - 1);
  for (let row = 0; row < refinedHeight; row += 1) {
    const sourceRow = (row + 0.5) / factor - 0.5;
    const row0 = clampRow(Math.floor(sourceRow));
    const row1 = clampRow(row0 + 1);
    const rowBlend = sourceRow - Math.floor(sourceRow);
    for (let column = 0; column < refinedWidth; column += 1) {
      const sourceColumn = (column + 0.5) / factor - 0.5;
      const column0 = wrapColumn(Math.floor(sourceColumn));
      const column1 = wrapColumn(column0 + 1);
      const columnBlend = sourceColumn - Math.floor(sourceColumn);
      const top = counts[row0 * width + column0] * (1 - columnBlend) + counts[row0 * width + column1] * columnBlend;
      const bottom = counts[row1 * width + column0] * (1 - columnBlend) + counts[row1 * width + column1] * columnBlend;
      values[row * refinedWidth + column] = top * (1 - rowBlend) + bottom * rowBlend;
    }
  }
  return { width: refinedWidth, height: refinedHeight, values };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 }).format(value);
}

function CriteriaRange({ label, min, max, lower, upper, step, unit, onLower, onUpper }: { label: string; min: number; max: number; lower: number; upper: number; step: number; unit: string; onLower: (value: number) => void; onUpper: (value: number) => void }) {
  const left = ((lower - min) / (max - min)) * 100;
  const right = ((upper - min) / (max - min)) * 100;
  return (
    <div className="criteria-range">
      <div className="criteria-range__heading"><span>{label}</span><strong>{formatNumber(lower)}–{formatNumber(upper)} {unit}</strong></div>
      <div className="criteria-range__track"><span className="criteria-range__fill" style={{ left: `${left}%`, right: `${100 - right}%` }} /><input aria-label={`${label} minimum`} type="range" min={min} max={max} step={step} value={lower} onChange={(event) => onLower(Math.min(Number(event.target.value), upper - step))} /><input aria-label={`${label} maximum`} type="range" min={min} max={max} step={step} value={upper} onChange={(event) => onUpper(Math.max(Number(event.target.value), lower + step))} /></div>
      <div className="criteria-range__limits"><span>{min}{unit}</span><span>{max}{unit}</span></div>
    </div>
  );
}

function MapCanvas({ atlas, counts, selectedIndex, hover, view, viewMode, globeLon, showBorders, showCities, onViewChange, onGlobeRotate, onHover, onSelect }: { atlas: AtlasData; counts: Uint16Array; selectedIndex: number | null; hover: HoverState; view: ViewState; viewMode: ViewMode; globeLon: number; showBorders: boolean; showCities: boolean; onViewChange: (next: ViewState) => void; onGlobeRotate: (next: number) => void; onHover: (next: HoverState) => void; onSelect: (index: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapSizeRef = useRef({ width: 0, height: 0 });
  const countriesRef = useRef<CountryFeature[]>([]);
  const [landMask, setLandMask] = useState<Uint8Array | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number; baseGlobeLon: number; moved: boolean } | null>(null);
  const refinedGrid = useMemo(() => refineCounts(counts, atlas.width, atlas.height, DISPLAY_FACTOR), [atlas.height, atlas.width, counts]);
  const validData = useMemo(() => {
    const available = new Uint8Array(atlas.width * atlas.height);
    for (let cell = 0; cell < available.length; cell += 1) {
      const offset = cell * atlas.days;
      for (let day = 0; day < atlas.days; day += 1) {
        if (atlas.tmax[offset + day] !== -32768 && atlas.wind[offset + day] !== 255 && atlas.humidity[offset + day] !== 255 && atlas.cloud[offset + day] !== 255) {
          available[cell] = 1;
          break;
        }
      }
    }
    return available;
  }, [atlas]);

  useEffect(() => {
    fetch('/countries-110m.json').then((response) => response.json()).then((topology: CountryTopology) => {
      countriesRef.current = (feature(topology, topology.objects.countries) as GeoJSON.FeatureCollection<GeoJSON.GeometryObject>).features ?? [];
      setLandMask(createLandMask(countriesRef.current, atlas.width * DISPLAY_FACTOR, atlas.height * DISPLAY_FACTOR));
    }).catch(() => { countriesRef.current = []; setLandMask(null); });
  }, [atlas.height, atlas.width]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = mapSizeRef.current;
    if (!width || !height) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#f6fbf8';
    context.fillRect(0, 0, width, height);
    const maxCount = Math.max(...counts);
    const cellWidth = width / refinedGrid.width;
    const cellHeight = height / refinedGrid.height;
    const sourceCellWidth = width / atlas.width;
    const sourceCellHeight = height / atlas.height;
    const sourceCellForDisplay = (row: number, col: number) => Math.floor(row / DISPLAY_FACTOR) * atlas.width + Math.floor(col / DISPLAY_FACTOR);
    const tileIsLand = (row: number, col: number) => landMask === null || landMask[row * refinedGrid.width + col] === 1;
    const tileHasData = (row: number, col: number) => validData[sourceCellForDisplay(row, col)] === 1;

    const drawMapCopy = () => {
      for (let row = 0; row < refinedGrid.height; row += 1) {
        const latitude = -90 + (row + 0.5) / DISPLAY_FACTOR;
        for (let col = 0; col < refinedGrid.width; col += 1) {
          const index = row * refinedGrid.width + col;
          const hasData = tileHasData(row, col);
          const isLand = tileIsLand(row, col) && latitude > -60;
          context.fillStyle = !isLand ? OCEAN_COLOUR : !hasData ? '#b9c6c2' : colourForCount(refinedGrid.values[index], maxCount);
          context.globalAlpha = 0.95;
          context.fillRect(col * cellWidth, height - (row + 1) * cellHeight, cellWidth + 0.6, cellHeight + 0.6);
        }
      }
      context.globalAlpha = 1;
      if (countriesRef.current.length) {
        context.strokeStyle = showBorders ? 'rgba(55, 74, 81, .62)' : 'rgba(55, 74, 81, .18)';
        context.lineWidth = 0.72 / view.scale;
        context.setLineDash([3 / view.scale, 3 / view.scale]);
        for (const country of countriesRef.current) {
          const geometry = country.geometry;
          if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
          const geometries = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
          for (const polygon of geometries) {
            context.beginPath();
            for (const ring of polygon) traceRing(context, ring, width, height);
            context.stroke();
          }
        }
      }
      context.strokeStyle = EQUATOR_COLOUR;
      context.lineWidth = 1 / view.scale;
      context.setLineDash([5 / view.scale, 5 / view.scale]);
      context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
      if (selectedIndex !== null) {
        const row = Math.floor(selectedIndex / atlas.width);
        const col = selectedIndex % atlas.width;
        context.strokeStyle = '#102a39';
        context.lineWidth = 2 / view.scale;
        context.setLineDash([]);
        context.strokeRect(col * sourceCellWidth + 1 / view.scale, height - (row + 1) * sourceCellHeight + 1 / view.scale, sourceCellWidth - 2 / view.scale, sourceCellHeight - 2 / view.scale);
      }
      if (showCities) {
        context.setLineDash([]);
        context.font = `${Math.max(9, 10 / view.scale)}px ui-sans-serif, system-ui, sans-serif`;
        context.textBaseline = 'middle';
        for (const city of CITIES) {
          const x = ((city.lon + 180) / 360) * width;
          const y = ((90 - city.lat) / 180) * height;
          context.fillStyle = '#112d3c';
          context.beginPath(); context.arc(x, y, 2.3 / view.scale, 0, Math.PI * 2); context.fill();
          context.fillStyle = 'rgba(17, 45, 60, .84)';
          context.fillText(city.name, x + 5 / view.scale, y);
        }
      }
      if (hover) {
        context.strokeStyle = '#fff';
        context.lineWidth = 1.4 / view.scale;
        context.setLineDash([]);
        context.strokeRect(hover.displayCol * cellWidth + 1 / view.scale, height - (hover.displayRow + 1) * cellHeight + 1 / view.scale, cellWidth - 2 / view.scale, cellHeight - 2 / view.scale);
      }
    };

    if (viewMode === 'map') {
      const wrappedX = wrap(view.x, width * view.scale);
      context.save();
      context.translate(wrappedX, view.y);
      context.scale(view.scale, view.scale);
      for (const copy of [-1, 0, 1]) {
        context.save();
        context.translate(copy * width, 0);
        drawMapCopy();
        context.restore();
      }
      context.restore();
      return;
    }

    const radius = Math.min(width, height) * 0.43;
    const centerX = width / 2;
    const centerY = height / 2;
    const projectGlobe = (longitude: number, latitude: number) => {
      const lat = latitude * Math.PI / 180;
      const deltaLon = wrapLongitude(longitude - globeLon) * Math.PI / 180;
      const visible = Math.cos(lat) * Math.cos(deltaLon) > 0;
      return { x: centerX + radius * Math.cos(lat) * Math.sin(deltaLon), y: centerY - radius * Math.sin(lat), visible };
    };
    context.fillStyle = '#dfe8e5';
    context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.fill();
    context.save();
    context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.clip();
    const globeTileSize = Math.max(1, radius * Math.PI / 180 * 1.15);
    for (let row = 0; row < refinedGrid.height; row += 1) {
      const latitude = -90 + (row + 0.5) / DISPLAY_FACTOR;
      for (let col = 0; col < refinedGrid.width; col += 1) {
        const longitude = -180 + (col + 0.5) / DISPLAY_FACTOR;
        const point = projectGlobe(longitude, latitude);
        if (!point.visible) continue;
        const index = row * refinedGrid.width + col;
        const isLand = tileIsLand(row, col) && latitude > -60;
        context.fillStyle = !isLand ? OCEAN_COLOUR : !tileHasData(row, col) ? '#b9c6c2' : colourForCount(refinedGrid.values[index], maxCount);
        context.globalAlpha = 0.95;
        context.fillRect(point.x - globeTileSize / 2, point.y - globeTileSize / 2, globeTileSize + 0.5, globeTileSize + 0.5);
      }
    }
    context.globalAlpha = 1;
    context.strokeStyle = EQUATOR_COLOUR;
    context.lineWidth = 1;
    context.setLineDash([5, 5]);
    context.beginPath(); context.moveTo(centerX - radius, centerY); context.lineTo(centerX + radius, centerY); context.stroke();
    if (showCities) {
      context.setLineDash([]);
      context.font = '10px ui-sans-serif, system-ui, sans-serif';
      context.textBaseline = 'middle';
      for (const city of CITIES) {
        const point = projectGlobe(city.lon, city.lat);
        if (!point.visible) continue;
        context.fillStyle = '#112d3c';
        context.beginPath(); context.arc(point.x, point.y, 2.3, 0, Math.PI * 2); context.fill();
        context.fillStyle = 'rgba(17, 45, 60, .84)';
        context.fillText(city.name, point.x + 5, point.y);
      }
    }
    if (hover) {
      const point = projectGlobe(hover.lon, hover.lat);
      if (point.visible) { context.strokeStyle = '#fff'; context.lineWidth = 1.4; context.setLineDash([]); context.strokeRect(point.x - globeTileSize / 2, point.y - globeTileSize / 2, globeTileSize, globeTileSize); }
    }
    context.restore();
    context.strokeStyle = 'rgba(35, 78, 84, .45)';
    context.lineWidth = 1.4;
    context.setLineDash([]);
    context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.stroke();
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;
    const resize = () => { const rect = parent.getBoundingClientRect(); mapSizeRef.current = { width: rect.width, height: rect.height }; const dpr = window.devicePixelRatio || 1; canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`; draw(); };
    const observer = new ResizeObserver(resize); observer.observe(parent); resize(); return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { draw(); }, [atlas, counts, selectedIndex, hover, view, viewMode, globeLon, showBorders, showCities, landMask, validData]);

  function cellFromPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { width, height } = mapSizeRef.current;
    const displayFactor = refinedGrid.width / atlas.width;
    let displayCol: number;
    let displayRow: number;
    let lat: number;
    let lon: number;
    if (viewMode === 'globe') {
      const radius = Math.min(width, height) * 0.43 * view.scale;
      const normalizedX = (clientX - rect.left - width / 2) / radius;
      const normalizedY = (clientY - rect.top - height / 2) / radius;
      const depth = 1 - normalizedX * normalizedX - normalizedY * normalizedY;
      if (depth < 0) return null;
      lat = Math.asin(clamp(-normalizedY, -1, 1)) * 180 / Math.PI;
      lon = wrapLongitude(globeLon + Math.atan2(normalizedX, Math.sqrt(depth)) * 180 / Math.PI);
      displayCol = Math.min(refinedGrid.width - 1, Math.floor(((lon + 180) / 360) * refinedGrid.width));
      displayRow = Math.min(refinedGrid.height - 1, Math.floor(((lat + 90) / 180) * refinedGrid.height));
    } else {
      const wrappedX = wrap(view.x, width * view.scale);
      const x = (clientX - rect.left - wrappedX) / view.scale;
      const y = (clientY - rect.top - view.y) / view.scale;
      if (y < 0 || y >= height) return null;
      const normalizedX = wrap(x, width);
      displayCol = Math.min(refinedGrid.width - 1, Math.floor((normalizedX / width) * refinedGrid.width));
      const displayRowFromTop = Math.floor((y / height) * refinedGrid.height);
      if (displayRowFromTop < 0 || displayRowFromTop >= refinedGrid.height) return null;
      displayRow = refinedGrid.height - displayRowFromTop - 1;
      lat = -90 + (displayRow + 0.5) / displayFactor;
      lon = -180 + (displayCol + 0.5) / displayFactor;
    }
    const col = Math.min(atlas.width - 1, Math.floor(displayCol / displayFactor));
    const row = Math.min(atlas.height - 1, Math.floor(displayRow / displayFactor));
    return { index: row * atlas.width + col, displayCol, displayRow, lat, lon, localX: clientX - rect.left, localY: clientY - rect.top };
  }

  return <canvas ref={canvasRef} className="map-canvas" aria-label="Interactive global perfect weather heat map" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: view.x, baseY: view.y, baseGlobeLon: globeLon, moved: false }; }} onPointerMove={(event) => { const drag = dragRef.current; if (drag) { const dx = event.clientX - drag.startX; const dy = event.clientY - drag.startY; drag.moved = drag.moved || Math.abs(dx) + Math.abs(dy) > 4; if (viewMode === 'globe') onGlobeRotate(wrapLongitude(drag.baseGlobeLon - dx * 0.45)); else onViewChange({ ...view, x: drag.baseX + dx, y: drag.baseY + dy }); return; } const point = cellFromPoint(event.clientX, event.clientY); onHover(point ? { index: point.index, displayCol: point.displayCol, displayRow: point.displayRow, lat: point.lat, lon: point.lon, x: point.localX, y: point.localY } : null); }} onPointerUp={(event) => { const drag = dragRef.current; dragRef.current = null; const point = cellFromPoint(event.clientX, event.clientY); if (drag && !drag.moved && point) onSelect(point.index); }} onPointerLeave={() => { if (!dragRef.current) onHover(null); }} onWheel={(event) => { event.preventDefault(); const factor = event.deltaY < 0 ? 1.12 : 0.89; const nextScale = clamp(view.scale * factor, 0.82, 4.8); const rect = canvasRef.current?.getBoundingClientRect(); if (!rect) return; const px = event.clientX - rect.left; const py = event.clientY - rect.top; if (viewMode === 'globe') onViewChange({ ...view, scale: nextScale }); else { const wrappedX = wrap(view.x, width * view.scale); onViewChange({ scale: nextScale, x: px - ((px - wrappedX) / view.scale) * nextScale, y: py - ((py - view.y) / view.scale) * nextScale }); } }} />;
}

export default function Home() {
  const [atlas, setAtlas] = useState<AtlasData>(() => createFallbackAtlas());
  const [dataStatus, setDataStatus] = useState<'loading' | 'live' | 'preview'>('loading');
  const [criteria, setCriteria] = useState<Criteria>(DEFAULT_CRITERIA);
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [viewMode, setViewMode] = useState<ViewMode>('map');
  const [globeLon, setGlobeLon] = useState(0);
  const [hover, setHover] = useState<HoverState>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showBorders, setShowBorders] = useState(true);
  const [showCities, setShowCities] = useState(true);
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);

  useEffect(() => { loadAtlas().then((loaded) => { setAtlas(loaded); setDataStatus('live'); }).catch(() => setDataStatus('preview')); }, []);

  const monthMap = useMemo(() => createMonthMap(atlas.year), [atlas.year]);
  const selectedDayCount = useMemo(() => monthMap.filter((month) => month >= criteria.monthStart && month <= criteria.monthEnd).length, [criteria.monthStart, criteria.monthEnd, monthMap]);
  const counts = useMemo(() => {
    const result = new Uint16Array(atlas.width * atlas.height);
    for (let cell = 0; cell < result.length; cell += 1) {
      let count = 0;
      const offset = cell * atlas.days;
      for (let day = 0; day < atlas.days; day += 1) {
        if (monthMap[day] < criteria.monthStart || monthMap[day] > criteria.monthEnd) continue;
        const temp = atlas.tmax[offset + day] / 10;
        const wind = atlas.wind[offset + day] / 10;
        const rh = atlas.humidity[offset + day];
        const cloud = atlas.cloud[offset + day];
        if (atlas.tmax[offset + day] === -32768 || atlas.wind[offset + day] === 255 || rh === 255 || cloud === 255) continue;
        const dew = dewPoint(temp, rh);
        if (temp >= criteria.tempMin && temp <= criteria.tempMax && dew >= criteria.dewMin && dew <= criteria.dewMax && wind <= criteria.windMax && cloud <= criteria.cloudMax) count += 1;
      }
      result[cell] = count;
    }
    return result;
  }, [atlas, criteria, monthMap]);

  const selected = selectedIndex === null ? null : { index: selectedIndex, row: Math.floor(selectedIndex / atlas.width), col: selectedIndex % atlas.width };
  const hovered = hover ? { index: hover.index } : null;
  const selectedCity = selected ? CITIES.find((city) => Math.abs(city.lat - atlas.lats[selected.row]) < 3 && Math.abs(city.lon - atlas.lons[selected.col]) < 3) : null;
  const selectedLabel = selectedCity?.name ?? (selected ? `${atlas.lats[selected.row].toFixed(1)}°, ${atlas.lons[selected.col].toFixed(1)}°` : 'Select a place');
  const hoveredCount = hovered ? counts[hovered.index] : null;
  const selectedCount = selected ? counts[selected.index] : null;
  const hoverSummary = useMemo<HoverSummary | null>(() => {
    if (!hover) return null;
    const offset = hover.index * atlas.days;
    let observed = 0;
    let tempTotal = 0;
    let dewTotal = 0;
    let windTotal = 0;
    let cloudTotal = 0;
    let tempDays = 0;
    let dewDays = 0;
    let windDays = 0;
    let cloudDays = 0;
    for (let day = 0; day < atlas.days; day += 1) {
      if (monthMap[day] < criteria.monthStart || monthMap[day] > criteria.monthEnd) continue;
      const rawTemp = atlas.tmax[offset + day];
      const rawWind = atlas.wind[offset + day];
      const rawHumidity = atlas.humidity[offset + day];
      const rawCloud = atlas.cloud[offset + day];
      if (rawTemp === -32768 || rawWind === 255 || rawHumidity === 255 || rawCloud === 255) continue;
      const temp = rawTemp / 10;
      const wind = rawWind / 10;
      const cloud = rawCloud;
      const dew = dewPoint(temp, rawHumidity);
      observed += 1;
      tempTotal += temp;
      dewTotal += dew;
      windTotal += wind;
      cloudTotal += cloud;
      if (temp >= criteria.tempMin && temp <= criteria.tempMax) tempDays += 1;
      if (dew >= criteria.dewMin && dew <= criteria.dewMax) dewDays += 1;
      if (wind <= criteria.windMax) windDays += 1;
      if (cloud <= criteria.cloudMax) cloudDays += 1;
    }
    if (!observed) return null;
    return { temp: tempTotal / observed, dew: dewTotal / observed, wind: windTotal / observed, cloud: cloudTotal / observed, tempDays, dewDays, windDays, cloudDays };
  }, [atlas, criteria.cloudMax, criteria.dewMax, criteria.dewMin, criteria.monthEnd, criteria.monthStart, criteria.tempMax, criteria.tempMin, criteria.windMax, hover, monthMap]);
  const bestCells = useMemo(() => Array.from(counts.keys()).sort((a, b) => counts[b] - counts[a]).slice(0, 3), [counts]);
  const monthLeft = ((criteria.monthStart - 1) / 11) * 100;
  const monthRight = ((criteria.monthEnd - 1) / 11) * 100;

  function updateCriteria(key: keyof Criteria, value: number) { setCriteria((current) => ({ ...current, [key]: value })); }
  function reset() { setCriteria(DEFAULT_CRITERIA); setView({ scale: 1, x: 0, y: 0 }); setGlobeLon(0); setSelectedIndex(null); setHover(null); }
  const criteriaText = `Highs ${criteria.tempMin}–${criteria.tempMax} °C · Dew point ${criteria.dewMin}–${criteria.dewMax} °C · Light winds ≤ ${criteria.windMax} m/s · Cloud cover ≤ ${criteria.cloudMax}%`;

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand-lockup"><span className="brand-mark"><span /></span><span>Perfect Weather</span></div><div className="topbar-center"><span className="eyebrow">Global climate atlas</span><span className="data-status"><i className={dataStatus === 'live' ? 'is-live' : ''} /> {dataStatus === 'live' ? 'ERA5 data loaded' : dataStatus === 'preview' ? 'Local climate preview' : 'Loading climate grid'}</span></div><button className="topbar-button" onClick={() => setMobileControlsOpen((open) => !open)} aria-expanded={mobileControlsOpen}>Criteria <span className="sliders-icon">☷</span></button></header>
      <div className="app-grid">
        <aside className={`control-panel ${mobileControlsOpen ? 'is-open' : ''}`}>
          <div className="panel-heading"><div><span className="eyebrow">Your personal forecast</span><h1>Perfect weather</h1></div><button className="reset-button" onClick={reset}>Reset</button></div>
          <p className="panel-intro">Tune the day you would choose. Every cell recalculates across the selected part of the year.</p>
          <div className="criteria-section"><div className="section-label"><span>Climate criteria</span><span className="section-number">01</span></div><CriteriaRange label="High temperature" min={0} max={40} lower={criteria.tempMin} upper={criteria.tempMax} step={1} unit="°C" onLower={(value) => updateCriteria('tempMin', value)} onUpper={(value) => updateCriteria('tempMax', value)} /><CriteriaRange label="Dew point" min={-4} max={26} lower={criteria.dewMin} upper={criteria.dewMax} step={1} unit="°C" onLower={(value) => updateCriteria('dewMin', value)} onUpper={(value) => updateCriteria('dewMax', value)} /><div className="single-criterion"><div className="criteria-range__heading"><span>Wind speed maximum</span><strong>{criteria.windMax.toFixed(1)} m/s</strong></div><input aria-label="Wind speed maximum" className="single-slider" type="range" min="1" max="12" step="0.5" value={criteria.windMax} onChange={(event) => updateCriteria('windMax', Number(event.target.value))} /><div className="criteria-range__limits"><span>still</span><span>12 m/s</span></div></div><div className="single-criterion"><div className="criteria-range__heading"><span>Cloud cover maximum</span><strong>{criteria.cloudMax}%</strong></div><input aria-label="Cloud cover maximum" className="single-slider" type="range" min="10" max="100" step="5" value={criteria.cloudMax} onChange={(event) => updateCriteria('cloudMax', Number(event.target.value))} /><div className="criteria-range__limits"><span>clear</span><span>overcast</span></div></div></div>
          <div className="criteria-section season-section"><div className="section-label"><span>Time of year</span><span className="section-number">02</span></div><div className="criteria-range__heading"><span>Include months</span><strong>{MONTHS[criteria.monthStart - 1]}–{MONTHS[criteria.monthEnd - 1]}</strong></div><div className="criteria-range__track month-range__track"><span className="criteria-range__fill" style={{ left: `${monthLeft}%`, right: `${100 - monthRight}%` }} /><input aria-label="First month" type="range" min="1" max="12" step="1" value={criteria.monthStart} onChange={(event) => updateCriteria('monthStart', Math.min(Number(event.target.value), criteria.monthEnd))} /><input aria-label="Last month" type="range" min="1" max="12" step="1" value={criteria.monthEnd} onChange={(event) => updateCriteria('monthEnd', Math.max(Number(event.target.value), criteria.monthStart))} /></div><div className="criteria-range__limits"><span>Jan</span><span>Dec</span></div><div className="month-pills">{MONTHS.map((month, index) => <button key={month} className={index + 1 >= criteria.monthStart && index + 1 <= criteria.monthEnd ? 'is-selected' : ''} onClick={() => { const monthValue = index + 1; setCriteria((current) => monthValue < current.monthStart ? { ...current, monthStart: monthValue } : monthValue > current.monthEnd ? { ...current, monthEnd: monthValue } : { ...current, monthStart: monthValue, monthEnd: monthValue }); }}>{month}</button>)}</div><div className="criteria-range__limits"><span>{selectedDayCount} days in view</span><span>{atlas.year} baseline</span></div></div>
          <div className="criteria-section layers-section"><div className="section-label"><span>Map layers</span><span className="section-number">03</span></div><label className="toggle-row"><span><i className="layer-dot layer-dot--cities" /> Key cities</span><input type="checkbox" checked={showCities} onChange={(event) => setShowCities(event.target.checked)} /><b /></label><label className="toggle-row"><span><i className="layer-dot layer-dot--borders" /> Country outlines</span><input type="checkbox" checked={showBorders} onChange={(event) => setShowBorders(event.target.checked)} /><b /></label></div>
          <div className="data-note"><span className="data-note__icon">↗</span><p><strong>How this is calculated</strong><br />Daily ERA5 reanalysis from Open-Meteo, sampled on a 5° global grid. Dew point is derived from temperature and relative humidity.</p></div>
        </aside>
        <section className="map-panel"><div className="map-heading"><div><span className="eyebrow">Days per year · {atlas.year}</span><h2>Annual number of perfect weather days</h2><p>{criteriaText}</p></div><div className="map-heading__actions"><div className="view-mode-toggle" role="group" aria-label="Map view"><button className={viewMode === 'map' ? 'is-active' : ''} onClick={() => { setViewMode('map'); setHover(null); }}>Map</button><button className={viewMode === 'globe' ? 'is-active' : ''} onClick={() => { setViewMode('globe'); setHover(null); }}>Globe</button></div><span className="view-label">{viewMode === 'map' ? 'Drag · scroll to zoom · wraps endlessly' : 'Drag to rotate · scroll to zoom'}</span><button className="icon-button" aria-label="Reset map view" onClick={() => { setView({ scale: 1, x: 0, y: 0 }); setGlobeLon(0); }}>⌂</button></div></div><div className={`map-frame map-frame--${viewMode}`}><MapCanvas atlas={atlas} counts={counts} selectedIndex={selectedIndex} hover={hover} view={view} viewMode={viewMode} globeLon={globeLon} showBorders={showBorders} showCities={showCities} onViewChange={setView} onGlobeRotate={setGlobeLon} onHover={setHover} onSelect={setSelectedIndex} /><div className="map-attribution">Source: Open-Meteo / ERA5 · 5° source · 1° display tiles · {atlas.year}</div><div className="map-zoom"><button aria-label="Zoom in" onClick={() => setView((current) => ({ ...current, scale: clamp(current.scale * 1.25, 0.82, 4.8) }))}>+</button><button aria-label="Zoom out" onClick={() => setView((current) => ({ ...current, scale: clamp(current.scale * 0.8, 0.82, 4.8) }))}>−</button></div>{hover && hovered && <div className="map-tooltip map-tooltip--wide" style={{ left: clamp(hover.x + 14, 12, 9999), top: clamp(hover.y + 14, 12, 9999) }}><div className="map-tooltip__top"><span>{hover.lat.toFixed(1)}°, {hover.lon.toFixed(1)}°</span><strong>{hoveredCount} perfect days</strong></div>{hoverSummary && <div className="map-tooltip__metrics"><span><small>High temp</small><b>{hoverSummary.temp.toFixed(1)}°C · {hoverSummary.tempDays}d</b></span><span><small>Dew point</small><b>{hoverSummary.dew.toFixed(1)}°C · {hoverSummary.dewDays}d</b></span><span><small>Wind speed</small><b>{hoverSummary.wind.toFixed(1)} m/s · {hoverSummary.windDays}d</b></span><span><small>Cloud cover</small><b>{hoverSummary.cloud.toFixed(0)}% · {hoverSummary.cloudDays}d</b></span></div>}<em>Average value · passing days in selected months</em></div>}</div><div className="map-footer"><div className="legend"><span>0</span><div className="legend-ramp">{PALETTE.map((colour) => <i key={colour} style={{ background: colour }} />)}</div><span>{selectedDayCount}</span><em>perfect days</em></div><div className="map-footer__hint"><span className="drag-icon">✣</span> Heat map updates as you tune the criteria</div></div></section>
        <aside className="insight-panel"><div className="insight-card insight-card--selected"><span className="eyebrow">Selected place</span><h3>{selectedLabel}</h3>{selectedCount !== null ? <><div className="big-number">{selectedCount}<small> / {selectedDayCount}</small></div><p>days match your definition of perfect.</p><div className="insight-meter"><span style={{ width: `${(selectedCount / Math.max(1, selectedDayCount)) * 100}%` }} /></div></> : <p className="empty-copy">Click anywhere on the map to inspect a grid cell or a nearby city.</p>}</div><div className="insight-card"><div className="card-heading"><span className="eyebrow">Most promising cells</span><span className="spark">↗</span></div>{bestCells.map((index) => { const row = Math.floor(index / atlas.width); const col = index % atlas.width; return <button className="rank-row" key={index} onClick={() => setSelectedIndex(index)}><span className="rank">0{bestCells.indexOf(index) + 1}</span><span><strong>{atlas.lats[row].toFixed(1)}°, {atlas.lons[col].toFixed(1)}°</strong><small>{counts[index]} perfect days</small></span><b>→</b></button>; })}</div><div className="insight-card insight-card--source"><span className="eyebrow">Dataset</span><div className="source-row"><span className="source-logo">ERA5</span><span><strong>Global daily reanalysis</strong><small>{dataStatus === 'live' ? 'Connected to the local downloaded atlas' : dataStatus === 'preview' ? 'Preview mode · importer included in the project' : 'Loading the downloaded atlas'}</small></span></div><a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noreferrer">Read the data notes ↗</a></div></aside>
      </div>
    </main>
  );
}
