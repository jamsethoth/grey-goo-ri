// In a configuration file null is never a value, where a missing key is optional or required (#298). The validator
// reports every null first, and each check reports those under the value it judges too, so a null refuses that value
// like any other error there; the report merges the two (#454, Q3 A).

import * as referencePaths from '../reference-paths.ts';
import * as report from './report.ts';

// Every null under `value`, reported at its path.
export function reportNulls(problems: report.Report, value: unknown, location: string): void {
  if (value === null) {
    report.error(
      problems,
      location,
      'null-value',
      'null is not a value in a configuration file; set a value or leave the key out',
    );
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => reportNulls(problems, item, `${location}[${index}]`));
  } else if (referencePaths.isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      reportNulls(problems, entry, location === '' ? key : `${location}.${key}`);
  }
}
