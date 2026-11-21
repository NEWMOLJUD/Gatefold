// Cron expressions are matched by the engine itself: one every-minute tick
// (a Cloudflare Cron Trigger, or the local runner) drives every job.

export interface Job {
  expression: string;
  matches: (time: Date) => boolean;
  handler: (time: Date) => void | Promise<void>;
}

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
}

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { name: "day of week", min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];

/** Parse a 5-field cron expression into a matcher on UTC time. Throws on bad input. */
export function parseCron(expression: string): (time: Date) => boolean {
  const fail = (why: string): never => {
    throw new TypeError(
      `cron.schedule: invalid expression ${JSON.stringify(expression)}: ${why}. ` +
        `Expected five fields: minute hour day-of-month month day-of-week, for example "0 3 * * *".`,
    );
  };
  if (typeof expression !== "string") fail("it must be a string");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) fail(`it has ${parts.length} field${parts.length === 1 ? "" : "s"}`);

  const sets = FIELDS.map((field, index) => parseField(parts[index]!, field, fail));
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.has(7)) weekdays.add(0);
  const anyDay = parts[2] === "*";
  const anyWeekday = parts[4] === "*";

  return (time) => {
    if (!minutes.has(time.getUTCMinutes()) || !hours.has(time.getUTCHours())) return false;
    if (!months.has(time.getUTCMonth() + 1)) return false;
    const day = days.has(time.getUTCDate());
    const weekday = weekdays.has(time.getUTCDay());
    // Standard cron: when both day fields are restricted, either one may match.
    if (!anyDay && !anyWeekday) return day || weekday;
    return day && weekday;
  };
}

function parseField(text: string, field: Field, fail: (why: string) => never): Set<number> {
  const values = new Set<number>();
  const number = (raw: string): number => {
    const named = field.names?.indexOf(raw.toLowerCase()) ?? -1;
    const value = named >= 0 ? named + (field.name === "month" ? 1 : 0) : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return fail(`"${raw}" is not a valid ${field.name} (${field.min}-${field.max})`);
    }
    return value;
  };
  for (const item of text.split(",")) {
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined || range === "") fail(`cannot read "${item}" in the ${field.name} field`);
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) fail(`"${item}" has an invalid step`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.name === "day of week" ? 6 : field.max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      from = number(a);
      to = number(b);
      if (from > to) fail(`"${range}" goes backwards`);
    } else {
      from = number(range);
      to = stepText === undefined ? from : field.name === "day of week" ? 6 : field.max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}
