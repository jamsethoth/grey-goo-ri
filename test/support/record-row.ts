// The records row lib/record.ts saves for a record without its commonDir, Maps as objects: a test's golden row, or a
// row it writes behind the module's back.
export const json = (data: object): string =>
  `${JSON.stringify(data, (_key, value: unknown) => (value instanceof Map ? Object.fromEntries(value) : value), 2)}\n`;
