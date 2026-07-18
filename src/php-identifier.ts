export function toClassName(name: string): string {
  const className = name
    .split(/[._\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  return /^[0-9]/.test(className) ? `_${className}` : className;
}

export function toPropertyName(name: string): string {
  const className = toClassName(name);

  return className.charAt(0).toLowerCase() + className.slice(1);
}

export function toPhpNamespaceSegment(name: string): string {
  return toClassName(name.replace(/[^A-Za-z0-9]+/g, "_"));
}
