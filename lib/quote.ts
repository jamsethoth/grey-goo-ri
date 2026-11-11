// A configuration or response value quoted in a message, as JSON. Such a value comes from JSON.parse, so it holds no
// Map; this is the one module gg/no-map-to-json lets stringify a value typed unknown (#330).
export const json = (value: unknown): string => JSON.stringify(value);
