import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [percentageValue, outputPath] = process.argv.slice(2);
const percentage = Number(percentageValue);

if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
  throw new Error("Invalid coverage percentage: " + percentageValue);
}

if (!outputPath) {
  throw new Error("An output path is required.");
}

const roundedPercentage = Math.round(percentage);
const color = roundedPercentage >= 90
  ? "#4c1"
  : roundedPercentage >= 80
    ? "#97ca00"
    : roundedPercentage >= 70
      ? "#a4a61d"
      : roundedPercentage >= 60
        ? "#dfb317"
        : roundedPercentage >= 50
          ? "#fe7d37"
          : "#e05d44";
const message = String(roundedPercentage) + "%";
const svg = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="116" height="20" role="img" aria-label="coverage: ' + message + '">',
  '  <linearGradient id="s" x2="0" y2="100%">',
  '    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
  '    <stop offset="1" stop-opacity=".1"/>',
  '  </linearGradient>',
  '  <clipPath id="r"><rect width="116" height="20" rx="3" fill="#fff"/></clipPath>',
  '  <g clip-path="url(#r)">',
  '    <rect width="70" height="20" fill="#555"/>',
  '    <rect x="70" width="46" height="20" fill="' + color + '"/>',
  '    <rect width="116" height="20" fill="url(#s)"/>',
  '  </g>',
  '  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
  '    <text x="35" y="15" fill="#010101" fill-opacity=".3">coverage</text>',
  '    <text x="35" y="14">coverage</text>',
  '    <text x="92" y="15" fill="#010101" fill-opacity=".3">' + message + '</text>',
  '    <text x="92" y="14">' + message + '</text>',
  '  </g>',
  '</svg>',
].join("\n") + "\n";

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, svg);
