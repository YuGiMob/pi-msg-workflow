function formatConsoleArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return String(value);
  if (typeof value === "object" && value !== null) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized !== undefined) return serialized;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function captureConsoleMessages(onMessage: (text: string) => void): () => void {
  const names = ["error", "warn"] as const;
  const originals = names.map((name) => console[name]);
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const original = originals[i]!;
    console[name] = (...args: unknown[]) => {
      original.apply(console, args);
      const text = args.map(formatConsoleArg).join(" ");
      if (text !== "") onMessage(text);
    };
  }
  return () => {
    for (let i = 0; i < names.length; i++) {
      console[names[i]!] = originals[i]!;
    }
  };
}
