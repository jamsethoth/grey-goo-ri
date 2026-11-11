// The JSON gg saves: its type, and the one function every save path serializes through (#342). tsc refuses a value
// whose type could hold what JSON cannot, and the same call refuses such a value at run time, naming the path to it.

// A value JSON.parse gives: what configuration, a Structured Response and a Harness's output are.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// stub
export type JsonChecked<Value> = Value;

// stub
export function assertJson(value: unknown, what: string): void {
  void [value, what];
}

// stub
export function text<Value>(value: Value & JsonChecked<Value>, what: string, space?: number): string {
  void [value, what, space];
  return '';
}
