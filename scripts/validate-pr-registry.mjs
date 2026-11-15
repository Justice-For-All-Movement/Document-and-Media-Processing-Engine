import {readFile} from 'node:fs/promises';
import {parsePrRegistry} from '../registry/pr-contract.mjs';
const body = await readFile(new URL('../registry/prs.json', import.meta.url), 'utf8');
const recorded = JSON.parse(body).repository;
// The register is a historical record written under the repository's original owner. The repository was transferred;
// the only other identity accepted is the named successor below (GitHub names compare case-insensitively).
const SUCCESSORS = {
  'neophilism/Document-and-Media-Processing-Engine': ['Justice-For-All-Movement/Document-and-Media-Processing-Engine'],
};
const current = process.env.GITHUB_REPOSITORY || recorded;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
if (!same(current, recorded) && !(SUCCESSORS[recorded] ?? []).some(name => same(name, current)))
  throw new Error(`PR registry belongs to ${recorded}; it cannot be validated as ${current}`);
// The document itself is validated strictly against the identity it records, including every PR URL.
const {document} = parsePrRegistry(body, recorded);
const retired = JSON.parse(await readFile(new URL('../registry/roadmap.json', import.meta.url), 'utf8'));
if (retired.repository !== recorded || retired.deprecated !== true || retired.redirectTo !== 'registry/prs.json' ||
    Object.hasOwn(retired, 'milestones') || Object.hasOwn(retired, 'units') || Object.hasOwn(retired, 'plannedPrCount'))
  throw new Error('Only registry/prs.json may contain the active PR plan');
console.log(`Valid PR registry: recorded as ${recorded}, checked in ${current}, ${document.units.length} approved units; runtime acceptance is separate.`);
