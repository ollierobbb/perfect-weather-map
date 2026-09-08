import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2] ?? '/tmp/cities500.txt';
const outputPath = new URL('../public/capitals.json', import.meta.url);
const rows = (await readFile(inputPath, 'utf8')).split('\n');
const capitals = [];

for (const row of rows) {
  if (!row || row.startsWith('#')) continue;
  const fields = row.split('\t');
  if (fields[7] !== 'PPLC') continue;
  const latitude = Number(fields[4]);
  const longitude = Number(fields[5]);
  const population = Number(fields[14]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  capitals.push({
    name: fields[1],
    country: fields[8],
    lat: Number(latitude.toFixed(4)),
    lon: Number(longitude.toFixed(4)),
    population: Number.isFinite(population) ? population : 0,
  });
}

capitals.sort((a, b) => a.country.localeCompare(b.country));
await writeFile(outputPath, `${JSON.stringify(capitals)}\n`);
console.log(`Wrote ${capitals.length} country capitals to ${outputPath.pathname}`);
