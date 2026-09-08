import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2] ?? '/tmp/cities500.txt';
const outputPath = new URL('../public/cities-1m.json', import.meta.url);
const minimumPopulation = 1_000_000;
const rows = (await readFile(inputPath, 'utf8')).split('\n');
const cities = [];

for (const row of rows) {
  if (!row || row.startsWith('#')) continue;
  const fields = row.split('\t');
  const population = Number(fields[14]);
  if (!Number.isFinite(population) || population < minimumPopulation) continue;
  const latitude = Number(fields[4]);
  const longitude = Number(fields[5]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  cities.push({
    name: fields[1],
    country: fields[8],
    lat: Number(latitude.toFixed(4)),
    lon: Number(longitude.toFixed(4)),
    population,
  });
}

cities.sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
await writeFile(outputPath, `${JSON.stringify(cities)}\n`);
console.log(`Wrote ${cities.length} cities with population >= ${minimumPopulation.toLocaleString()} to ${outputPath.pathname}`);
