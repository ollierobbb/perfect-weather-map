import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2] ?? '/tmp/cities500.txt';
const outputPath = new URL('../public/capitals.json', import.meta.url);
const SOVEREIGN_COUNTRY_CODES = new Set('AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW'.split(' '));
const rows = (await readFile(inputPath, 'utf8')).split('\n');
const capitals = [];

for (const row of rows) {
  if (!row || row.startsWith('#')) continue;
  const fields = row.split('\t');
  if (fields[7] !== 'PPLC' || !SOVEREIGN_COUNTRY_CODES.has(fields[8])) continue;
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
