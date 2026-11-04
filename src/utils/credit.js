// Optional developer credit line shown at the top of the status cards, configured with
// `developerCredit` in config.json (e.g. "DEVELOPED BY @HANDLE").
import { config } from '../config.js';

export function developerCreditLine() {
  const credit = String(config.developerCredit ?? '').trim();
  return credit ? `***${credit}***` : null;
}
